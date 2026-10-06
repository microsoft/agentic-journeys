#!/usr/bin/env node
// Runs one journey end to end without a person at the keyboard: README prompts through
// run-copilot-prompt.mjs, the journey's gates and checked-in verifier, `azd up` with one
// "When something fails" repair, and `azd down --force --purge` in a finally block.
//
// Usage: node run-journey.mjs <grafana|n8n|superset|weather-view|aimarket|smart-todo>
//          [--run-dir <dir>] [--location westus] [--keep]
//
// It needs Node.js LTS, git, az, azd, and Copilot CLI signed in (COPILOT_GITHUB_TOKEN works),
// plus `azd config set auth.useAzCliAuth true`. SmartTodo also needs func and sqlcmd.
// Steps that need an interactive session (/rewind, /fork, /delegate), a disposable GitHub
// repository (SmartTodo 🐙 steps, AIMarket's cloud agent), or Xcode are skipped and listed
// in the report. Results go to <run-dir>/run-report.md; logs are redacted in <run-dir>/logs.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scripts, '..', '..', '..', '..');
const args = process.argv.slice(2);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i === -1 ? fallback : args[i + 1]; };
const journey = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const JOURNEYS = ['grafana', 'n8n', 'superset', 'weather-view', 'aimarket', 'smart-todo'];
const cleanupOnly = args.includes('--cleanup-only');
if (!JOURNEYS.includes(journey) && !cleanupOnly) {
  console.error(`Usage: node run-journey.mjs <${JOURNEYS.join('|')}> [--run-dir <dir>] [--location westus] [--keep]\n       node run-journey.mjs --cleanup-only --run-dir <dir>`);
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
const runDir = resolve(value('--run-dir', join(tmpdir(), 'journey-runs', `${journey}-${stamp}`)));
const location = value('--location', 'westus');
const keep = args.includes('--keep');
const isWindows = process.platform === 'win32';
const logDir = join(runDir, 'raw-logs');
const record = join(runDir, 'timing.jsonl');
mkdirSync(logDir, { recursive: true });

const results = [];
const notes = [];
const azdProjects = new Set();
const background = [];
const sessions = {};
let promptIndex;
let gitRoot;
let stepCount = 0;

function log(line) {
  console.log(line);
  appendFileSync(join(runDir, 'progress.log'), `${new Date().toISOString()} ${line}\n`);
}
function result(name, ok, detail = '') {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}
function note(text) { notes.push(text); log(`NOTE ${text}`); }
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// --- process helpers --------------------------------------------------------------------

function quote(arg) {
  return /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}
function invocation(command, commandArgs) {
  if (command === 'node') return { file: process.execPath, args: commandArgs, shell: false };
  // .cmd shims (azd, az, npm, npx, func) need a shell on Windows. Arguments here are fixed
  // by this script, never prompt text, so simple quoting is enough.
  if (isWindows && command !== 'git') return { file: [command, ...commandArgs].map(quote).join(' '), args: [], shell: true };
  return { file: command, args: commandArgs, shell: false };
}

function cmd(label, command, commandArgs, { cwd, env, allowFail = false, timeoutMinutes = 60 } = {}) {
  const file = join(logDir, `${String(++stepCount).padStart(2, '0')}-${slug(label)}.log`);
  const started = Date.now();
  const inv = invocation(command, commandArgs);
  const out = spawnSync(inv.file, inv.args, { cwd, env: { ...process.env, ...env }, shell: inv.shell, encoding: 'utf8', timeout: timeoutMinutes * 60000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const output = `${out.stdout ?? ''}${out.stderr ?? ''}${out.error ? `\n${out.error.message}` : ''}`;
  writeFileSync(file, `$ ${command} ${commandArgs.join(' ')} (cwd ${cwd})\n${output}\n--- exit ${out.status} ---\n`);
  appendFileSync(record, `${JSON.stringify({ label, kind: 'command', started: new Date(started).toISOString(), seconds: Math.round((Date.now() - started) / 1000), exit: out.status })}\n`);
  if (out.status !== 0 && !allowFail) throw new Error(`${label} failed (exit ${out.status}); see ${file}`);
  return { status: out.status, output, file };
}

// The SmartTodo TDD guard hook blocks the agent from changing tests while a red tag exists,
// so the runner deletes the tag first, as the learner does. If the agent made no new red
// commit and didn't tag one, put the tag back where it was.
function unlockTests(tag, cwd) {
  const old = cmd(`unlock tests (git tag -d ${tag})`, 'git', ['rev-parse', `refs/tags/${tag}`], { cwd }).output.trim();
  cmd(`delete ${tag}`, 'git', ['tag', '-d', tag], { cwd });
  return old;
}
function relockTests(tag, old, cwd) {
  if (cmd(`check ${tag}`, 'git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { cwd, allowFail: true }).status === 0) return;
  note(`the agent didn't tag a new red commit, so ${tag} went back to ${old.slice(0, 7)}`);
  cmd(`restore ${tag}`, 'git', ['tag', tag, old], { cwd });
}

function startBackground(label, command, commandArgs, { cwd, env } = {}) {
  const file = join(logDir, `bg-${slug(label)}.log`);
  const inv = invocation(command, commandArgs);
  const child = spawn(inv.file, inv.args, { cwd, env: { ...process.env, ...env }, shell: inv.shell, detached: !isWindows, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (d) => { try { appendFileSync(file, d); } catch {} };
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  child.on('error', (error) => write(`\n${error.message}\n`));
  child.done = new Promise((done) => child.on('close', (code) => done(code)));
  background.push(child);
  return child;
}
function stopBackground() {
  for (const child of background.splice(0)) {
    if (child.exitCode !== null) continue;
    if (isWindows) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  }
}
async function waitForUrl(url, minutes = 3) {
  const deadline = Date.now() + minutes * 60000;
  while (Date.now() < deadline) {
    try { const res = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (res.status < 500) return res.status; } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${url} didn't respond within ${minutes} minutes`);
}

// --- prompts ----------------------------------------------------------------------------

function loadPrompts(readme) {
  const out = join(runDir, 'prompts');
  cmd('extract prompts', 'node', [join(scripts, 'extract-prompts.mjs'), '--readme', readme, '--out', out]);
  promptIndex = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')).map((p) => ({ ...p, text: readFileSync(join(out, p.file), 'utf8') }));
}

function prompt(match, { cwd, session = 'main', agent, mode, fill = {}, extra = '', label, minutes = 60 } = {}) {
  let text;
  if (match.startsWith('=')) text = match.slice(1);
  else {
    const found = promptIndex.filter((p) => p.text.startsWith(match));
    if (found.length !== 1) throw new Error(`README prompt starting "${match}" matched ${found.length} prompts`);
    text = found[0].text.trim();
  }
  if (text.startsWith('/autopilot ')) { text = text.slice('/autopilot '.length); mode = 'autopilot'; }
  // Prompts wrap across lines, so a fill phrase matches any run of whitespace.
  for (const [from, to] of Object.entries(fill)) {
    const pattern = from.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    text = text.replace(new RegExp(pattern, 'g'), to);
  }
  if (extra) text = `${text}\n${extra}`;
  const name = label ?? slug(text.split('\n')[0]);
  const file = join(runDir, 'prompts-used', `${String(++stepCount).padStart(2, '0')}-${name}.txt`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${text}\n`);
  const sessionFile = join(runDir, `session-${session}.txt`);
  const flags = ['--prompt-file', file, '--cwd', cwd, '--allow-dir', gitRoot, '--allow-all-tools', '--allow-all-urls', '--allow-skill-dirs',
    '--timeout-minutes', String(minutes), '--label', name, '--log', join(logDir, `${String(stepCount).padStart(2, '0')}-${name}.log`),
    '--record', record, '--session-out', sessionFile];
  if (existsSync(sessionFile)) flags.push('--resume-from', sessionFile);
  if (agent) flags.push('--agent', agent);
  if (mode) flags.push('--mode', mode);
  if (mode === 'autopilot') flags.push('--max-autopilot-continues', '10');
  log(`PROMPT [${session}] ${text.split('\n')[0].slice(0, 90)}`);
  const out = spawnSync(process.execPath, [join(scripts, 'run-copilot-prompt.mjs'), ...flags], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const logText = readFileSync(join(logDir, `${String(stepCount).padStart(2, '0')}-${name}.log`), 'utf8');
  try { writeRedactedLogs(); } catch {}
  if (out.status !== 0) throw new Error(`prompt "${name}" exited ${out.status}`);
  checkVerifiers(`after "${name}"`);
  return logText.slice(logText.indexOf('--- output ---'));
}

// The agent never changes the checked-in verifiers.
function checkVerifiers(when) {
  const diff = spawnSync('git', ['-C', gitRoot, 'diff', '--name-only', '--', '.github/scripts'], { encoding: 'utf8' }).stdout.trim();
  if (diff) {
    spawnSync('git', ['-C', gitRoot, 'checkout', '--', '.github/scripts']);
    result(`verifiers unchanged ${when}`, false, `agent edited ${diff.replace(/\n/g, ', ')}; reverted`);
  }
}

// --- Azure ------------------------------------------------------------------------------

function redactTail(text, lines = 40) {
  return redact(text.split('\n').filter((l) => l.trim()).slice(-lines).join('\n'));
}

// Runs azd up; on failure, sends the README's "When something fails" prompt once and retries.
function azdUp({ cwd, session = 'main', agent, phase = 'Deploy' }) {
  azdProjects.add(cwd);
  let up = cmd('azd up', 'azd', ['up', '--no-prompt'], { cwd, allowFail: true, timeoutMinutes: 75 });
  if (up.status === 0) return result('azd up', true);
  // Azure can take a minute or two to index a new resource's tags; retry the publish, as the troubleshooting section says.
  for (let attempt = 1; attempt <= 3 && /unable to find a resource tagged/i.test(up.output); attempt++) {
    note(`azd up looked the service up before Azure indexed its tags; waited and ran azd deploy (attempt ${attempt})`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 45000);
    up = cmd(`azd deploy (tag race ${attempt})`, 'azd', ['deploy', '--no-prompt'], { cwd, allowFail: true, timeoutMinutes: 30 });
    if (up.status === 0) return result('azd up (after azd deploy)', true);
  }
  result('azd up (first attempt)', false, 'sending the "When something fails" prompt');
  const shell = isWindows ? 'Windows PowerShell' : process.platform === 'darwin' ? 'macOS zsh' : 'Linux bash';
  prompt(`=The following command failed during ${phase} on ${shell}:\n\nazd up\n\nRelevant error output:\n\n${redactTail(up.output)}\n\nInspect the relevant application and Azure logs, explain the root cause,\nmake the smallest safe fix, rerun the failed step, and run the journey\nverifier. Don't change the checked-in verifier. Record the issue and\nresolution in issues.md. Do not print secrets.`, { cwd, session, agent, label: 'when-something-fails', minutes: 90 });
  up = cmd('azd up (after repair)', 'azd', ['up', '--no-prompt'], { cwd, allowFail: true, timeoutMinutes: 75 });
  result('azd up (after repair)', up.status === 0);
  if (up.status !== 0) throw new Error('azd up failed after one repair');
}

function azdValue(cwd, name) {
  const out = cmd(`azd env get-value ${name}`, 'azd', ['env', 'get-value', name], { cwd, allowFail: true });
  return out.status === 0 ? out.output.trim().split('\n').pop().trim() : undefined;
}

function gate(label, command, commandArgs, opts) {
  const out = cmd(label, command, commandArgs, { ...opts, allowFail: true });
  const last = out.output.trim().split('\n').filter((l) => /PASS|FAIL|passed|failed/i.test(l)).pop() ?? '';
  result(label, out.status === 0, last.slice(0, 200));
  // Gates written before the output rule may hide why azd failed; capture it for the report.
  if (out.status !== 0 && /FAIL[^\n]*preview/i.test(out.output) && opts?.cwd) {
    const preview = cmd('azd provision --preview (diagnostic)', 'azd', ['provision', '--preview', '--no-prompt'], { cwd: opts.cwd, allowFail: true, timeoutMinutes: 20 });
    note(`preview diagnostic: ${redactTail(preview.output, 6).replace(/\n/g, ' / ').slice(0, 400)}`);
  }
  if (out.status !== 0 && !opts?.soft) throw new Error(`${label} failed`);
  return out;
}

function cleanup() {
  stopBackground();
  for (const cwd of azdProjects) {
    if (!existsSync(join(cwd, '.azure'))) continue;
    const envs = cmd('azd env list', 'azd', ['env', 'list', '--output', 'json'], { cwd, allowFail: true });
    let names = [];
    try { names = JSON.parse(envs.output.slice(envs.output.indexOf('['))).map((e) => e.Name); } catch {}
    for (const name of names) {
      const down = cmd(`azd down ${name}`, 'azd', ['down', '--force', '--purge', '--no-prompt', '--environment', name], { cwd, allowFail: true, timeoutMinutes: 45 });
      const left = cmd(`resources left for ${name}`, 'az', ['resource', 'list', '--tag', `azd-env-name=${name}`, '--query', 'length(@)', '-o', 'tsv'], { cwd, allowFail: true });
      const groups = cmd(`groups left for ${name}`, 'az', ['group', 'list', '--tag', `azd-env-name=${name}`, '--query', 'length(@)', '-o', 'tsv'], { cwd, allowFail: true });
      // A preview creates an empty tagged resource group that `azd down` can miss; delete it by tag.
      if (Number(groups.output.trim() || 0) > 0 && Number(left.output.trim() || 0) === 0) {
        const names = cmd(`empty groups for ${name}`, 'az', ['group', 'list', '--tag', `azd-env-name=${name}`, '--query', '[].name', '-o', 'tsv'], { cwd, allowFail: true });
        for (const group of names.output.trim().split(/\s+/).filter(Boolean)) cmd(`delete empty group ${group}`, 'az', ['group', 'delete', '--name', group, '--yes'], { cwd, allowFail: true, timeoutMinutes: 20 });
      }
      const groupsAfter = cmd(`groups left for ${name} (final)`, 'az', ['group', 'list', '--tag', `azd-env-name=${name}`, '--query', 'length(@)', '-o', 'tsv'], { cwd, allowFail: true });
      const remaining = Number(left.output.trim() || 0) + Number(groupsAfter.output.trim() || 0);
      // What counts is what's left in Azure: azd down also exits nonzero when a run already deleted everything.
      result(`cleanup ${name}`, remaining === 0, `${remaining} tagged resources or groups remain${down.status === 0 ? '' : ` (azd down exited ${down.status})`}`);
    }
  }
}

// --- workspaces -------------------------------------------------------------------------

function cloneRepo() {
  const dest = join(runDir, 'repo');
  cmd('clone repository', 'git', ['clone', '--quiet', '--no-local', repoRoot, dest]);
  gitRoot = dest;
  azdProjects.add(dest);
  return dest;
}
function createWorkspace(name) {
  const workspace = join(runDir, 'workspace');
  cmd(`create ${name} workspace`, 'node', [join(repoRoot, '.github', 'scripts', 'create-workspace.mjs'), name, '--workspace', workspace]);
  gitRoot = workspace;
  azdProjects.add(join(workspace, 'journeys', name));
  return join(workspace, 'journeys', name);
}
function commitAll(cwd, message) {
  cmd(`git add (${message})`, 'git', ['add', '--all'], { cwd });
  cmd(`git commit (${message})`, 'git', ['commit', '--quiet', '--allow-empty', '-m', message], { cwd, allowFail: true });
}

// --- recipes ----------------------------------------------------------------------------

const oss = 'oss-to-azure-deployer';

const recipes = {
  async grafana() {
    const cwd = cloneRepo();
    loadPrompts(join(cwd, 'journeys', 'grafana', 'README.md'));
    prompt('Plan a Grafana deployment', { cwd, agent: oss });
    prompt('Should I use PostgreSQL', { cwd, agent: oss });
    prompt('Generate the infrastructure for that plan: Bicep in infra-grafana', { cwd, agent: oss });
    azdUp({ cwd, agent: oss });
    gate('verify-grafana.mjs', 'node', ['.github/scripts/verify-grafana.mjs'], { cwd });
    prompt('Verify the Grafana deployment', { cwd, agent: oss });
    prompt('Create scripts/create-grafana-dashboard.mjs', { cwd, agent: oss });
    const url = azdValue(cwd, 'GRAFANA_URL');
    const password = azdValue(cwd, 'GRAFANA_ADMIN_PASSWORD');
    const res = await fetch(`${url}/api/search?query=Hello%20from%20Azure`, { headers: { authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` } });
    const found = res.ok && (await res.json()).some((d) => d.title === 'Hello from Azure');
    result('dashboard "Hello from Azure" exists', found);
  },

  async n8n() {
    const cwd = cloneRepo();
    loadPrompts(join(cwd, 'journeys', 'n8n', 'README.md'));
    prompt('Plan an n8n deployment', { cwd, agent: oss });
    prompt('Generate the infrastructure for that plan: Bicep in infra-n8n', { cwd, agent: oss });
    azdProjects.add(cwd);
    log('azd up runs in the background while the agent builds the workflow, as the README directs');
    const up = startBackground('azd up', 'azd', ['up', '--no-prompt'], { cwd });
    prompt('My azd up is running in another terminal', { cwd, agent: oss });
    prompt('Why does the liveness probe', { cwd, agent: oss });
    prompt('What does the post-provision hook do', { cwd, agent: oss });
    const code = await up.done;
    if (code !== 0) azdUp({ cwd, agent: oss });
    else result('azd up', true);
    gate('verify-n8n.mjs', 'node', ['.github/scripts/verify-n8n.mjs'], { cwd });
    prompt('Verify the n8n deployment', { cwd, agent: oss });
    // Step 6: owner account and API key through n8n's own endpoints, as a learner does in the UI.
    const base = azdValue(cwd, 'N8N_URL');
    const password = `A1a${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('hex')}`;
    const owner = await fetch(`${base}/rest/owner/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'runner@example.com', firstName: 'Journey', lastName: 'Runner', password }) });
    const cookie = owner.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const scopes = await (await fetch(`${base}/rest/api-keys/scopes`, { headers: { cookie } })).json();
    const key = await (await fetch(`${base}/rest/api-keys`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'journey-runner', scopes: scopes.data, expiresAt: null }) })).json();
    const run = cmd('run-n8n-workflow.mjs', 'node', ['scripts/run-n8n-workflow.mjs'], { cwd, env: { N8N_API_KEY: key.data?.rawApiKey ?? key.data?.apiKey }, allowFail: true });
    result('workflow returns a line of GitHub Zen', run.status === 0 && run.output.trim().length > 0, run.output.trim().split('\n').pop()?.slice(0, 80));
  },

  async superset() {
    const cwd = cloneRepo();
    loadPrompts(join(cwd, 'journeys', 'superset', 'README.md'));
    prompt('Plan an Apache Superset deployment', { cwd, agent: oss });
    prompt('Create scripts/check-infra-superset.mjs', { cwd, agent: oss });
    const red = cmd('gate red (before infrastructure)', 'node', ['scripts/check-infra-superset.mjs', '--offline'], { cwd, allowFail: true });
    result('gate fails before infrastructure exists', red.status !== 0);
    prompt('Generate the infrastructure for that plan: Bicep and Kubernetes', { cwd, agent: oss });
    gate('check-infra-superset --offline', 'node', ['scripts/check-infra-superset.mjs', '--offline'], { cwd });
    gate('check-infra-superset (with preview)', 'node', ['scripts/check-infra-superset.mjs'], { cwd });
    gate('gate script unchanged since committed', 'git', ['diff', '--exit-code', 'HEAD', '--', 'scripts/check-infra-superset.mjs'], { cwd });
    azdUp({ cwd, agent: oss });
    gate('verify-superset.mjs', 'node', ['../../.github/scripts/verify-superset.mjs'], { cwd: join(cwd, 'journeys', 'superset') });
    prompt('Verify the Superset deployment', { cwd, agent: oss });
    note('Step 4 /fork is interactive-only and was skipped');
  },

  async 'weather-view'() {
    const cwd = createWorkspace('weather-view');
    loadPrompts(join(cwd, 'README.md'));
    prompt('@PLAN.md Plan how', { cwd, session: 'p1', mode: 'plan' });
    prompt('Build the app shell you just planned', { cwd, session: 'p1', mode: 'interactive' });
    prompt('Read "Primary User Flow,"', { cwd, session: 'p1' });
    note('Phase 1 /rewind exercise is interactive-only and was skipped');
    prompt('Read "Local Tooling and Tests"', { cwd, session: 'p2' });
    cmd('playwright install chromium', 'npx', ['playwright', 'install', 'chromium'], { cwd, allowFail: true });
    gate('npm test', 'npm', ['test'], { cwd });
    gate('npm run test:e2e', 'npm', ['run', 'test:e2e'], { cwd });
    prompt('Create scripts/verify-app.mjs', { cwd, session: 'p2' });
    startBackground('local server', 'npm', ['start'], { cwd, env: { PORT: '4173' } });
    await waitForUrl('http://localhost:4173/');
    gate('verify-app.mjs (local)', 'node', ['scripts/verify-app.mjs', '--base-url', 'http://localhost:4173'], { cwd });
    stopBackground();
    prompt('/review Review the completed WeatherView', { cwd, session: 'p2' });
    prompt('Fix the high-confidence correctness, accessibility, security, and', { cwd, session: 'p2' });
    gate('npm test (after fixes)', 'npm', ['test'], { cwd });
    gate('npm run test:e2e (after fixes)', 'npm', ['run', 'test:e2e'], { cwd });
    prompt('Confirm whether the Azure Skills plugin', { cwd, session: 'p3' });
    prompt('Read the "Azure Deployment" section in PLAN.md', { cwd, session: 'p3' });
    prompt('Prepare this WeatherView azd environment', { cwd, session: 'p3' });
    reviewUntilReady(() => prompt('Use Azure Skills to perform a read-only pre-deployment review', { cwd, session: 'p3' }),
      () => prompt('=Fix only the failed checks from that review, then rerun the same read-only review.', { cwd, session: 'p3', label: 'fix-failed-checks' }));
    azdUp({ cwd, session: 'p3' });
    gate('verify-weather-view.mjs', 'node', ['../../.github/scripts/verify-weather-view.mjs'], { cwd });
    prompt('Create scripts/verify-deployed-browser.mjs', { cwd, session: 'p3' });
    gate('verify-deployed-browser.mjs', 'node', ['scripts/verify-deployed-browser.mjs'], { cwd });
  },

  async aimarket() {
    const cwd = createWorkspace('aimarket');
    loadPrompts(join(cwd, 'README.md'));
    prompt('Read PLAN.md and PLAN-phase1-api.md', { cwd, session: 'p1' });
    prompt('Read the "Data Access Layer"', { cwd, session: 'p1', fill: { '[YOUR LANGUAGE]': 'Node.js with TypeScript' } });
    prompt('Show me how tags are stored', { cwd, session: 'p1' });
    prompt('Create route handlers for products', { cwd, session: 'p1' });
    const api = join(cwd, 'api');
    cmd('api npm install', 'npm', ['install'], { cwd: api });
    cmd('api npm run build', 'npm', ['run', 'build'], { cwd: api });
    startBackground('api', 'npm', ['start'], { cwd: api, env: { PORT: '3100' } });
    await waitForUrl('http://localhost:3100/api/health');
    const products = await (await fetch('http://localhost:3100/api/products')).json();
    const count = Array.isArray(products) ? products.length : products.data?.length;
    result('local API lists 10 products', count === 10, `${count} products`);
    stopBackground();
    prompt('Create a React frontend for AIMarket', { cwd, session: 'p2', fill: { '[YOUR API PORT]': '3000' } });
    prompt('Create a way to start both', { cwd, session: 'p2' });
    prompt('Add Playwright end-to-end tests', { cwd, session: 'p2' });
    cmd('npm install (root)', 'npm', ['install'], { cwd, allowFail: true });
    cmd('playwright install chromium', 'npx', ['playwright', 'install', 'chromium'], { cwd, allowFail: true });
    gate('npm run test:e2e', 'npm', ['run', 'test:e2e'], { cwd });
    note('Phase 2 Step 4 (push) and Phase 3 cloud agent need a disposable GitHub repository; used Option A (build the assistant locally)');
    prompt('Add Azure AI Search integration', { cwd, session: 'p3' });
    prompt('Locate the generated AIMarket files', { cwd, session: 'p3' });
    prompt('Create the AI shopping assistant for AIMarket. Read the', { cwd, session: 'p3' });
    prompt('/review Review the completed AIMarket', { cwd, session: 'p3' });
    prompt('Fix the high-confidence correctness, security, and reliability', { cwd, session: 'p3' });
    commitAll(cwd, 'Phases 1-3');
    prompt('Create scripts/check-infra.mjs exactly as the "Infrastructure Gate"', { cwd, session: 'p4' });
    const red = cmd('gate red (before infrastructure)', 'node', ['scripts/check-infra.mjs', '--offline'], { cwd, allowFail: true });
    result('gate fails before infrastructure exists', red.status !== 0);
    prompt('Read PLAN.md, the "Azure Deployment" section in PLAN-phase4-azure.md', { cwd, session: 'p4' });
    gate('check-infra --offline', 'node', ['scripts/check-infra.mjs', '--offline'], { cwd });
    gate('gate unchanged since phase4-red', 'git', ['diff', '--exit-code', 'phase4-red', '--', 'scripts/check-infra.mjs'], { cwd });
    reviewUntilReady(() => prompt('Perform a read-only pre-deployment review of the generated AIMarket', { cwd, session: 'p4' }),
      () => prompt('Fix only the checks that failed in that review', { cwd, session: 'p4' }));
    if (!existsSync(join(cwd, '.azure'))) cmd('azd env new', 'azd', ['env', 'new', 'aimarket', '--location', location, '--no-prompt'], { cwd });
    cmd('azd env set AZURE_SUBSCRIPTION_ID', 'azd', ['env', 'set', 'AZURE_SUBSCRIPTION_ID', subscriptionId()], { cwd });
    gate('check-infra (with preview)', 'node', ['scripts/check-infra.mjs'], { cwd });
    azdUp({ cwd, session: 'p4', phase: 'Phase 4 Step 3: Deploy' });
    gate('verify-aimarket.mjs', 'node', ['../../.github/scripts/verify-aimarket.mjs'], { cwd });
  },

  async 'smart-todo'() {
    const workspace = join(runDir, 'workspace');
    cmd('setup.mjs --local', 'node', [join(repoRoot, 'journeys', 'smart-todo', 'setup', 'setup.mjs'), '--local', '--workspace', workspace]);
    gitRoot = workspace;
    const cwd = join(workspace, 'journeys', 'smart-todo');
    azdProjects.add(cwd);
    loadPrompts(join(cwd, 'README.md'));
    note('No disposable GitHub repository: skipped 🐙 steps (issues, pull requests, Copilot review, Phase 4), used plain branches, and answered grill-plan with the plan defaults');
    // Without GitHub issues, the plans and a decisions file stand in for them (runner skill).
    const local = {
      'post the Decisions and the Test list as a comment on the issue': 'write the Decisions and the Test list to decisions-phase1.md',
      'the Decisions comment on issue #<api-issue>': 'the decisions in decisions-phase1.md',
      'the Decisions comment on the issue': 'the decisions in decisions-phase1.md',
      'on issue #<api-issue>': 'on PLAN-phase1-api.md',
      'of issue #<api-issue>': 'described in PLAN-phase1-api.md',
      'for issue #<azure-issue>': '',
    };
    cmd('branch phase-1-api', 'git', ['switch', '-c', 'phase-1-api'], { cwd });
    const api = join(cwd, 'src', 'api');
    prompt('Use the grill-plan skill on issue', { cwd, session: 'p1', fill: local });
    prompt('Use the tdd-builder agent for the red phase of issue #<api-issue>', { cwd, session: 'p1', fill: local });
    const red = cmd('npm test (red)', 'npm', ['test'], { cwd: api, allowFail: true });
    result('red tests fail on assertions, not setup', red.status !== 0 && !/Cannot find module|error TS\d/.test(red.output));
    prompt('/autopilot Use the tdd-builder agent for the green phase of issue\n#<api-issue>', { cwd, session: 'p1', fill: local, minutes: 120 });
    let check = cmd('npm run check', 'npm', ['run', 'check'], { cwd: api, allowFail: true });
    // Send the red-fix prompt only when tests failed, not when a later part of the check did.
    const testsFailed = /Tests\s+\d+ failed|\d+ failed \|/.test(check.output);
    if (check.status !== 0 && testsFailed) {
      note('green stopped with failing tests; sent the README red-fix prompt');
      const red = unlockTests('phase1-red', cwd);
      prompt('Fix only the red tests you reported as impossible to pass', { cwd, session: 'p1', minutes: 120 });
      relockTests('phase1-red', red, cwd);
      check = cmd('npm run check (after red fix)', 'npm', ['run', 'check'], { cwd: api, allowFail: true });
    }
    result('npm run check', check.status === 0);
    gate('tests unchanged since phase1-red', 'git', ['diff', '--exit-code', 'phase1-red', '--', 'src/api/test'], { cwd });
    await smartTodoLocalVerifier(workspace, cwd);
    prompt('/review Review the phase-1-api branch', { cwd, session: 'p1', fill: local });
    const redBeforeTriage = unlockTests('phase1-red', cwd);
    prompt('=Triage these /review findings with the "Review Triage" section of PLAN.md: fix every correctness, security, and contract finding, and list anything else in known-limitations.md (there is no GitHub repository for issues in this run). Commit the tests for each fix as a new red commit and tag it phase1-red.', { cwd, session: 'p1', label: 'triage' });
    relockTests('phase1-red', redBeforeTriage, cwd);
    gate('npm run check (after triage)', 'npm', ['run', 'check'], { cwd: api });
    gate('tests unchanged since phase1-red (after triage)', 'git', ['diff', '--exit-code', 'phase1-red', '--', 'src/api/test'], { cwd });
    commitAll(cwd, 'Phase 1 complete');
    cmd('merge phase 1 into main', 'git', ['switch', 'main'], { cwd });
    cmd('fast-forward main', 'git', ['merge', '--ff-only', 'phase-1-api'], { cwd });
    if (process.platform !== 'darwin') note('Phase 2 (iOS) needs Xcode and was skipped on this OS');
    cmd('branch phase-3-azure', 'git', ['switch', '-c', 'phase-3-azure'], { cwd });
    prompt('Do the "Cost and Architecture Review"', { cwd, session: 'p3', fill: local });
    prompt('Create scripts/check-infra.mjs exactly as the "Infrastructure Gate"', { cwd, session: 'p3' });
    const infraRed = cmd('infra gate red', 'node', ['scripts/check-infra.mjs', '--offline'], { cwd, allowFail: true });
    result('infra gate fails before infrastructure exists', infraRed.status !== 0);
    prompt('/autopilot Generate the infrastructure in the "Azure Deployment" section', { cwd, session: 'p3', minutes: 120 });
    gate('check-infra --offline', 'node', ['scripts/check-infra.mjs', '--offline'], { cwd });
    gate('gate unchanged since phase3-red', 'git', ['diff', '--exit-code', 'phase3-red', '--', 'scripts/check-infra.mjs'], { cwd });
    prompt('Prepare this azd environment as the "Environment Preparation"', { cwd, session: 'p3' });
    gate('check-infra (with preview)', 'node', ['scripts/check-infra.mjs'], { cwd });
    azdUp({ cwd, session: 'p3', phase: 'Phase 3 Step 4' });
    gate('verify-smart-todo.mjs (Azure)', 'node', ['../../.github/scripts/verify-smart-todo.mjs'], { cwd });
    prompt('Create the skill in the "Reusable Infrastructure Skill"', { cwd, session: 'p3' });
  },
};

async function smartTodoLocalVerifier(workspace, cwd) {
  const worktree = join(runDir, 'smart-todo-api');
  cmd('api worktree', 'git', ['worktree', 'add', '--detach', worktree, 'phase-1-api'], { cwd });
  const api = join(worktree, 'journeys', 'smart-todo', 'src', 'api');
  copyFileSync(join(api, 'local.settings.example.json'), join(api, 'local.settings.json'));
  cmd('api npm ci', 'npm', ['ci'], { cwd: api });
  cmd('api npm run build', 'npm', ['run', 'build'], { cwd: api });
  startBackground('azurite', 'npm', ['run', 'azurite'], { cwd: api });
  startBackground('func start', 'func', ['start', '--port', '7071'], { cwd: api });
  await waitForUrl('http://localhost:7071/api/todos?userId=user-1', 5);
  gate('verify-smart-todo.mjs (local)', 'node', ['../../.github/scripts/verify-smart-todo.mjs', '--base-url', 'http://localhost:7071'], { cwd });
  stopBackground();
}

function reviewUntilReady(review, fix, rounds = 2) {
  for (let round = 1; round <= rounds + 1; round++) {
    const out = review();
    const status = out.match(/PRE-DEPLOYMENT STATUS:?\s*\**\s*(NOT READY|READY)/gi)?.pop() ?? '';
    const ready = /READY/i.test(status) && !/NOT READY/i.test(status);
    result(`pre-deployment review round ${round}`, ready, status.replace(/\*/g, ''));
    if (ready) return;
    if (round > rounds) throw new Error('pre-deployment review stayed NOT READY');
    fix();
  }
}

// --- redaction and report ---------------------------------------------------------------

let secretsToRedact = [];
let cachedSubscription;
function subscriptionId() {
  if (cachedSubscription === undefined) {
    const inv = invocation('az', ['account', 'show', '--query', 'id', '-o', 'tsv']);
    cachedSubscription = (process.env.AZURE_SUBSCRIPTION_ID || spawnSync(inv.file, inv.args, { shell: inv.shell, encoding: 'utf8' }).stdout || '').trim();
  }
  return cachedSubscription;
}
function redact(text) {
  let out = text;
  for (const secret of secretsToRedact) if (secret && secret.length > 6) out = out.split(secret).join('<redacted>');
  return out
    .replace(/(password|secret|token|apikey|api_key|accountkey|sig)(["'\s:=]+)[^\s"',;]{8,}/gi, '$1$2<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer <redacted>')
    .replace(/n8n_api_[A-Za-z0-9]+/g, '<redacted>');
}
function writeRedactedLogs() {
  const out = join(runDir, 'logs');
  mkdirSync(out, { recursive: true });
  for (const name of readdirSync(logDir)) {
    const file = join(logDir, name);
    if (statSync(file).isFile()) writeFileSync(join(out, name), redact(readFileSync(file, 'utf8')));
  }
}
function writeReport(error) {
  const summary = spawnSync(process.execPath, [join(scripts, 'summarize-run.mjs'), '--record', record], { encoding: 'utf8' }).stdout;
  const failed = results.filter((r) => !r.ok);
  const verdict = error ? `FAIL: ${error.message}` : failed.length ? `PASS with ${failed.length} recovered failure(s)` : 'PASS';
  const report = [`# ${journey} journey run`, '', `- Result: **${verdict}**`, `- Host: ${process.platform} ${process.arch}, Node ${process.version}`, `- Source: ${spawnSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()}`, `- Run directory: ${runDir}`, '',
    '## Checks', '', '| Check | Result | Detail |', '| --- | --- | --- |', ...results.map((r) => `| ${r.name} | ${r.ok ? 'PASS' : 'FAIL'} | ${redact(r.detail).replace(/\|/g, '\\|')} |`), '',
    '## Notes', '', ...(notes.length ? notes.map((n) => `- ${n}`) : ['- None']), '', '## Steps', '', summary].join('\n');
  writeFileSync(join(runDir, 'run-report.md'), redact(report));
  writeRedactedLogs();
  return verdict;
}

// --- main -------------------------------------------------------------------------------

// Anything that escapes the try/finally below still gets cleanup and a report.
let finished = false;
async function emergency(label, error) {
  if (finished) return;
  finished = true;
  log(`STOPPED (${label}): ${error?.stack ?? error}`);
  try { if (!keep) cleanup(); } catch (cleanupError) { log(`cleanup failed: ${cleanupError.message}`); }
  try { writeReport(error instanceof Error ? error : new Error(String(error))); } catch {}
  process.exit(1);
}
process.on('uncaughtException', (error) => emergency('uncaught exception', error));
process.on('unhandledRejection', (error) => emergency('unhandled rejection', error));

// A cancelled or timed-out job skips the finally block, so CI calls this separately.
if (cleanupOnly) {
  const walk = (dir, depth = 0) => {
    if (depth > 6 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.name === '.azure') azdProjects.add(dir);
      else walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(runDir);
  spawnSync(process.execPath, [join(scripts, 'refresh-azure-oidc.mjs'), '--once'], { stdio: 'ignore' });
  log(`Cleanup only: ${azdProjects.size} azd project(s) under ${runDir}`);
  cleanup();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}

secretsToRedact = [process.env.AZURE_SUBSCRIPTION_ID, process.env.AZURE_TENANT_ID, process.env.AZURE_CLIENT_ID, subscriptionId()].filter(Boolean);
log(`Running ${journey} on ${process.platform} ${process.arch}; run directory ${runDir}`);
cmd('azd uses Azure CLI sign-in', 'azd', ['config', 'set', 'auth.useAzCliAuth', 'true'], { allowFail: true });
// In GitHub Actions with OIDC, keep the Azure CLI sign-in fresh for the whole run.
let refresher;
if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.AZURE_CLIENT_ID) {
  refresher = spawn(process.execPath, [join(scripts, 'refresh-azure-oidc.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  refresher.stdout.on('data', (d) => appendFileSync(join(logDir, 'azure-oidc-refresh.log'), d));
  refresher.stderr.on('data', (d) => appendFileSync(join(logDir, 'azure-oidc-refresh.log'), d));
  log('Refreshing the Azure OIDC sign-in every 4 minutes');
}
let failure;
try {
  await recipes[journey]();
} catch (error) {
  failure = error;
  log(`STOPPED: ${error.message}`);
} finally {
  if (keep) note('--keep: Azure resources were left running');
  else cleanup();
  refresher?.kill();
  finished = true;
  const verdict = writeReport(failure);
  log(`\n${verdict}\nReport: ${join(runDir, 'run-report.md')}`);
  process.exitCode = failure || results.some((r) => !r.ok && r.name.startsWith('cleanup')) ? 1 : 0;
}
