# SmartTodo Phase 4: The Factory

Automate the workflow from Phases 0 to 3 so the next feature goes from issue to merged pull request through the same gates, with the learner as the reviewer. Read [`PLAN.md`](./PLAN.md) first. This phase must not weaken any gate in [Quality Gates](./PLAN.md#quality-gates).

README prompts use the exact section names in this document as stable references. If a section is renamed, update its README references in the same change.

```text
issue ─► cloud agent (tdd-builder + skills + setup steps)
      ─► red commit ─► green commits
      ─► CI gates (api, ios, infra) ─► Copilot code review ─► human review
      ─► auto-merge ─► optional release pipeline ─► deployed verifier
```

## Definition of Done

`setup.mjs` created a starter `.github/copilot-instructions.md` in Phase 0 with the map, the workflow, the protected files, and the rules for every session. Copilot CLI, the Copilot app, Copilot code review, and the Copilot cloud agent all read it. Add a `## Definition of Done` section to it, and keep the whole file under 80 lines:

- **Gates:** which commands from [Quality Gates](./PLAN.md#quality-gates) can run on Linux. The `ios` CI check is the only gate for Swift changes made on Linux, and the work isn't done until it passes.
- **Reviews:** follow the Review Triage section of `journeys/smart-todo/PLAN.md`: one round, fixes in one push. Never enable auto-merge before the Copilot review has posted.
- **Protected tests:** the cloud agent has no red tags, so the hook doesn't freeze its tests. Never change tests from an earlier red commit without calling it out in the pull request description.
- **Records:** file out-of-scope findings as GitHub issues labeled `known-limitation`.
- **Azure:** after Phase 3, a change to `src/api` or `infra` isn't done until the Verify Before Merge section of `journeys/smart-todo/PLAN.md` passes.

## Cloud Agent Environment

The Copilot cloud agent works in an ephemeral GitHub Actions environment. Create `.github/workflows/copilot-setup-steps.yml` so that environment can run the Linux gates before the agent starts:

- Trigger on `workflow_dispatch`, and on `push` and `pull_request` that change this workflow file, so changes to it are validated.
- One job, named exactly `copilot-setup-steps`, on `ubuntu-latest`, with `permissions: contents: read` and `timeout-minutes: 30`.
- Steps: check out the repository; set up Node.js LTS with npm caching keyed on `journeys/smart-todo/src/api/package-lock.json`; run `npm ci` in `journeys/smart-todo/src/api`; copy `local.settings.example.json` to `local.settings.json` there; install Azure Functions Core Tools v4 globally with npm.
- No secrets and no Azure sign-in. The cloud agent runs `npm run check` and the local verifier. The `ios` CI job covers the macOS gate.
- **The cloud agent can't build Swift.** Its environment is Linux, so it can't run Xcode. For any Swift change, the agent must push, wait for the `ios` check, read its log, and fix failures before calling the work done. Put this rule in `.github/copilot-instructions.md`.
- **Let workflows run without approval.** By default, GitHub waits for a person to approve Actions runs on the cloud agent's pull requests, and the agent usually ends its session before that, so it never sees whether `ios` passed. In the repository's settings, open **Copilot** → **Cloud agent** and turn off **Require approval for workflow runs**. This is safe here because `ci.yml` uses no secrets, and `release.yml` runs only on `main` after a merge.

Validate it by running the workflow manually and confirming that it succeeds.

## Feature Issue: Due Dates

Create an issue titled `Add due dates to todos` with this body, then assign it to Copilot and select the `tdd-builder` agent. As a cloud agent, `tdd-builder` runs its full cycle: plan, red, and green in one pull request.

**Goal:** Let a user set an optional due date on a todo, and use it to make generated steps fit the timeline.

**Acceptance criteria:**

- [ ] `PLAN-phase1-api.md` and `PLAN-phase2-ios.md` are updated first to describe the field and its behavior.
- [ ] API: `Todo` has an optional `dueDate` (a `YYYY-MM-DD` string or `null`). `POST /api/todos` and `PATCH /api/todos/:id` accept it, a body containing only `dueDate` is a valid `PATCH`, `GET` returns it, and an invalid format or impossible date returns 400 `VALIDATION_ERROR`. Valid years are 0001–9999, matching SQL `DATE` (JavaScript accepts year 0000, so reject it explicitly), and returned values always use a four-digit year.
- [ ] Data: The memory store supports `dueDate`. The Azure SQL store uses a `dueDate DATE NULL` column and returns it as a `YYYY-MM-DD` string or `null` (covered by the repository contract suite). A new entry at the end of `src/data/migrations.ts` adds the column with `IF COL_LENGTH('Todos', 'dueDate') IS NULL ALTER TABLE Todos ADD dueDate DATE NULL`. The SQL store binds `dueDate` as a JavaScript `Date` for its `DATE` parameter, covered by a boundary test.
- [ ] AI: When `dueDate` is set, the Foundry generator includes it in the user prompt so steps fit before that date. The fake generator is unchanged.
- [ ] iOS: Keep `APIClientProtocol` source-compatible, so existing test doubles still compile: add the due-date variants with default implementations in a protocol extension instead of changing existing method signatures. Parse and format date-only values in the device's local calendar and time zone, never UTC, so `2026-10-15` shows as October 15 everywhere. Tests must pass in every time zone: build test dates from `Calendar.current` date components, not UTC timestamps or ISO strings ending in `Z`, and include one test that formats and parses with a time zone west of UTC (for example, `America/Los_Angeles`). CI runs in UTC, so a time-zone bug passes there and fails on a learner's Mac. `AddTodoView` and `TodoDetailView` have an optional date picker, list rows show the due date when set, and a unit test decodes a todo with and without `dueDate`.
- [ ] Commits come in this order: plan updates, then failing tests with only the stubs needed to compile (red), then the implementation (green). Commits after red don't change the red tests.
- [ ] The `api`, `ios`, and `infra` checks are green, and the checked-in verifier is unchanged.
- [ ] When the Azure environment exists, the [Verify Before Merge](./PLAN.md#verify-before-merge) gate passes on this branch.

**Out of scope:** Reminders, notifications, and times of day.

## Assign the Cloud Agent

Assign the issue on GitHub (**Assignees** → **Copilot**, then select the `tdd-builder` agent), or from the command line:

```text
gh api -X POST repos/<owner>/smart-todo/issues/<number>/assignees --input assign.json
```

Where `assign.json` contains:

```json
{
  "assignees": ["copilot-swe-agent[bot]"],
  "agent_assignment": {
    "target_repo": "<owner>/smart-todo",
    "base_branch": "main",
    "custom_agent": "tdd-builder",
    "custom_instructions": ""
  }
}
```

Assign only after Phases 1 to 3 are merged, because the agent branches from `main` at that moment. To reassign after closing its pull request, remove `copilot-swe-agent[bot]` from the assignees first.

## Review and Merge Policy

- **Workflow approval:** If you left **Require approval for workflow runs** on (see Cloud Agent Environment), select **Approve and run workflows** after every agent push, or run `gh run rerun <run-id>` for the run whose conclusion is `action_required`.
- **Review order:** Read the red commit's test names first (the agent pastes its Requirement → Test table in the description). They show whether the agent understood the issue. Then review the implementation. Wait for the Copilot code review and handle every comment with the [Review Triage](./PLAN.md#review-triage) rules. To have the cloud agent make a fix, mention `@copilot` in a comment. It pushes to the same pull request. Put every fix in one comment, because Copilot reviews the pull request once.
- **Approval:** Copilot authored this pull request, so the learner can approve it. Teams usually raise the ruleset's required approvals to 1 at this point. For a solo learner, that also blocks their own pull requests, so it's optional here.
- **Merge:** Turn on auto-merge only after the Copilot review has posted and every thread is resolved. The ruleset then merges the pull request when every required check is green.

## Release Pipeline (Optional)

Deploy application code on every merge to `main`, gated by the deployed verifier. This pipeline deploys code, not infrastructure.

- **Bootstrap:** Run `azd pipeline config --provider github --auth-type federated --no-prompt` from `journeys/smart-todo`. Current `azd` versions (1.34 and later) create a **user-assigned managed identity** named `msi-<env>` in a **new resource group** `rg-<env>-msi`, add federated credentials for `main`, the current branch, and pull requests, and set repository variables such as `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_ENV_NAME`, and `AZURE_LOCATION`. Older versions created an app registration instead. **Record the identity's name and resource group** from the output; cleanup uses those exact values. If it creates its own workflow file, remove that file and keep `release.yml`.
- **Reduce the identity's roles.** `azd pipeline config` grants the identity **Contributor and User Access Administrator on the whole subscription**, which a deploy-only pipeline doesn't need. List the grants with `az role assignment list --assignee <principal-id> --all` and delete both subscription-scope assignments. Then grant `Reader` on the app's resource group (so `azd deploy` can find the Function App by its `azd-service-name` tag) and `Website Contributor` on the Function App. Record the role assignment IDs you create so cleanup can remove exactly those.
- **Extra variables:** Set the repository variables `AZURE_RESOURCE_GROUP` and `SMARTTODO_API_URL` from `azd env get-value RESOURCE_GROUP_NAME` and `azd env get-value API_URL`.
- **Extra role:** Grant the pipeline identity `Storage Blob Data Contributor` on the Function App's storage account. Flex Consumption deployment uploads the package with Microsoft Entra authorization, and the roles `azd pipeline config` assigns don't include blob data access.
- **Workflow (`.github/workflows/release.yml`):** Trigger on `push` to `main` and `workflow_dispatch`. Use `permissions: id-token: write, contents: read` and a `concurrency` group that doesn't cancel a running release. Map the Azure variables, including `AZURE_RESOURCE_GROUP` and `SMARTTODO_API_URL`, into the job `env`. Install `azd` and sign in with `azd auth login` using the federated credential. Run `azd deploy api --no-prompt` in a step with `working-directory: journeys/smart-todo`. Then, in a separate step from the repository root, run `node .github/scripts/verify-smart-todo.mjs --base-url "$SMARTTODO_API_URL"`. The run is green only if the verifier passes.
- **Why deploy-only:** Provisioning from CI would make the pipeline identity the SQL Microsoft Entra admin and would need `sqlcmd` on the runner. Infrastructure changes stay a local `azd provision`, gated by `node scripts/check-infra.mjs`. Schema changes still ship, because the API applies its migrations at startup.
- **Cleanup:** `azd down` doesn't remove the pipeline identity, its resource group `rg-<env>-msi`, its role assignments, or the repository variables. Delete the recorded role assignment IDs first (subscription-scope assignments outlive the identity otherwise), then `az group delete -n <recorded-identity-resource-group> --yes`, then the repository variables. Never reconstruct the name; delete only the group you recorded.

## Phase 4 Acceptance Criteria

- `.github/copilot-instructions.md` has a Definition of Done section with the gates, the review rules, and the Azure rule.
- The `copilot-setup-steps` workflow ran successfully.
- The due dates issue was delivered by the Copilot cloud agent as a pull request with plan, red, and green commits in that order. Without the cloud agent, deliver it locally with `tdd-builder`'s full cycle in a worktree, through the same pull request gates.
- The pull request merged through the ruleset with green `api`, `ios`, and `infra` checks and a resolved Copilot code review.
- If the optional release pipeline exists, its run ends with the verifier's `PASS` line.
