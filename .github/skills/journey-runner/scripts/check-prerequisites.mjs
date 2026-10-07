#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { run } from '../../../scripts/_utils.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const requiredIndex = argv.indexOf('--required');
const optionalIndex = argv.indexOf('--optional');

function listAt(index) {
  if (index === -1 || !argv[index + 1]) return [];
  return argv[index + 1].split(',').map((value) => value.trim()).filter(Boolean);
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

const required = listAt(requiredIndex);
const optional = listAt(optionalIndex);

if (required.length === 0) {
  console.error('Usage: node check-prerequisites.mjs --required az,azd,copilot [--optional docker,helm]');
  process.exit(2);
}

const checks = {
  node: ['node', ['--version']],
  az: ['az', ['version']],
  azd: ['azd', ['version']],
  copilot: ['copilot', ['--version']],
  docker: ['docker', ['--version']],
  gh: ['gh', ['--version']],
  git: ['git', ['--version']],
  kubectl: ['kubectl', ['version', '--client']],
  helm: ['helm', ['version', '--short']],
  func: ['func', ['--version']],
  azurite: ['azurite', ['--version']],
  sqlcmd: ['sqlcmd', ['--version']],
  xcode: ['xcodebuild', ['-version']],
  xcodebuild: ['xcodebuild', ['-version']],
};

function runCheck(tool) {
  if (tool === 'playwright') {
    const packageFile = join(scriptDir, 'node_modules', 'playwright', 'package.json');
    return existsSync(packageFile)
      ? { ok: true, detail: 'local package installed' }
      : { ok: false, detail: `missing; run npm ci in ${scriptDir}` };
  }

  // Xcode can be installed with no iOS simulator runtime; then iOS tests can't run.
  if (tool === 'ios-simulator') {
    const result = run('xcrun', ['simctl', 'list', 'runtimes', '--json'], { allowFailure: true, timeout: 30000 });
    let runtimes = [];
    try {
      runtimes = JSON.parse(result.stdout ?? '{}').runtimes?.filter((runtime) => runtime.platform === 'iOS' && runtime.isAvailable) ?? [];
    } catch {}
    return runtimes.length
      ? { ok: true, detail: runtimes.map((runtime) => runtime.name).join(', ') }
      : { ok: false, detail: 'no iOS simulator runtime; install one with xcodebuild -downloadPlatform iOS (about 8 GB)' };
  }

  if (tool === 'docker-daemon') {
    const result = run('docker', ['info'], { allowFailure: true, timeout: 30000 });
    return {
      ok: result.status === 0,
      detail: result.status === 0 ? 'daemon reachable' : (result.stderr || result.error?.message || 'daemon unavailable').trim(),
    };
  }

  const spec = checks[tool];
  if (!spec) return { ok: false, detail: 'unknown prerequisite key' };

  const result = run(spec[0], spec[1], { allowFailure: true, timeout: 30000 });
  const text = `${result.stdout ?? ''} ${result.stderr ?? ''}`.trim().replace(/\s+/g, ' ');
  if (result.status === 0) {
    const minimums = { node: [24, 0, 0], azd: [1, 28, 0], func: [4, 0, 0], helm: [3, 0, 0] };
    const requiredMajors = { func: 4, helm: 3 };
    const minimum = minimums[tool];
    if (minimum) {
      const match = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
      const actual = match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
      const meetsMinimum = actual ? versionAtLeast(actual, minimum) : false;
      if (!meetsMinimum) {
        return { ok: false, detail: `${text.slice(0, 130)}; requires ${minimum.join('.')}+` };
      }
      if (requiredMajors[tool] && actual[0] !== requiredMajors[tool]) {
        return { ok: false, detail: `${text.slice(0, 130)}; requires major version ${requiredMajors[tool]}` };
      }
    }
  }
  return {
    ok: result.status === 0,
    detail: result.status === 0 ? text.slice(0, 180) : (result.error?.message || text || 'command failed').slice(0, 180),
  };
}

console.log(`Host: ${os.platform()} ${os.arch()} (${os.release()})`);
console.log('');
console.log('| Requirement | Kind | Status | Detail |');
console.log('|---|---|---|---|');

let requiredFailures = 0;
for (const [kind, tools] of [['required', required], ['optional', optional]]) {
  for (const tool of tools) {
    const result = runCheck(tool);
    if (kind === 'required' && !result.ok) requiredFailures += 1;
    const detail = result.detail.replace(/\|/g, '\\|');
    console.log(`| ${tool} | ${kind} | ${result.ok ? 'PASS' : 'MISSING'} | ${detail} |`);
  }
}

if (requiredFailures > 0) {
  console.error(`\nPreflight failed: ${requiredFailures} required prerequisite(s) missing.`);
  process.exit(1);
}

console.log('\nPreflight passed.');
