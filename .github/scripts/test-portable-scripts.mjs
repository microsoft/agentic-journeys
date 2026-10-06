#!/usr/bin/env node
// Runs the repository's portable scripts on the current OS without Azure or Copilot
// credentials: prompt extraction, workspace creation, SmartTodo setup, the SmartTodo
// infrastructure gate, and the journey-runner helpers. CI runs it on Linux, Windows,
// and macOS; you can run it locally with `node .github/scripts/test-portable-scripts.mjs`.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runner = join(root, '.github', 'skills', 'journey-runner', 'scripts');
const temp = mkdtempSync(join(tmpdir(), 'portable-scripts-'));
const results = [];

function run(command, args, options = {}) {
  // .cmd shims such as az.cmd need a shell on Windows; arguments here contain no shell syntax.
  const shell = process.platform === 'win32' && !['node', 'git'].includes(command);
  const result = spawnSync(command, args, { cwd: options.cwd ?? root, encoding: 'utf8', shell, env: { ...process.env, ...options.env } });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, error: result.error };
}

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function scripts(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : scripts(path);
    return entry.name.endsWith('.mjs') ? [path] : [];
  });
}

console.log(`Platform: ${process.platform} ${process.arch}, Node ${process.version}`);

check('every checked-in .mjs script parses', () => {
  const files = [join(root, '.github', 'scripts'), runner, join(root, 'journeys', 'smart-todo', 'setup'), join(root, 'journeys', 'smart-todo', 'scripts')]
    .flatMap(scripts);
  const bad = files.filter((file) => run('node', ['--check', file]).status !== 0);
  expect(bad.length === 0, `syntax errors in ${bad.join(', ')}`);
});

const journeys = readdirSync(join(root, 'journeys'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
for (const journey of journeys) {
  check(`extract-prompts finds prompts in ${journey}`, () => {
    const out = join(temp, 'prompts', journey);
    const result = run('node', [join(runner, 'extract-prompts.mjs'), '--readme', join(root, 'journeys', journey, 'README.md'), '--out', out]);
    expect(result.status === 0, result.output);
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index.length >= 3, `only ${index.length} prompts`);
  });
}

for (const journey of ['weather-view', 'aimarket']) {
  check(`create-workspace builds a committed ${journey} workspace`, () => {
    const workspace = join(temp, `${journey}-workspace`);
    const result = run('node', [join(root, '.github', 'scripts', 'create-workspace.mjs'), journey, '--workspace', workspace]);
    expect(result.status === 0, result.output);
    expect(existsSync(join(workspace, 'journeys', journey, 'PLAN.md')), 'PLAN.md missing');
    const ignore = readFileSync(join(workspace, '.gitignore'), 'utf8');
    for (const pattern of ['.azure/', '*.db', '*.db-wal', '*.db-shm', 'node_modules/']) expect(ignore.includes(pattern), `.gitignore lacks ${pattern}`);
    expect(run('git', ['-C', workspace, 'status', '--porcelain']).output.trim() === '', 'workspace has uncommitted files');
  });
}

check('SmartTodo setup.mjs --local creates a workspace', () => {
  const workspace = join(temp, 'smart-todo-workspace');
  const result = run('node', [join(root, 'journeys', 'smart-todo', 'setup', 'setup.mjs'), '--local', '--workspace', workspace]);
  expect(result.status === 0, result.output);
  expect(existsSync(join(workspace, 'journeys', 'smart-todo', 'PLAN.md')), 'PLAN.md missing');
  expect(existsSync(join(workspace, 'journeys', 'smart-todo', 'src', 'ios')) || existsSync(join(workspace, 'journeys', 'smart-todo', 'starter', 'ios')), 'iOS starter missing');
  expect(existsSync(join(workspace, '.github', 'hooks', 'tdd-guard.json')) && existsSync(join(workspace, '.github', 'hooks', 'tdd-guard.mjs')), 'TDD guard hook missing');
  expect(existsSync(join(workspace, '.github', 'copilot-instructions.md')), 'starter copilot-instructions.md missing');
});

check('SmartTodo TDD guard hook freezes tests while a red tag exists', () => {
  const repo = join(temp, 'tdd-guard-repo');
  const api = join(repo, 'journeys', 'smart-todo', 'src', 'api');
  mkdirSync(join(api, 'test'), { recursive: true });
  mkdirSync(join(repo, '.github', 'hooks'), { recursive: true });
  writeFileSync(join(api, 'test', 'a.test.ts'), 'test\n');
  writeFileSync(join(api, 'index.ts'), 'code\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']]) {
    expect(run('git', args, { cwd: repo }).status === 0, `git ${args[0]} failed`);
  }
  const hook = join(root, 'journeys', 'smart-todo', 'setup', 'hooks', 'tdd-guard.mjs');
  const decide = (toolName, toolArgs, cwd = repo) => {
    const result = spawnSync('node', [hook], { cwd: repo, encoding: 'utf8', input: JSON.stringify({ cwd, toolName, toolArgs: JSON.stringify(toolArgs) }) });
    expect(result.status === 0, `hook exited ${result.status}: ${result.stderr}`);
    return result.stdout.includes('"deny"') ? 'deny' : 'allow';
  };
  const testFile = 'journeys/smart-todo/src/api/test/a.test.ts';
  const cases = [
    ['edit', { path: join(repo, testFile) }, repo, 'allow', 'test edit before the red tag'],
    ['edit', { path: join(repo, '.github', 'hooks', 'tdd-guard.json') }, repo, 'deny', 'hook edit'],
  ];
  const verify = ([tool, args, cwd, expected, label]) => expect(decide(tool, args, cwd) === expected, `${label}: expected ${expected}`);
  cases.forEach(verify);
  expect(run('git', ['tag', 'phase1-red'], { cwd: repo }).status === 0, 'tag failed');
  [
    ['edit', { path: join(repo, testFile) }, repo, 'deny', 'test edit after the red tag'],
    ['create', { path: 'journeys/smart-todo/src/api/test/new.test.ts' }, repo, 'deny', 'new test file'],
    ['edit', { path: join(api, 'index.ts') }, repo, 'allow', 'code edit'],
    ['view', { path: join(repo, testFile) }, repo, 'allow', 'view'],
    ['apply_patch', `*** Begin Patch\n*** Update File: ${testFile}\n*** End Patch`, repo, 'deny', 'apply_patch'],
    ['bash', { command: 'git tag -d phase1-red' }, repo, 'deny', 'tag delete'],
    ['bash', { command: 'git tag -f phase1-red HEAD' }, repo, 'deny', 'tag move'],
    ['bash', { command: 'git -C .. tag --delete phase2-red' }, repo, 'deny', 'tag delete with -C'],
    ['bash', { command: 'npx vitest run test/a.test.ts 2>&1 | tail -20' }, api, 'allow', 'run tests'],
    ['bash', { command: 'git diff --exit-code phase1-red -- src/api/test' }, api, 'allow', 'diff gate'],
    ['bash', { command: `cat ${testFile} > ${join(temp, 'copy.txt')}` }, repo, 'allow', 'read a test'],
    ['bash', { command: `echo x > ${testFile}` }, repo, 'deny', 'redirect into a test'],
    ['bash', { command: 'cd journeys/smart-todo/src/api && sed -i.bak s/a/b/ test/a.test.ts' }, repo, 'deny', 'sed -i after cd'],
    ['bash', { command: 'rm -rf journeys/smart-todo/src/api/test' }, repo, 'deny', 'rm'],
    ['bash', { command: `git checkout phase1-red -- ${testFile}` }, repo, 'allow', 'restore from the red tag'],
    ['bash', { command: `git checkout main -- ${testFile}` }, repo, 'deny', 'checkout from another ref'],
    ['bash', { command: `node -e "require('fs').writeFileSync('src/api/test/a.test.ts', 'x')"` }, repo, 'deny', 'inline write'],
    ['powershell', { command: `Set-Content -Path ${testFile} -Value x` }, repo, 'deny', 'Set-Content'],
    ['powershell', { command: 'npm run check' }, api, 'allow', 'PowerShell gate'],
  ].forEach(verify);
});

check('SmartTodo checkpoint passes its offline infrastructure gate', () => {
  if (run('az', ['version']).status !== 0) throw new Error('Azure CLI is not installed');
  const cwd = join(root, 'journeys', 'smart-todo', 'checkpoints', 'phase-3', 'journey');
  const result = run('node', ['scripts/check-infra.mjs', '--offline'], { cwd });
  expect(result.status === 0, result.output.split('\n').filter((line) => line.startsWith('FAIL')).join('; ') || result.output);
});

check('check-prerequisites passes for node and git', () => {
  const result = run('node', [join(runner, 'check-prerequisites.mjs'), '--required', 'node,git']);
  expect(result.status === 0, result.output);
});

check('run-command records a step and summarize-run reports it', () => {
  const record = join(temp, 'timing.jsonl');
  const result = run('node', [join(runner, 'run-command.mjs'), '--label', 'node version', '--record', record, '--', 'node', '--version']);
  expect(result.status === 0, result.output);
  const summary = run('node', [join(runner, 'summarize-run.mjs'), '--record', record]);
  expect(summary.status === 0 && summary.output.includes('node version'), summary.output);
});

check('run-copilot-prompt validates its options without starting Copilot', () => {
  const help = run('node', [join(runner, 'run-copilot-prompt.mjs'), '--help']);
  expect(help.status === 0 && help.output.includes('--azure-mcp'), help.output);
  const bad = run('node', [join(runner, 'run-copilot-prompt.mjs'), '--prompt-file', join(root, 'README.md'), '--azure-mcp', 'bogus']);
  expect(bad.status === 2, `expected exit 2, got ${bad.status}`);
});

rmSync(temp, { recursive: true, force: true });
const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
