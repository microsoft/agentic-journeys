#!/usr/bin/env node
// Creates the SmartTodo workspace and its protected GitHub repository.
// Run from anywhere: node journeys/smart-todo/setup/setup.mjs --help

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const setupDir = path.dirname(fileURLToPath(import.meta.url));
const journeyDir = path.resolve(setupDir, '..');
const repoRoot = path.resolve(journeyDir, '..', '..');

const USAGE = `Usage: node journeys/smart-todo/setup/setup.mjs [options]

Creates the SmartTodo workspace, commits it, and (unless --local) publishes it
as a protected GitHub repository with CI.

Options:
  --workspace <path>    Workspace directory (default: ../smart-todo-workspace next to this repository)
  --repo <name>         GitHub repository name (default: smart-todo)
  --private             Create a private repository (rulesets need GitHub Pro, Team, or Enterprise)
  --start-at <phase>    Start at phase 1, 2, 3, or 4; earlier phases come from checkpoints (default: 1)
  --no-copilot-review   Leave Copilot code review out of the ruleset
  --allow-unprotected   Continue when the ruleset can't be enforced (the gates then don't block merging)
  --local               Create the local workspace only; skip everything on GitHub
  --resume              Finish the GitHub steps for an existing workspace after a failure
  --no-wait             Don't wait for the first CI run on main
  --help                Show this help
`;

function parseArgs(argv) {
  const options = {
    workspace: path.resolve(repoRoot, '..', 'smart-todo-workspace'),
    repo: 'smart-todo',
    private: false,
    startAt: 1,
    copilotReview: true,
    allowUnprotected: false,
    local: false,
    resume: false,
    wait: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) fail(`${arg} needs a value.\n\n${USAGE}`);
      index += 1;
      return next;
    };
    switch (arg) {
      case '--workspace': options.workspace = path.resolve(value()); break;
      case '--repo': options.repo = value(); break;
      case '--private': options.private = true; break;
      case '--start-at': options.startAt = Number(value()); break;
      case '--no-copilot-review': options.copilotReview = false; break;
      case '--allow-unprotected': options.allowUnprotected = true; break;
      case '--local': options.local = true; break;
      case '--resume': options.resume = true; break;
      case '--no-wait': options.wait = false; break;
      case '--help': case '-h': console.log(USAGE); process.exit(0); break;
      default: fail(`Unknown option: ${arg}\n\n${USAGE}`);
    }
  }
  if (![1, 2, 3, 4].includes(options.startAt)) fail('--start-at must be 1, 2, 3, or 4.');
  if (options.resume && options.local) fail('--resume only applies to the GitHub steps; drop --local.');
  if (!/^[A-Za-z0-9._-]+$/.test(options.repo)) fail('--repo may contain only letters, digits, ".", "_", and "-".');
  return options;
}

let recoveryHint = '';

function fail(message) {
  console.error(`FAIL ${message}`);
  if (recoveryHint) console.error(`\n${recoveryHint}`);
  process.exit(1);
}

function step(message) {
  console.log(`\n==> ${message}`);
}

function run(command, args, { cwd = repoRoot, input, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, input, encoding: 'utf8', shell: false });
  if (result.error) {
    if (allowFailure) return { ok: false, stdout: '', stderr: result.error.message };
    fail(`${command} could not start: ${result.error.message}`);
  }
  const ok = result.status === 0;
  if (!ok && !allowFailure) {
    fail(`${command} ${args.join(' ')} exited ${result.status}\n${(result.stderr || result.stdout).trim()}`);
  }
  return { ok, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

const EXCLUDED_NAMES = new Set([
  'node_modules', '.azure', 'dist', 'coverage', '.azurite', 'DerivedData', 'xcuserdata',
  '.DS_Store', 'local.settings.json',
]);
// The answer-key checkpoints and this setup folder stay out of the workspace.
const EXCLUDED_PATHS = new Set([path.join(journeyDir, 'checkpoints'), setupDir]);

function copyTree(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    filter: (item) => !EXCLUDED_NAMES.has(path.basename(item)) && !EXCLUDED_PATHS.has(path.resolve(item)),
  });
}

const GITIGNORE = `# Secrets
.env
.env.*
!.env.example
.azure/
local.settings.json

# Generated files
node_modules/
dist/
build/
coverage/
.azurite/

# Xcode
*.xcuserstate
xcuserdata/
DerivedData/
`;

function createWorkspace(workspace) {
  step(`Creating the workspace at ${workspace}`);
  if (existsSync(workspace) && readdirSync(workspace).length > 0) {
    fail(`${workspace} already exists and isn't empty. Choose another path with --workspace, or remove it first.`);
  }
  mkdirSync(workspace, { recursive: true });
  for (const relative of ['journeys/smart-todo', '.github/agents', '.github/skills', '.github/scripts', 'docs']) {
    copyTree(path.join(repoRoot, relative), path.join(workspace, relative));
  }
  mkdirSync(path.join(workspace, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    path.join(workspace, '.github', 'workflows', 'ci.yml'),
    readFileSync(path.join(setupDir, 'ci.yml'), 'utf8'),
  );
  mkdirSync(path.join(workspace, '.github', 'hooks'), { recursive: true });
  for (const file of ['tdd-guard.json', 'tdd-guard.mjs']) {
    writeFileSync(path.join(workspace, '.github', 'hooks', file), readFileSync(path.join(setupDir, 'hooks', file), 'utf8'));
  }
  writeFileSync(
    path.join(workspace, '.github', 'copilot-instructions.md'),
    readFileSync(path.join(setupDir, 'copilot-instructions.md'), 'utf8'),
  );
  writeFileSync(path.join(workspace, '.gitignore'), GITIGNORE);

  run('git', ['init', '--quiet'], { cwd: workspace });
  run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: workspace });
  run('git', ['add', '--all'], { cwd: workspace });
  commit(workspace, 'Initial SmartTodo workspace');
}

function commit(workspace, message) {
  const result = run('git', ['commit', '--quiet', '--message', message], { cwd: workspace, allowFailure: true });
  if (!result.ok) {
    fail(`git commit failed. If Git asks who you are, set user.name and user.email with git config, then rerun.\n${result.stderr}`);
  }
  console.log(`Committed: ${message}`);
}

function applyCheckpoints(workspace, startAt) {
  if (startAt === 1) return;
  step(`Adding the finished code for Phases 1 to ${startAt - 1} from checkpoints`);
  const target = path.join(workspace, 'journeys', 'smart-todo');
  for (let phase = 1; phase < startAt; phase += 1) {
    const checkpoint = path.join(journeyDir, 'checkpoints', `phase-${phase}`);
    if (phase === 2) copyTree(path.join(journeyDir, 'starter', 'ios'), path.join(target, 'src', 'ios'));
    if (existsSync(path.join(checkpoint, 'journey'))) copyTree(path.join(checkpoint, 'journey'), target);
    if (existsSync(path.join(checkpoint, 'repo'))) copyTree(path.join(checkpoint, 'repo'), workspace);
    console.log(`Applied checkpoint phase-${phase}`);
  }
  run('git', ['add', '--all'], { cwd: workspace });
  const phases = startAt === 2 ? 'Phase 1' : `Phases 1 to ${startAt - 1}`;
  commit(workspace, `Start at Phase ${startAt}: add ${phases} from checkpoints`);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function publish(options) {
  const { workspace } = options;
  step('Checking GitHub CLI sign-in');
  run('gh', ['auth', 'status']);
  const owner = run('gh', ['api', 'user', '--jq', '.login']).stdout;
  const fullName = `${owner}/${options.repo}`;
  const exists = run('gh', ['repo', 'view', fullName], { allowFailure: true }).ok;
  if (exists && !options.resume) {
    fail(`${fullName} already exists. Choose another name with --repo, or finish a failed setup with --resume.`);
  }

  if (exists) {
    step(`Resuming with the existing repository ${fullName}`);
    if (!run('git', ['remote', 'get-url', 'origin'], { cwd: workspace, allowFailure: true }).ok) {
      run('git', ['remote', 'add', 'origin', `https://github.com/${fullName}.git`], { cwd: workspace });
    }
    run('git', ['push', '--set-upstream', 'origin', 'main'], { cwd: workspace });
  } else {
    step(`Creating ${options.private ? 'private' : 'public'} repository ${fullName} and pushing main`);
    run('gh', [
      'repo', 'create', options.repo, options.private ? '--private' : '--public',
      '--source', workspace, '--remote', 'origin', '--push',
    ], { cwd: workspace });
  }
  const rerun = ['node', path.relative(process.cwd(), fileURLToPath(import.meta.url)), ...process.argv.slice(2).filter((arg) => arg !== '--resume'), '--resume'];
  recoveryHint = `The workspace and ${fullName} exist. Fix the problem above, then finish setup with:\n  ${rerun.join(' ')}\nOr start over: delete the workspace and run gh repo delete ${fullName}.`;
  run('gh', [
    'repo', 'edit', fullName,
    '--enable-auto-merge', '--enable-squash-merge', '--delete-branch-on-merge',
  ]);

  step('Creating labels');
  const labels = [
    ['phase-1', '1d76db', 'Phase 1: API'],
    ['phase-2', '5319e7', 'Phase 2: iOS app'],
    ['phase-3', '0e8a16', 'Phase 3: Azure deployment'],
    ['known-limitation', 'fbca04', 'Real issue outside the current scope, found in review'],
  ];
  for (const [name, color, description] of labels) {
    run('gh', ['label', 'create', name, '--repo', fullName, '--color', color, '--description', description, '--force']);
  }

  step('Applying the branch ruleset');
  const ruleset = JSON.parse(readFileSync(path.join(setupDir, 'ruleset.json'), 'utf8'));
  if (!options.copilotReview) {
    ruleset.rules = ruleset.rules.filter((rule) => rule.type !== 'copilot_code_review');
  }
  const existing = run('gh', ['api', `repos/${fullName}/rulesets`], { allowFailure: true });
  const match = existing.ok ? JSON.parse(existing.stdout || '[]').find((item) => item.name === ruleset.name) : undefined;
  let enforcement;
  let problem = '';
  if (match) {
    enforcement = match.enforcement;
    console.log(`Ruleset "${ruleset.name}" already exists`);
  } else {
    const created = run('gh', [
      'api', '--method', 'POST', `repos/${fullName}/rulesets`, '--input', '-',
    ], { input: JSON.stringify(ruleset), allowFailure: true });
    if (created.ok) enforcement = JSON.parse(created.stdout).enforcement;
    else problem = created.stderr || created.stdout;
  }
  const rulesetStatus = enforcement === 'active' ? 'active' : `NOT ENFORCED${enforcement ? ` (${enforcement})` : ''}`;
  console.log(`Ruleset: ${rulesetStatus}`);
  if (rulesetStatus !== 'active') {
    const why = `${problem ? `${problem}\n` : ''}Rulesets on private repositories need GitHub Pro, Team, or Enterprise. Make the repository public (gh repo edit ${fullName} --visibility public --accept-visibility-change-consequences) and rerun with --resume, or rerun with --resume --allow-unprotected to continue without enforcement.`;
    if (!options.allowUnprotected) fail(`The ruleset isn't enforced, so nothing blocks merging.\n${why}`);
    console.warn(`WARN Continuing without an enforced ruleset (--allow-unprotected). The gates still run, but they don't block merging.`);
  }

  let ciStatus = 'not checked (--no-wait)';
  if (options.wait) {
    step('Waiting for the first CI run on main (up to 10 minutes)');
    ciStatus = 'timed out';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      sleep(10_000);
      const runs = run('gh', [
        'run', 'list', '--repo', fullName, '--workflow', 'ci.yml', '--branch', 'main',
        '--limit', '1', '--json', 'status,conclusion,url',
      ], { allowFailure: true });
      const latest = runs.ok ? JSON.parse(runs.stdout || '[]')[0] : undefined;
      if (latest?.status === 'completed') {
        ciStatus = `${latest.conclusion} (${latest.url})`;
        break;
      }
    }
    console.log(`CI on main: ${ciStatus}`);
  }
  return { fullName, rulesetStatus, ciStatus };
}

const options = parseArgs(process.argv.slice(2));

step('Checking tools');
run('git', ['--version']);
if (!options.local) run('gh', ['--version']);

if (options.resume) {
  if (!existsSync(path.join(options.workspace, '.git'))) fail(`--resume needs an existing workspace at ${options.workspace}.`);
  step(`Resuming with the existing workspace at ${options.workspace}`);
} else {
  createWorkspace(options.workspace);
  applyCheckpoints(options.workspace, options.startAt);
}

let github;
if (!options.local) github = publish(options);

const workDir = path.join(options.workspace, 'journeys', 'smart-todo');
console.log('\n==> Done');
console.log(`Workspace: ${options.workspace}`);
if (github) {
  console.log(`Repository: https://github.com/${github.fullName}`);
  console.log(`Ruleset: ${github.rulesetStatus}`);
  console.log(`CI on main: ${github.ciStatus}`);
  // GitHub has no API for this setting, so the script can only remind you.
  console.log(`Before Phase 4: open https://github.com/${github.fullName}/settings, then Copilot > Cloud agent, and turn off "Require approval for workflow runs".`);
}
console.log(`\nNext: cd ${workDir} and start copilot.`);

const ciFailed = github && options.wait && !github.ciStatus.startsWith('success');
process.exit(ciFailed ? 1 : 0);
