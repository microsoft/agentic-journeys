---
name: journey-runner
description: |
  Run an agentic journey end-to-end: preflight the host, extract prompts, execute them in an isolated workspace, build, deploy to Azure, verify with real requests and screenshots, and clean up only owned resources.
  USE FOR: test a journey, run a journey end-to-end, validate journey prompts, deploy a journey to Azure, walk through a journey, execute journey steps, CI journey test.
  DO NOT USE FOR: creating new journeys (use journey-template), reviewing journey content (use content-reviewer), or modifying unrelated code.
---

# Journey Runner Skill

Run a journey like a learner would, but with strict preflight, isolated state, evidence-backed verification, and scoped cleanup. The workflow must work on Windows, Mac, and Linux.

## Required Runner Tools

The runner itself requires:

- Node.js LTS or later
- Azure CLI
- Azure Developer CLI (`azd`) 1.28.0 or later
- GitHub Copilot CLI

Screenshot runs additionally require the local Playwright package and bundled Chromium under `scripts/`. Installation options for all operating systems are in [`../../../docs/tool-installation.md`](../../../docs/tool-installation.md).

Do not install system tools during a run. Report the missing tool, its install link, and the validation command, then stop before generating code or creating Azure resources. Project-local `npm ci` for the checked-in runner helpers is allowed only during explicit runner setup, not as a surprise halfway through a journey.

## Inputs and Defaults

Inputs:

1. Journey path, such as `journeys/smart-todo/`
2. Stack choice when the journey supports multiple stacks
3. Azure subscription for deployment runs
4. Cleanup policy: `after-verification` or `leave-running`

Defaults:

| Behavior | Default |
|---|---|
| Deploy to Azure | Yes, when the journey contains a deployment phase |
| Cleanup | `after-verification` |
| Stack | Use the only option; ask before starting when multiple materially different stacks exist |
| Verification failure | Record the failure, attempt one evidence-based repair, then stop that phase if it still fails |
| Output | Concise phase summary plus artifact paths and actual command results |

Only use `leave-running` when the user explicitly requests it.

## Step 0: Parse the Journey

Read the journey's `README.md`, `PLAN.md` when present, and every associated journey skill. Extract:

- Journey type and phases
- Prompts to send to Copilot
- Commands and generated scripts
- Required and optional host tools
- Local ports
- Deployment outputs
- Verification criteria
- Platform gates such as Xcode

Build a prerequisite list from the journey's own prerequisite section. Do not rely on a hard-coded generic list when the journey requires `sqlcmd`, Azure Functions Core Tools, or another host tool. AIMarket deployment images must build in ACR, and Superset must run Helm and `kubectl` inside Azure through AKS run command.

Before execution, print a plan containing the journey, stack, host OS/architecture, phases, required tools, optional tools, planned ports, deployment choice, and cleanup policy.

## Step 1: Cross-Platform Preflight

Detect the host with Node.js `process.platform`, `process.arch`, and `os.release()`. Never infer the operating system from path syntax.

Run the helper from this skill directory:

```text
node scripts/check-prerequisites.mjs --required node,az,azd,copilot,<journey-tools> --optional <optional-tools>
```

Journey-specific minimums:

| Journey | Additional required tools | Optional or platform-gated tools |
|---|---|---|
| Grafana | None | Playwright for screenshots |
| n8n | Node.js LTS or later | Playwright for screenshots |
| Superset | Node.js LTS or later | Playwright for screenshots; local `kubectl` and Helm only for optional direct cluster work |
| AIMarket | Node.js LTS or later, GitHub CLI | Playwright; Docker only for optional local container work |
| SmartTodo | Node.js LTS or later, Git, Azure Functions Core Tools v4, `sqlcmd` | Project-local Azurite for local execution; GitHub CLI and the `gh stack` extension only when a disposable repository is provided; Xcode 16+ and `ios-simulator` (an installed iOS simulator runtime) only for Mac iOS execution |
| WeatherView | Node.js LTS or later | Project-local Playwright and bundled Chromium; ARM64 may require the documented temporary x64 Azure publisher or an approved x64 host if the SWA client returns an architecture error |

### Authentication preflight

Check Azure CLI and `azd` separately:

1. `az account show` must succeed and show the intended subscription.
2. Configure `azd` to reuse Azure CLI authentication with `azd config set auth.useAzCliAuth true`.
3. Run an `azd` command that reads account/environment state before creating resources.
4. If Azure CLI works but `azd` still reports an expired token, stop and report the mismatch. Do not assume `az login` fixed `azd`.
5. Compare `azd config get defaults.subscription` with `az account show --query id -o tsv`. A stale global default makes `azd provision --preview` fail with an access error until a prompt sets `AZURE_SUBSCRIPTION_ID` in the environment. Report the mismatch; don't change the user's global config.

### Architecture preflight

For Container Apps images, compare host architecture with the required `linux/amd64` target.

- Require ACR cloud builds targeting `linux/amd64` on every host architecture.
- Do not require Docker, Buildx, AMD64 emulation, or privileged QEMU/binfmt handlers for deployment.
- Require frontend Dockerfiles that ACR can build without host-specific BuildKit variables.

### Mobile platform matrix

- Mac with Xcode: build and run the iOS app or simulator when the journey requires it.
- Windows or Linux: generate and inspect SwiftUI source, build and test the backend, deploy Azure resources, and run backend API verification. Do not claim an iOS simulator or Xcode test occurred.

Any missing required prerequisite stops the journey before Phase 1.

## Step 2: Create an Isolated Workspace

Create a unique directory without shell-specific date or path expressions. Use Node.js filesystem APIs or the active agent's file tools.

Recommended shape:

```text
<journey-runs-root>/<journey-name>-<UTC timestamp>/
```

Copy only `PLAN.md` and other explicitly required source documents. Never write generated application files into the source journey directory.

Record:

- Absolute workspace path
- Source commit
- Host OS and architecture
- Tool versions
- Selected stack
- Selected local ports
- Cleanup policy

Before starting a local server, test whether its preferred port is available. Select a supported free port rather than stopping an unrelated process.

## Step 3: Invoke Copilot Correctly

Copilot CLI accepts prompt text with `-p`; it does not accept a `--prompt-file` CLI option. Do not launch background jobs with an unverified flag.

Extract the README's prompts word for word instead of retyping them:

```text
node scripts/extract-prompts.mjs --readme <journey>/README.md --out <run-dir>/prompts
```

It writes `NN.txt` per prompt and an `index.json` with each prompt's heading, slash command, and placeholders. Fill placeholders (such as `<pr-number>`) in a copy, never in the README. Prompts that start with an interactive-only slash command (`/rewind`, `/fork`, `/delegate`, `/diff`) can't run under `copilot -p`; validate them as Step 4 describes. A block where every line starts with `> ` holds separate one-line prompts, so the extractor splits it. The "When something fails" template has no `> ` marker and isn't extracted: when a step fails, fill it in by hand with the real command and redacted error, and send it in the same session.

Run each prompt with the cross-platform helper:

```text
node scripts/run-copilot-prompt.mjs --prompt-file <run-dir>/prompts/01.txt --cwd <workspace> --allow-dir <repository-root> --allow-all-tools --allow-all-urls --allow-skill-dirs --timeout-minutes 40 --label "01 plan" --log <run-dir>/logs/01.log --record <run-dir>/timing.jsonl --session-out <run-dir>/session.txt
```

The helper reads the file and calls `copilot -p <prompt>` with `shell: false`, avoiding Bash and PowerShell quoting differences. Non-interactive runs must explicitly opt into the tools and URLs required by the journey, and must add the repository root when the workspace is a child directory; otherwise Copilot cannot request approval and silently loses access to commands or parent skills.

- `--allow-skill-dirs` adds the user skill and plugin directories (`~/.copilot/skills`, `~/.agents/skills`, `~/.copilot/installed-plugins`). Always pass it: Azure skills run scripts from there, and prompt mode denies paths it can't ask about.
- Azure MCP is part of every journey's prerequisites, so the helper keeps it on. Under `-p`, it replaces the Azure Skills plugin's server with the same `@azure/mcp` package in `--mode all` (named `azmcp`). The plugin starts it in namespace mode, where a call with only an intent asks the client to choose the command through MCP sampling, and Copilot CLI doesn't answer sampling in prompt mode ([github/copilot-cli#2882](https://github.com/github/copilot-cli/issues/2882)): the call shows "Learning about ... capabilities" and never returns. `--mode all` exposes each tool directly and never samples. It loads only the namespaces the journeys use (`--azure-mcp-namespaces` overrides them): all 519 tools exceed the model's context in plan mode. Learners' interactive sessions answer sampling, so they use the plugin as installed. Pass `--azure-mcp plugin` once the CLI fixes prompt-mode sampling.
- The helper turns off `computer-use` unless you pass `--allow-mcp-server computer-use`: an unattended run used it to open the host's Safari.
- `--timeout-minutes <n>` stops a prompt that runs too long and records exit 124. Use 40 for generation prompts and 75 for prompts that run `azd up`.
- `--agent <name>` selects a custom agent, such as `oss-to-azure-deployer`.
- `--mode plan` starts in plan mode; resume with `--mode interactive` to act on the plan.
- `--session-out <file>` saves the session ID, and `--resume-from <file>` continues it, so later prompts keep the learner's context.
- `--record <file>` appends the step's label, duration, exit code, session ID, and session credit total as one JSON line.

Run lifecycle commands (`azd up`, verifiers, `azd down`) with the matching helper so they land in the same record:

```text
node scripts/run-command.mjs --label "azd up" --log <run-dir>/logs/azd-up.log --record <run-dir>/timing.jsonl --cwd <workspace> -- azd up --no-prompt
```

At the end, `node scripts/summarize-run.mjs --record <run-dir>/timing.jsonl` prints a step table and totals for `run-report.md`. It counts each session's highest credit total once, because resumed sessions report a running total.

### Unattended runs and other operating systems

`node scripts/run-journey.mjs <journey> [--run-dir <dir>] [--location westus]` runs one journey end to end with these helpers: the README's prompts, the journey's gates and checked-in verifier, `azd up` with one "When something fails" repair, and `azd down --force --purge` in a `finally` block. It reverts and reports any agent edit to `.github/scripts`, writes `run-report.md` and redacted logs, and lists every step it skipped: interactive-only commands (`/rewind`, `/fork`, `/delegate`), steps that need a disposable GitHub repository (SmartTodo's 🐙 steps, AIMarket's cloud agent), and iOS work off macOS. `--cleanup-only --run-dir <dir>` deletes what an interrupted run left behind.

The `journey-windows` workflow runs it on a GitHub-hosted `windows-latest` runner, for any journey, from `workflow_dispatch` or by pushing a `run/windows/<journey>` branch. It signs in to Azure with OIDC through a GitHub environment named `journey-windows` that holds `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` as variables, with no stored Azure secret. Give the Entra app **Contributor** on the subscription and **Role Based Access Control Administrator** with a condition that allows only the data-plane roles the journeys assign (AcrPull, Cognitive Services User and OpenAI User, the Storage Blob, Queue, and Table data roles, Network Contributor, Monitoring Metrics Publisher, and Key Vault Secrets User). GitHub may issue the OIDC subject with immutable IDs (`repo:<owner>@<id>/<repo>@<id>:environment:journey-windows`); if sign-in fails with `AADSTS700213`, create the federated credential with the exact subject the error prints.

Don't route around a device-management policy to reach a managed machine: an Intune-managed PC that blocks inbound SSH, or refuses device-code sign-ins, should be tested through the hosted runner instead.

Before launching a batch, run `copilot --help` and one harmless prompt smoke test. If that fails, do not start parallel or background journey processes.

Execute prompts sequentially within a journey. Wait for each prompt to finish, inspect the files it produced, and only then continue.

## Step 4: Execute Commands Portably

Do not execute a fenced `bash` block verbatim in PowerShell.

Priority order:

1. Run checked-in or generated Node.js verification and lifecycle scripts.
2. Run individual CLIs with argument arrays and `shell: false`.
3. Use a journey-provided PowerShell or Bash variant that matches the host.
4. If only an OS-specific command exists, stop and log a documentation defect rather than inventing a translation after resources exist.

Generated `azd` lifecycle hooks must be CommonJS `.js` or `.ts` files referenced directly from `azure.yaml`; `azd` 1.28.0 rejects `.mjs` hook paths. Do not generate `.sh` hooks, `shell: sh`, `chmod`, shell traps, command substitution, or pipelines for required deployment behavior.

For n8n, setting `WEBHOOK_URL` creates a replacement Container App revision. The generated post-provision hook must poll both `/healthz` and `/` for up to five minutes and require six consecutive HTTP 200 results over 30 seconds. Do not accept one successful probe while the old revision is still deprovisioning. When `uniqueString()` output crosses a Bicep module boundary, constrain that parameter to exactly 13 characters.

For Superset, a clean environment may not contain `SUPERSET_SECRET_KEY` or `SUPERSET_ADMIN_PASSWORD`. The generated Node hook must create cryptographically random values when absent, persist them with `azd env set`, never print them, and reuse existing values on reruns before creating Kubernetes secrets.

For Grafana, n8n, and Superset, the README has the agent plan and cost the deployment read-only, then generate the infrastructure and run `azd provision --preview`, and the learner runs `azd up`. Run each README prompt with `--agent oss-to-azure-deployer` from a disposable clone of the repository, resume the same session for each step, and run `azd up` yourself. In n8n, start `azd up` in the background and run the workflow prompt at the same time, then create the owner account and API key through n8n's REST endpoints (`/rest/owner/setup`, `/rest/api-keys`) without printing either, and pass the key to `scripts/run-n8n-workflow.mjs` through its environment. In Grafana, confirm the dashboard with `GET /api/search`.

For WeatherView and AIMarket, create the workspace with `node .github/scripts/create-workspace.mjs <journey> --workspace <working directory>` instead of copying files by hand. Run WeatherView's plan prompt with `--mode plan`, then resume that session with `--mode interactive` for the build prompt. `/rewind`, `/fork`, and `/delegate` work only in interactive sessions. On Mac or Linux, validate `/rewind` in the run's own session with a pseudo-terminal (Python `pexpect`): resume the session, accept the folder-trust dialog (Enter after about 20 seconds), send the README's throwaway prompt, wait until its output is quiet, then send `/rewind`, choose the newest turn, choose **Conversation + files**, and confirm. Pass only if a hash of every tracked and untracked file matches the snapshot taken before the throwaway prompt. In an interactive session the agent can answer a spec-conflicting prompt with questions (`ask_user`) instead of edits; if the file snapshot doesn't change within a few minutes, read the screen before waiting longer. The same technique rewinds a phase after a prompt defect, so the rerun starts from clean files instead of a hand-reverted tree. On Windows, validate it by hand. Validate AIMarket's delegation through Option C (create the issue and assign `copilot-swe-agent[bot]` through the REST API) while building search locally, then request Copilot code review with `gh pr edit <pr> --add-reviewer @copilot`. Start each phase in a fresh session or compact it: a single long session costs several times more credits.

For SmartTodo, the journey workspace replaces the generic "copy only `PLAN.md`" layout. Create it with the checked-in script instead of the README's copy steps: `node journeys/smart-todo/setup/setup.mjs --workspace <working directory>` with a disposable repository name (`--repo <name>`), or with `--local` when no disposable repository was provided. Don't pass `--start-at` unless the user explicitly asked to validate a later-phase start. Checkpoints are finished answers, so a run that deploys them doesn't test the journey's prompts, and it must never be reported as a journey PASS. The working directory must not exist or must be empty, and Git needs `user.name` and `user.email`. Run prompts, gates, `azd up`, the verifier, and `azd down` from `<working directory>/journeys/smart-todo`. This override takes precedence over the e2e workflow's generic copy step.

For SmartTodo, steps marked 🐙 (repository creation, rulesets, issues, pull requests, and the Phase 4 cloud agent) need a learner-owned GitHub repository. Skip them unless the run was given a disposable repository, and never create repositories, issues, or rulesets in an unrelated repository. When skipping, replace issue references with the matching phase plan, answer `grill-plan` questions with each plan's Decision Points defaults, skip all of Phase 4, fast-forward `main` from `phase-1-api` (`git switch main && git merge --ff-only phase-1-api`) after the Phase 1 gates pass so Phase 3 builds on the API, and still run every local gate: `npm run check`, the `git diff --exit-code phase1-red` check, and the checked-in verifier with `--base-url` against the local API before deployment. Run `node scripts/check-infra.mjs` before `azd up`. AIMarket (Phase 4) and Superset (Step 3) have the same pattern: the learner has the agent write `scripts/check-infra.mjs` or `scripts/check-infra-superset.mjs` from its spec before any infrastructure exists. Confirm it fails red, run the gate and the diff check (`git diff --exit-code phase4-red -- scripts/check-infra.mjs` or `git diff --exit-code HEAD -- scripts/check-infra-superset.mjs`) before `azd up`, and prove the gate works by breaking one rule on purpose (for example, an `ai-` account prefix, or one AKS node), confirming it fails, and restoring the file. When a disposable repository is provided, `setup.mjs` installs `ci.yml` and the ruleset in Phase 0, so every pull request reports the `api`, `ios`, and `infra` checks. Never enable auto-merge in the prompt that opens a pull request. Poll `gh api repos/<owner>/<repo>/pulls/<number>/reviews` until a review from `copilot-pull-request-reviewer[bot]` appears (up to 15 minutes), triage its comments with the journey's Review Triage rules (one round, one push), then enable auto-merge. Non-interactive `grill-plan` runs apply defaults and must be reported as not asked, not as an interview. When a green phase stops because red tests can't pass, read each named test; if the agent is right, delete the red tag yourself (`git tag -d phase1-red`), send the README's red-fix prompt (a new red commit that the agent tags, then green), and record it. Do the same before any triage prompt that adds tests. The workspace's TDD guard hook blocks the agent from changing frozen tests or moving red tags, and Copilot CLI loads repository hooks only in a trusted folder, so put the run directory under a trusted folder and confirm the hook blocks one test edit before Phase 1. After the stack merges, delete the three red tags before Phase 4. If `/review` ends without listing findings, resume the session with "Finish that review and list your findings, numbered, with file and line evidence." After the agent fixes a lower stack layer, `gh stack rebase` rewrites the upper layers, so move each upper red tag (`git tag -f phase2-red <rebased red commit>`). The cloud agent session stops at 30 minutes (`COPILOT_AGENT_TIMEOUT_MIN`) and discards unpushed commits; if a session ends with only a plan commit, read the run log before reassigning. Stop the local Functions host before switching branches in the workspace for Phase 3. Computer Use needs Accessibility and Screen Recording granted to the host terminal before the run; if they're missing, record it as BLOCKED and use `xcrun simctl ui` for Dark Mode and text-size checks. In Phase 4, assign the cloud agent only after Phases 1-3 are merged, approve each agent push with `gh run rerun <run-id>` (the fork approval API returns 403, and the repository setting has no API), polling every 15 seconds: the agent may end its session while CI waits for approval, so if its last comment says the run was blocked, post the failing check's error line in one `@copilot` comment, mark the draft ready for review, and remove `[WIP]` from its title before merging. To reassign the agent, unassign `copilot-swe-agent[bot]` first. Exit plan mode before `/fleet` (in `copilot -p`, resume the plan session with `--mode interactive`). Computer Use can't run under `copilot -p`; in Xcode 27 it can read but not drive the app in Device Hub (`com.apple.dt.Devices`), so drive the simulator with `xcrun simctl`. Phases 1 to 3 are one GitHub stack (`gh stack init`, `gh stack add`, `gh stack submit --auto --open`); retitle each pull request after `submit` (its title becomes the squash commit), don't request Copilot review on layers 2 and 3 (the journey reviews only Phase 1 and Phase 4; the ruleset auto-requests review only for pull requests whose base is `main`), name the pull request number in every triage prompt, leave every layer open and merge the stack once from the top after Phase 3 with `gh stack merge <phase-3-pr> --yes --squash` followed by `gh stack sync --prune` (never `gh pr merge`; merging a lower layer early retargets the next one to `main` and triggers Copilot review), and run the local API from the detached `smart-todo-api` worktree. Without a disposable repository, use plain `git switch -c` branches instead of `gh stack`. Schema changes ship with the API: it applies `src/data/migrations.ts` under `sp_getapplock` at startup. `azd pipeline config` creates `rg-<env>-msi` and subscription-scope role assignments; record their IDs and delete them explicitly during cleanup. Turn off "Require approval for workflow runs" for the cloud agent (repository Settings, Copilot, Cloud agent) so its pushes run CI without a manual approval. After Phase 3, run the journey's Verify Before Merge gate on every pull request that changes `src/api` or `infra`. When no disposable repository is provided, record journey problems in the run report instead of GitHub issues.

For SmartTodo, resolve and persist `AZURE_PRINCIPAL_ID`, `AZURE_PRINCIPAL_LOGIN`, and `AZURE_PRINCIPAL_TYPE` before `azd up`; handle interactive users and service principals separately (a service principal's `AZURE_PRINCIPAL_ID` is its application ID) and fail before provisioning if any value is unavailable. Never replace the managed-identity SQL design with SQL authentication to get past a failure. If raw Foundry resources are generated, put the model child in a nested Bicep module that runs after account creation. Name the Azure-services SQL firewall rule `AllowAzureServices` or another neutral name, never one containing the reserved word `WINDOWS`.

For WeatherView, require only `Microsoft.Web` on the normal path, use Azure Static Web Apps Free with `provider: Custom`, map `azure.yaml` service `web` to `azd-service-name: web`, and normalize unsupported Static Web Apps locations to `eastus2`. Do not accept a generated application backend, deployment token file, GitHub workflow, storage account, persistent application container, local Docker requirement, or unrelated provider registration. The documented ARM64 recovery is a conditional exception for one approved temporary publisher.

Before deploying WeatherView, record `process.platform` and `process.arch`, but do not reject ARM64 automatically. Windows 11 on ARM can run many x64 applications through emulation. Use the README recovery only after the SWA publish phase returns the documented architecture error. A temporary x64 Azure publisher requires explicit approval, secure in-memory token handling, deletion in `finally`, and an exact absence check. Never install privileged emulation silently.

For development servers:

- Start a tracked background process.
- Wait for a health endpoint or explicit ready signal.
- Run verification against the actual selected port.
- Stop only the process started by this run.

## Step 5: Build and Local Verification

Run the journey's build, lint, and tests before Azure deployment. Verification must assert behavior, not merely process exit.

For each check, record:

- Command or script
- Expected result
- Actual status and key output
- PASS, FAIL, or BLOCKED

If a check fails, make one targeted repair based on the real error and rerun the failing check. Never replace unavailable execution with plausible output.

Checked-in verifiers are the gate, so the agent must not edit them. After every prompt and repair, run `git diff --exit-code -- .github/scripts` in the clone or workspace. If a verifier changed, revert it, record the change as a FAIL of that repair, and fix the real cause. In one run, the agent moved Superset's public health check inside the cluster to get past a load balancer that dropped all public traffic.

## Step 6: Azure Deployment

Before `azd up`:

1. Register only providers required by the journey.
2. Record the `azd` environment name, intended resource-group name, expected managed resource groups, deployment tags, and names of soft-deletable resources.
3. Read the subscription ID with `az account show --query id -o tsv`, then pass that value to `azd env set AZURE_SUBSCRIPTION_ID <value>` without shell command substitution.
4. Validate generated Bicep and `azure.yaml`.
5. Confirm required host hooks and tools passed preflight.

Run `azd up` and capture its real output. Monitor long-running deployment processes rather than assuming they completed.

For Container Apps using ACR, verify all of these before the first private image deployment:

- System-assigned identity exists.
- `AcrPull` is assigned to that identity.
- The Container App registry configuration contains the ACR login server and `identity: system`.
- The deployed image architecture is compatible with `linux/amd64`.

A filtered deployment of a service declared in `azure.yaml` can skip project-level hooks, so run the documented hook directly afterward and repeat production verification. When AIMarket preflight reports `715-123420`, first check whether the Foundry account name starts with `ai-`: on some subscriptions that prefix alone fails, and `cog-` passes with the same template. AIMarket's web Container App is not an azd service; rebuild it with `node infra/hooks/postdeploy.js`, not `azd deploy web`.

## Step 7: Production Verification

Run the journey's portable verification script against live outputs. Do not stop at HTTP 200 when the journey requires data, authentication, images, or mutations.

Examples:

- Grafana: root HTTP 200 and `/api/health` reports database `ok`.
- n8n: `/healthz` HTTP 200 and owner-setup or login page renders.
- Superset: pod `1/1 Running`, `/health` HTTP 200, login succeeds with the documented selectors.
- AIMarket: 10 products, search and chat work, production API URL is baked into the frontend, and every product image loads.
- SmartTodo: the checked-in verifier passes seed read, validation errors, create, AI step generation, auto-completion, reopen, delete, and absence confirmation, first locally with `--base-url` and then against the deployment.
- WeatherView: deployed assets load, the Open-Meteo contract has exactly five aligned days, geolocation denial falls back to Seattle, city search changes location, units and theme persist after reload, and the browser reports no failed required resources.

Temporary verification records must be deleted in `finally`.

## Step 8: Screenshot Web Frontends

The runner helper uses Playwright's bundled Chromium. Do not require the branded Chrome channel, especially on Linux ARM64.

One-time runner setup from the `scripts/` directory:

```text
npm ci
npx playwright install chromium
```

Linux hosts may require the administrator-approved command `npx playwright install --with-deps chromium`. Do not run it silently.

Capture a public page:

```text
node scripts/capture-screenshot.mjs --url <url> --output <png> --fail-on-resource-errors true
```

For Superset login, additionally pass:

```text
--username admin --password <secret> --username-selector #username --password-selector #password --submit-selector "input[type='submit'], button[type='submit']" --success-path /superset/welcome/
```

Never print credentials. Visually inspect the saved image and review failed document, script, XHR, fetch, and image requests. A broken product image fails AIMarket acceptance.

Skip screenshots for API-only journeys and for iOS on Windows/Linux. A mobile screenshot is only required on a suitable Mac/Xcode host.

## Step 9: Scoped Cleanup

With the default `after-verification` policy, preserve reports and screenshots, then run:

```text
azd down --force --purge --no-prompt
```

Cleanup must use the ownership inventory recorded before deployment. Delete only the exact `azd` environment, resource groups, managed resource groups, and soft-deleted resources created by this run.

Verify cleanup with live Azure queries:

- Every recorded resource group returns not found.
- No active resource remains with the run's `azd-env-name` tag.
- Any purged soft-deletable resource is absent.
- Unrelated resource groups and deployments remain untouched.

If cleanup fails, report the exact remaining resource IDs. Never broaden deletion scope to make the report look clean.

## Step 10: Report

Write `run-report.md` and include:

- Journey, stack, host OS/architecture, and tool versions
- Source commit and workspace path
- Phase results with real pass/fail counts
- Deployment environment and owned resource groups
- Verification requests and actual outcomes
- Screenshot paths and browser resource failures
- Cleanup policy and verification result
- Remaining blockers or platform limitations

Write sanitized journey defects to that journey's `issues.md`, except for SmartTodo: file them as `known-limitation` issues when a disposable repository exists, and otherwise keep them only in `run-report.md`. Don't create `journeys/smart-todo/issues.md`. Keep shared orchestration defects in the runner issue section. Never include credentials, tokens, cookies, connection strings, SQL passwords, or authorization headers.

## Runner-Compatible Journey Checklist

- [ ] The journey prerequisite section lists every required host tool and links to OS-specific installation options.
- [ ] Commands work on Windows, Mac, and Linux, or clearly state a platform gate.
- [ ] Required hooks are JavaScript/TypeScript, not shell-specific scripts.
- [ ] Verification uses portable scripts with deterministic exit codes.
- [ ] Local ports are configurable.
- [ ] ARM64 and AMD64 image behavior is explicit.
- [ ] Browser checks use bundled Chromium rather than a branded Chrome channel.
- [ ] Dynamic values come from `azd env get-value` without shell substitution.
- [ ] Cleanup can identify and verify only the resources owned by the run.
