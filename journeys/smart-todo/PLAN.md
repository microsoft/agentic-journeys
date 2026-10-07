# SmartTodo: AI-Powered Task Breakdown

SmartTodo is an iPhone app and Azure backend that turns vague goals into actionable steps. This document defines the vision, shared decisions, the quality gates every phase must pass, and how work moves through GitHub. Detailed implementation requirements live in the phase plans so an agent can load only the context needed for the current phase.

README prompts use exact document names and section names as stable references. If a document or section is renamed, update its README references in the same change.

## Vision

Deploying to Azure is the easy part for an agent. The hard part is getting output that is worth deploying. SmartTodo teaches a workflow that makes agent output trustworthy:

1. Turn an architecture diagram into GitHub issues.
2. Interview the plan (the `grill-plan` skill) so decisions are made by the learner, not guessed by the agent.
3. Write failing tests first (red), then let the agent make them pass without touching the tests (green).
4. Ship only through deterministic gates: tests, a black-box contract verifier, infrastructure checks, CI, and code review.
5. Automate the whole loop so the next feature runs through the same factory.

The learner's job is to make decisions and review tests. The agent's job is to write the code that satisfies them.

## End State

The completed application has:

- An Azure Functions REST API for todos and action steps, with unit and contract tests that run without a database, AI key, or network.
- Azure SQL storage behind repository interfaces, with an in-memory implementation for local development and tests.
- AI task decomposition with `gpt-5-mini` on Microsoft Foundry, with a deterministic fake for local development and tests.
- A SwiftUI iOS client built from the mockups in [`images/mockups/`](./images/mockups/), with unit tests and a UI test.
- Azure Functions Flex Consumption hosting with managed-identity access to Azure SQL, provisioned by Bicep that passes a deterministic infrastructure gate before deployment.
- A GitHub repository with issues, a protected `main` branch, required CI checks, Copilot code review, and auto-merge.
- A reusable infrastructure skill, a deterministic scaffold script, and a cloud agent setup that can deliver the next feature from an issue.

## Scope

**Included:** Todo management, AI-generated action steps, step completion, automatic todo status changes, deterministic seed data, local development without Azure, a SwiftUI client, tests, CI, repository rules, Azure deployment, monitoring, verification, and cloud agent automation.

**Out of scope:** User authentication, push notifications, collaboration and sharing, offline sync, recurring todos, image attachments, rate limiting, and mobile-app distribution through azd.

## Shared Decisions

- **API stack:** Node.js LTS + TypeScript + Azure Functions v4 programming model. Tests use Vitest. Other languages are possible, but the tests, gates, and CI in these plans are specified for Node.js only.
- **Client:** Swift and SwiftUI for iOS 17 or later, tested with XCTest and XCUITest.
- **Data:** Azure SQL in Azure. An in-memory store locally and in tests. Access only through repository interfaces.
- **AI:** `gpt-5-mini` on Microsoft Foundry, with `gpt-4.1` as the regional fallback, called keyless with managed identity. A deterministic fake generator locally and in tests.
- **Pull requests:** Phases 1 to 3 are one GitHub stack of pull requests, managed with `gh stack`. Phase 4 uses ordinary pull requests.
- **Deployment:** Azure Developer CLI (`azd`) and Bicep. Prefer Azure Verified Modules, and use a raw `Microsoft.*` fallback when AVM parameter drift blocks deployment.
- **Default region:** `westus`.
- **API status values:** `pending`, `in_progress`, and `completed`.
- **Custom agent:** `tdd-builder` (in `.github/agents/`) runs the red and green phases.
- **Planning skill:** `grill-plan` (in `.github/skills/`) runs the plan interview.

## Workspace Setup

`setup/setup.mjs` creates the learner's workspace and repository. It's a checked-in Node.js script with no dependencies, because this step is the same every time. Run it from the journeys repository root:

```text
node journeys/smart-todo/setup/setup.mjs
```

It does the following, and stops before changing anything if the workspace directory already exists and isn't empty:

1. Copies `journeys/smart-todo` (without `checkpoints/` and `setup/`), `.github/agents`, `.github/skills`, `.github/scripts`, and `docs` into `../smart-todo-workspace`, keeping their paths.
2. Adds `setup/ci.yml` as `.github/workflows/ci.yml`, the [TDD Guard](#tdd-guard) hook from `setup/hooks/` as `.github/hooks/`, the starter `setup/copilot-instructions.md` as `.github/copilot-instructions.md`, and a root `.gitignore` that excludes secrets and generated files: `.env` and `.env.*` (but allows `.env.example`), `.azure/`, `local.settings.json`, `node_modules/`, `dist/`, `build/`, `coverage/`, `.azurite/`, and the Xcode artifacts `*.xcuserstate`, `xcuserdata/`, and `DerivedData/`.
3. Initializes Git on `main` and commits everything as `Initial SmartTodo workspace`.
4. With `--start-at <phase>`, adds the earlier phases from [Checkpoints](#checkpoints) as a second commit.
5. Unless `--local` is given, creates the GitHub repository (public unless `--private`), pushes `main`, enables auto-merge, squash merging, and head-branch deletion, creates the `phase-1`, `phase-2`, `phase-3`, and `known-limitation` labels, applies `setup/ruleset.json` as described in [Repository Protection](#repository-protection) (`--no-copilot-review` leaves that rule out), and waits for the first CI run on `main`.

It prints the ruleset's enforcement and the CI result, and exits non-zero if the ruleset isn't active or CI didn't succeed. After a failure on GitHub, fix the cause and rerun with `--resume`, which reuses the workspace and repository. Run it with `--help` for every option.

## Checkpoints

`checkpoints/phase-1`, `phase-2`, and `phase-3` hold the finished code of each phase from a validation run, so a learner can start at any phase with `setup.mjs --start-at <phase>`:

| Start at | Applied checkpoints | What's already on `main` |
| --- | --- | --- |
| 2 | `phase-1` | The API and its tests |
| 3 | `phase-1`, `phase-2` (on top of `starter/ios`) | The API and the finished iOS app |
| 4 | `phase-1` to `phase-3` | The API, the iOS app, the infrastructure, the gates, and the infrastructure skill |

Each checkpoint mirrors `journeys/smart-todo` under `journey/`, and the workspace root under `repo/`. They pass the same gates as the phases that produced them. The setup script doesn't copy `checkpoints/` into the workspace, so agents can't copy the answers. When a phase plan changes, regenerate its checkpoint from a validation run.

## Target Project Structure

The learner's workspace is also their GitHub repository. Paths are relative to the workspace root.

```text
smart-todo-workspace/
├── .github/
│   ├── agents/tdd-builder.agent.md
│   ├── hooks/tdd-guard.json, tdd-guard.mjs  # TDD Guard hook
│   ├── skills/                        # grill-plan and the Phase 3 infrastructure skill
│   ├── scripts/verify-smart-todo.mjs  # checked-in black-box contract verifier
│   ├── workflows/ci.yml               # api, ios, infra, and windows checks
│   ├── workflows/copilot-setup-steps.yml
│   └── copilot-instructions.md        # starter in Phase 0; definition of done added in Phase 4
└── journeys/smart-todo/
    ├── PLAN*.md, images/
    ├── starter/ios/                   # starter Xcode project copied into src/ios in Phase 2
    ├── src/api/                       # Azure Functions API + tests
    ├── src/ios/                       # SwiftUI app + tests
    ├── scripts/                       # test-ios.mjs (checked in), check-infra.mjs, scaffold-infra.mjs
    ├── infra/                         # Bicep and portable deployment hooks
    └── azure.yaml
```

## Phase Plans

| Journey phase | Detailed plan | Outcome |
| --- | --- | --- |
| Phase 0: Plan the work | This document and [`images/architecture.png`](./images/architecture.png) | Repository, CI workflow, and protected `main` from `setup.mjs`, and one GitHub issue per phase |
| Phase 1: Build the API test-first | [`PLAN-phase1-api.md`](./PLAN-phase1-api.md) | Models, repositories, REST endpoints, seed data, AI decomposition, tests, and the first CI checks |
| Phase 2: Build the iOS app from mockups | [`PLAN-phase2-ios.md`](./PLAN-phase2-ios.md) | The Todo Detail screen, test-first, on a starter app that already has the list, the API client, and their tests |
| Phase 3: Deploy to Azure with gates | [`PLAN-phase3-azure.md`](./PLAN-phase3-azure.md) | Cost review, infrastructure gate, Flex Consumption deployment, a reusable skill, and a scaffold script |
| Phase 4: Build the factory | [`PLAN-phase4-factory.md`](./PLAN-phase4-factory.md) | Definition of done, cloud agent environment, and an issue delivered by the cloud agent |

Read this overview before beginning. During implementation, load the current phase plan and only the earlier phase plan needed to confirm an existing contract. A final review must check this overview and all phase plans.

## Issue Breakdown

Phase 0 creates one parent issue and one sub-issue for each of Phases 1 to 3:

- **Parent issue:** `SmartTodo v1`, summarizing the architecture and linking this document.
- **Sub-issues:** `Phase 1: API`, `Phase 2: iOS app`, and `Phase 3: Azure deployment`.

Each sub-issue body contains:

1. **Goal:** One or two sentences.
2. **Plan:** A link to the phase plan.
3. **Acceptance criteria:** A task list copied from the phase plan's acceptance criteria section.
4. **Gate:** A table copied from the phase's rows in [Quality Gates](#quality-gates), with one command per row and the directory to run it from. Don't combine commands with `cd` or `&&`, because the next command then runs in the wrong directory.
5. **Depends on:** The earlier phase, when one exists.

Label the sub-issues `phase-1`, `phase-2`, and `phase-3`. Also create a `known-limitation` label; [Review Triage](#review-triage) files real issues that are out of scope as issues with that label. Create the labels when they don't exist.

## Quality Gates

No phase ships until its gate passes. A gate is a command with a deterministic exit code, not an agent's opinion.

| Phase | Gate command (from `journeys/smart-todo`) | Proves | Runs in CI job |
| --- | --- | --- | --- |
| 1 | `npm run check` in `src/api` | Type checks, unit tests, and contract tests pass without Azure | `api` |
| 1 | `git diff --exit-code phase1-red -- src/api/test` | The green phase didn't change the latest red-phase tests | Local only |
| 1 | `node ../../.github/scripts/verify-smart-todo.mjs --base-url http://localhost:7071` | The running API honors the contract from the outside | `api` |
| 2 | `node scripts/test-ios.mjs --check-starter` | The iOS unit tests and UI test pass on a simulator, and the starter's tests are present and unchanged | `ios` (macOS runner, without `--check-starter`) |
| 2 | `git diff --exit-code phase2-red -- src/ios/SmartTodoTests src/ios/SmartTodoUITests` | The green phase didn't change the red-phase tests | Local only |
| 2 | `git diff --exit-code main -- scripts/test-ios.mjs starter/ios` | Nobody changed the test runner or the starter | Local only |
| 3 | `node scripts/check-infra.mjs --offline` | Bicep compiles and lints cleanly, and it satisfies the deployment contract | `infra` |
| 3 | `git diff --exit-code phase3-red -- scripts/check-infra.mjs` | Generating infrastructure didn't weaken the gate | Local only |
| 3 | `node scripts/check-infra.mjs` | The offline checks plus an `azd provision --preview` what-if run against Azure. The preview creates only the empty, tagged resource group | Local only |
| 3 | `node ../../.github/scripts/verify-smart-todo.mjs` | The deployed API honors the contract | Local, or the Phase 4 release pipeline |
| 4 | [Verify Before Merge](#verify-before-merge) | A pull request that changes the API or infrastructure works on Azure before it merges | Local |

The checked-in verifier (`.github/scripts/verify-smart-todo.mjs`) is the one gate an agent doesn't write. Treat changes to it as a review-required change.

**Red tags move forward.** `phase1-red`, `phase2-red`, and `phase3-red` always point at the latest red commit. When review findings add tests later in the phase, the human deletes the tag (`git tag -d phase1-red`), the agent commits those tests as a new red commit, and the agent tags that commit `phase1-red`. The diff gate then proves that the fix didn't change the new tests either. After the stack merges, the human deletes all three tags, because Phase 4 has no red tags.

## TDD Guard

`setup.mjs` installs a Copilot `preToolUse` hook as `.github/hooks/tdd-guard.json`, which runs `.github/hooks/tdd-guard.mjs` before each tool call in Copilot CLI and the Copilot cloud agent. It needs only Node.js.

- **Frozen tests:** While a red tag exists, the agent can't edit, create, move, or delete the files it protects: `phase1-red` protects `src/api/test/`, `phase2-red` protects `src/ios/SmartTodoTests/` and `src/ios/SmartTodoUITests/`, and `phase3-red` protects `scripts/check-infra.mjs`.
- **Tags:** The agent can't move or delete a red tag. It can create one that doesn't exist. To unlock tests, the human runs `git tag -d <tag>` in a terminal, and the agent tags its new red commit again.
- **Always protected:** `.github/hooks/`, `.github/scripts/verify-smart-todo.mjs`, `scripts/test-ios.mjs`, and `starter/`.
- **Limits:** The hook checks file edits exactly and shell commands on a best-effort basis, so the diff gates stay the proof. Copilot CLI loads repository hooks only in a trusted folder. Tags are local, so the hook protects no tests in a cloud agent session.

## Verify Before Merge

Local gates use the in-memory store and the fake AI, so they can't catch bugs that only exist in Azure. Validation runs hit three: a model parameter that gpt-5-mini rejects, a SQL parameter bound with the wrong type, and a schema change that the code needed before the database had it. Once the Azure environment exists (after Phase 3), a pull request that changes `src/api` or `infra` must also pass this gate before it merges:

1. Check out the pull request branch (`gh pr checkout <number>`).
2. From `journeys/smart-todo`, run `azd deploy api` for code changes, or `azd up` when `infra/` changed.
3. Run `node ../../.github/scripts/verify-smart-todo.mjs` and paste its `PASS` line into a pull request comment.

The deployed app then runs the pull request's code until the next deployment, which is fine for a learning environment. The unit tests also check the boundaries the fake AI and memory store hide: the exact fields of the model request and the SQL parameter types (see [Test Strategy](./PLAN-phase1-api.md#test-strategy)).

## Continuous Integration

The workflow is checked in as `setup/ci.yml`, and `setup.mjs` installs it as `.github/workflows/ci.yml` before the ruleset exists. Each job skips its work until its area exists, so the file is correct from the first commit. It follows these rules; keep them when you change it:

- Trigger on `pull_request` (for any base branch, so every layer of the stack gets checks) and on `push` to `main`.
- Use jobs named exactly `api`, `ios`, `infra`, and `windows`. The first three are required status checks. `windows` is informational: it proves the Windows path but doesn't block merging.
- **Every job must always run and must succeed when its area doesn't exist yet.** Don't use workflow-level `paths` filters. A required check that never reports blocks the pull request forever. Use a first step that detects whether `journeys/smart-todo/src/api`, `journeys/smart-todo/src/ios`, or `journeys/smart-todo/infra` exists, and condition the later steps on it.
- `api` (ubuntu-latest): Use `journeys/smart-todo/src/api` as the working directory. Set up Node.js LTS with npm caching and `cache-dependency-path: journeys/smart-todo/src/api/package-lock.json`. Run `npm ci`, `npm run check`, and `npm run build`. Copy `local.settings.example.json` to `local.settings.json`, because the real file is gitignored and `func start` needs its `AzureWebJobsStorage`, `FUNCTIONS_WORKER_RUNTIME`, `DATA_PROVIDER=memory`, and `AI_PROVIDER=fake` values. Install Azure Functions Core Tools v4 with npm, start `npm run azurite` and `func start` in the background, wait until `GET /api/todos?userId=user-1` returns 200 (at most 120 seconds), and then run the checked-in verifier with `--base-url http://localhost:7071`.
- `ios` (macos-latest): Run `node journeys/smart-todo/scripts/test-ios.mjs` when the Xcode project exists.
- `infra` (ubuntu-latest): Run `node journeys/smart-todo/scripts/check-infra.mjs --offline` when `infra/` exists. Azure CLI is preinstalled. Run `az bicep install` first.
- `windows` (windows-latest, `defaults.run.shell: pwsh`): When `src/api` exists, run the same steps as `api` (install, `npm run check`, build, Azurite, `func start`, the checked-in verifier). When `infra/` exists, install `azd` with `Azure/setup-azd@v2` and run `node journeys/smart-todo/infra/hooks/postprovision.js --dry-run`. Fail the job if its output reports `az` or `azd` as `MISSING`; that proves the hook finds and runs them through its Windows launcher without touching Azure. Start background processes with `Start-Process` and poll with `Invoke-WebRequest` against a 180-second deadline, with a 10-second timeout per request, because a cold Windows runner answers the first requests slowly.
- Use `permissions: contents: read`. The workflow needs no secrets.

## Repository Protection

`setup.mjs` applies `setup/ruleset.json`, one branch ruleset on the default branch:

- Require a pull request before merging, with 0 required approvals. The learner authors most pull requests and can't approve their own. Phase 4 explains when to raise this.
- Require conversation resolution before merging, so unresolved Copilot code review comments block the merge.
- Require the status checks `api`, `ios`, and `infra`. Don't require branches to be up to date, because auto-merge doesn't update branches for you.
- Automatically request a Copilot code review on new pull requests only. Turn off review on new pushes (`review_on_push: false` in the ruleset's `copilot_code_review` rule), so fixing review comments doesn't start another review. [Review Triage](#review-triage) allows one round per pull request. The rule only fires for pull requests whose base is `main`: the Phase 1 layer and the Phase 4 pull requests.
- Block force pushes and branch deletion.

It also enables auto-merge, squash merging, and automatic head-branch deletion on the repository. Stack layers merge with `gh stack merge`; auto-merge is for the ordinary pull requests in Phase 4.

**Copilot code review doesn't block by itself.** Its review arrives a few minutes after a pull request opens and is a comment, not an approval or a required check. Conversation resolution only blocks once the comments exist. So never enable auto-merge when you open a pull request. Wait for the Copilot review, handle it with the [Review Triage](#review-triage) rules, and then enable auto-merge.

**Without Copilot code review** (your plan doesn't include it), leave the `copilot_code_review` rule out of the ruleset. Run `/review` locally before you open each pull request and triage its findings the same way. Every other gate is unchanged.

Rulesets are enforced on public repositories on every GitHub plan. Private repositories need GitHub Pro, Team, or Enterprise. If the ruleset can't be enforced, `setup.mjs` stops. Make the repository public and rerun with `--resume`, or rerun with `--resume --allow-unprotected` to continue knowing that the gates run but don't block merging.

## Review Triage

Every review finding, from `/review`, `/rubber-duck`, or Copilot code review, gets one of three outcomes:

1. **Fix:** Correctness, security, or contract findings get a red/green loop: a failing test in a new red commit (tagged with the phase's red tag after the human deletes the old one), then the fix. Reply to the comment with the commits and resolve the thread.
2. **Known limitation:** Real issues outside this phase's scope become a GitHub issue labeled `known-limitation`, with the finding and a one-line suggested fix. Reply to the comment with the issue link and resolve the thread.
3. **Decline:** Findings that are wrong or conflict with the plan get a reply that cites the plan section. Resolve the thread.

**Which pull requests get Copilot review.** Phase 1 and every Phase 4 pull request. The Phase 2 and Phase 3 layers skip it to save time: their gates are the same kind you've already seen reviewed, and one full review loop teaches the procedure. Request one with `gh pr edit <pr> --add-reviewer @copilot` if you want it. If Copilot reviews an upper layer anyway, triage it the same way.

**One round per pull request.** Copilot reviews a pull request once, when it opens (the ruleset doesn't review new pushes). Fix everything in that round with one push. If you request another review, file anything it finds as `known-limitation` issues instead of fixing it in the same pull request. Validation runs showed that each extra round finds something new in the previous fix and costs more than the fix itself.

**Problems you hit and fixed** during a phase go in the pull request description under a "Problems and fixes" heading, so they're recorded without a file that every branch edits.

**Triage procedure for a pull request's review** (what "handle the review" means in the README):

1. Read every review comment with the GitHub CLI.
2. Give each one an outcome from the list above. Write fixes as the tdd-builder agent's red/green loop: failing tests in a new red commit, then the fix as a green commit. Commit each fix in the layer that owns the change. When the phase has a red tag, the human deletes it before the triage starts, and the agent tags the new red commit; a cloud agent pull request has no tag, so its fix is checked against the latest red commit instead.
3. If a fix touched `infra/` or `src/api` and the Azure environment exists, run [Verify Before Merge](#verify-before-merge) (for `infra/`, `node scripts/check-infra.mjs` and `azd up` first, then `node infra/hooks/postprovision.js`) and paste the verifier's `PASS` line into a pull request comment.
4. Reply to every thread with its commits, issue link, or reason, and resolve it. If a fix also resolves an open `known-limitation` issue, close that issue with a link to the commit.
5. Push once, after every fix is committed (`gh stack push` for a stack layer). Don't merge; the human does that.

## Stacked Pull Requests

Phases 1 to 3 are one **GitHub stack**, managed with the [`gh stack`](https://github.com/github/gh-stack) extension. Each phase is a layer whose pull request shows only that phase's changes, and each layer can start before the one below it merges:

```text
main ← phase-1-api ← phase-2-ios ← phase-3-azure
```

| Phase | Create the layer | Pull request base |
| --- | --- | --- |
| 1 | `gh stack init --base main phase-1-api` | `main` |
| 2 | `gh stack add phase-2-ios` (from the top of the stack) | `phase-1-api` |
| 3 | `gh stack add phase-3-azure` (from the top of the stack) | `phase-2-ios` |

- **Open pull requests with `gh stack submit --auto --open`.** It pushes every layer and creates or updates one ready-for-review pull request per layer, linked as a stack. Put `Closes #<issue>` in each pull request description.
- **Titles become commits.** `submit --auto` titles each pull request from its branch name (`phase 1 api`), and the squash merge uses that title as the commit message. Retitle each one (`Phase 1: API`) when you open it.
- **Merge rules apply to every layer as if it targeted `main`.** Required checks and conversation resolution are evaluated against `main` for every layer, and CI's `pull_request` trigger runs for every layer.
- **Only the bottom layer gets Copilot review automatically.** The ruleset requests it only for pull requests whose base is `main`. The journey reviews Phase 1 and skips the review on Phases 2 and 3 (see [Review Triage](#review-triage)); request one with `gh pr edit <pr> --add-reviewer @copilot` if you want it. Copilot review doesn't block by itself, so an unreviewed layer can merge once its checks pass.
- **Fix a lower layer in that layer.** Run `gh stack checkout <branch>` (or `gh stack down`), commit the fix, run `gh stack rebase --upstack` to replay the layers above it, then `gh stack top` and `gh stack push`.
- **Merge once, from the top, after Phase 3:** `gh stack merge <phase-3-pr> --yes --squash`, then `gh stack sync --prune`. It merges that pull request and every unmerged one below it, each as its own squash commit, and merges nothing if any of them isn't ready. `gh pr merge` and auto-merge can't merge stack layers. Don't merge a lower layer early: the layer above it then targets `main`, which triggers the automatic Copilot review. GitHub also treats a stack as a stack only when it has at least two pull requests; a lone layer is an ordinary pull request and merges with `gh pr merge`. After the merge, delete the red tags with `git tag -d phase1-red phase2-red phase3-red`, so the [TDD Guard](#tdd-guard) doesn't freeze tests in Phase 4.
- **Red tags survive rebases.** `gh stack rebase` and `sync` rewrite commit IDs, so `phase1-red`, `phase2-red`, and `phase3-red` keep pointing at the original commits. The diff gates compare file contents, so they still work as long as a layer never edits another layer's test files.
- **One checkout holds the stack.** Layers are built one after another in the same checkout: you can open the next layer while the one below is in review, but you can't have two agents writing two layers at the same time. Don't put stack layers in separate worktrees. Use a worktree only to run the local API, as a detached checkout that moving between layers doesn't disturb: `git worktree add --detach ../../../smart-todo-api phase-1-api`. Worktrees don't share ignored files, so copy `src/api/local.settings.example.json` to `local.settings.json` and run `npm ci` there. After a Phase 1 fix, refresh it with `git checkout --detach phase-1-api` in that worktree and restart the API.

Stacked pull requests are in public preview. If `gh stack submit` reports that stacks aren't enabled for the repository (exit code 9), open ordinary pull requests with the same bases instead, and merge them bottom-up.

## Cross-Phase Contracts

- Phase 1 ([`PLAN-phase1-api.md`](./PLAN-phase1-api.md)) owns the canonical Todo, ActionStep, error, REST response, and AI-generation contracts, and the `DATA_PROVIDER` and `AI_PROVIDER` settings.
- Phase 2 ([`PLAN-phase2-ios.md`](./PLAN-phase2-ios.md)) consumes the Phase 1 contracts and centralizes calls in one Swift API client.
- Phase 3 ([`PLAN-phase3-azure.md`](./PLAN-phase3-azure.md)) configures and deploys the application built in the first two phases. It does not redefine application behavior.
- Phase 4 ([`PLAN-phase4-factory.md`](./PLAN-phase4-factory.md)) automates the workflow and must not weaken any gate.
- Section names referenced by README prompts are part of the journey contract.

## End-to-End Acceptance Criteria

The local application is complete when:

- `npm run check` passes and the checked-in verifier passes against the local API with the in-memory store and fake AI.
- `node scripts/test-ios.mjs` passes on a Mac.
- Each phase merged to `main` through a pull request with green `api`, `ios`, and `infra` checks.

The Azure deployment is complete when:

- `node scripts/check-infra.mjs` passes before `azd up`.
- The post-provision hook creates the managed-identity database user, and the API applies its migrations and seed data at startup.
- The checked-in verifier passes against the deployed API.
- The iOS app can use the deployed HTTPS API URL.

The journey is complete when a Phase 4 feature issue has been delivered through the same gates, and `azd down --force --purge` has removed the run's Azure resources.

## Production Hardening (Out of Scope)

Before exposing this beyond a demo, wrap multi-write operations (step generation, regeneration, and step-driven status changes) in Azure SQL transactions, add API authentication, add rate limiting for `/generate-steps`, encode output if data is rendered in a browser, and replace broad storage and SQL firewall rules with private networking.
