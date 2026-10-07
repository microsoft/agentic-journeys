# SmartTodo

Instructions for every Copilot session in this repository. Phase 4 adds a "Definition of Done" section.

## Map

- `journeys/smart-todo/PLAN.md`: the vision, the quality gates, CI, review triage, and the stack of pull requests. The phase plans are `PLAN-phase1-api.md` to `PLAN-phase4-factory.md` in the same folder.
- `journeys/smart-todo/src/api`: the Azure Functions API (Node.js, TypeScript, and Vitest).
- `journeys/smart-todo/src/ios`: the SwiftUI app, which starts as a copy of `starter/ios`.
- `journeys/smart-todo/infra`, `azure.yaml`, and `scripts/`: the infrastructure and its gates.
- `.github/scripts/verify-smart-todo.mjs`: the checked-in black-box verifier.

## Workflow

- The plans are the source of truth. Update the plan section before you change behavior.
- Use the `grill-plan` skill before code exists, and the `tdd-builder` agent for the red and green phases.
- Red: commit only failing tests and the stubs they need. Green: make the tests pass without changing them.
- Work is done only when the commands in the "Quality Gates" section of `journeys/smart-todo/PLAN.md` exit `0`. Run each command from the directory that the section names.
- Phases 1 to 3 are one stack of pull requests that `gh stack` manages in the current checkout. Don't put stack layers in separate worktrees. Don't merge pull requests; the human merges them.

## Protected files

The hook in `.github/hooks/tdd-guard.json` blocks changes to these files:

- Tests that a red tag (`phase1-red`, `phase2-red`, or `phase3-red`) freezes. If a frozen test is wrong, stop and report it. Never move or delete a red tag; the human does that.
- `.github/hooks/`, `.github/scripts/verify-smart-todo.mjs`, `journeys/smart-todo/scripts/test-ios.mjs`, and `journeys/smart-todo/starter/`.

## Always

- Never commit or print secrets, `local.settings.json`, or `.azure/`.
- Commands must work in PowerShell, Command Prompt, bash, and zsh. Don't use shell command substitution.
- List problems that you hit and fixed in the pull request description, under "Problems and fixes".
