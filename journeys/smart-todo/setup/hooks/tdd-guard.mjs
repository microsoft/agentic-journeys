#!/usr/bin/env node
// SmartTodo TDD guard: a Copilot preToolUse hook that setup.mjs installs as
// .github/hooks/tdd-guard.mjs in the learner's workspace.
//
// While a red tag such as phase1-red exists, the tests it protects are frozen:
// the agent can't edit, create, move, or delete them, and it can't move or delete
// the tag. The learner unlocks the tests by deleting the tag in a terminal. Some
// files are always protected. Shell commands are checked on a best-effort basis,
// so the `git diff --exit-code <tag>` gates stay the proof.
//
// Reads the hook payload on stdin and prints one JSON line only to deny a call.
// Any internal error allows the call, because a crashing preToolUse hook would
// block every tool.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FROZEN_BY_TAG = {
  'phase1-red': ['journeys/smart-todo/src/api/test/'],
  'phase2-red': ['journeys/smart-todo/src/ios/SmartTodoTests/', 'journeys/smart-todo/src/ios/SmartTodoUITests/'],
  'phase3-red': ['journeys/smart-todo/scripts/check-infra.mjs'],
};

export const ALWAYS_PROTECTED = [
  '.github/hooks/',
  '.github/scripts/verify-smart-todo.mjs',
  'journeys/smart-todo/scripts/test-ios.mjs',
  'journeys/smart-todo/starter/',
  '.git/refs/tags/',
  '.git/packed-refs',
];

const EDIT_TOOLS = new Set(['edit', 'create', 'write', 'str_replace_editor', 'str_replace_based_edit_tool', 'apply_patch', 'multi_edit']);
const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell']);
const DELETE_OR_MOVE = new Set(['rm', 'unlink', 'rmdir', 'shred', 'truncate', 'mv', 'tee', 'remove-item', 'ri', 'del', 'erase', 'rd', 'move-item', 'mi', 'move', 'rename-item', 'rni', 'ren', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc', 'new-item', 'ni']);
const COPY = new Set(['cp', 'install', 'rsync', 'ln', 'copy-item', 'cpi', 'copy']);
const IN_PLACE = new Set(['sed', 'gsed', 'perl']);
const PS_TARGET_PARAMS = new Set(['-path', '-literalpath', '-filepath', '-destination', '-newname']);
const REDIRECT = /^\d*>{1,2}\|?$|^&>{1,2}$/;
const INLINE_WRITE = /\b(writeFileSync|writeFile|appendFileSync|appendFile|rmSync|unlinkSync|renameSync|copyFileSync|truncateSync|Set-Content|Out-File|WriteAllText)\b|open\([^)]*['"][wa]/;

function matches(relative, rule) {
  const target = relative.split(path.sep).join('/').toLowerCase();
  const lowerRule = rule.toLowerCase();
  return lowerRule.endsWith('/') ? target.startsWith(lowerRule) || `${target}/` === lowerRule : target === lowerRule;
}

export function findRule(relative, activeTags) {
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  if (ALWAYS_PROTECTED.some((rule) => matches(relative, rule))) return { path: relative.split(path.sep).join('/'), tag: undefined };
  for (const tag of activeTags) {
    if ((FROZEN_BY_TAG[tag] ?? []).some((rule) => matches(relative, rule))) return { path: relative.split(path.sep).join('/'), tag };
  }
  return undefined;
}

// Splits a shell command into segments of words. Quotes group words; it isn't a full shell parser.
export function tokenize(command) {
  const segments = [];
  let words = [];
  let current = '';
  let quote = '';
  let started = false;
  const endWord = () => {
    if (started) words.push(current);
    current = '';
    started = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"' && index + 1 < command.length) current += command[++index];
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === '\\' && index + 1 < command.length && command[index + 1] !== '\n') {
      current += command[++index];
      started = true;
    } else if (char === '\n') {
      endSegment();
    } else if (/\s/.test(char)) {
      endWord();
    } else if (char === '>' || char === '<') {
      const descriptor = /^\d$/.test(current) || current === '&' ? current : '';
      if (descriptor) {
        current = '';
        started = false;
      } else endWord();
      let operator = descriptor + char;
      while (command[index + 1] === '>' || command[index + 1] === '|') operator += command[++index];
      if (command[index + 1] === '&') {
        operator += command[++index];
        while (/\d|-/.test(command[index + 1] ?? '')) operator += command[++index];
      }
      words.push(operator);
    } else if (char === ';' || char === '|' || (char === '&' && command[index + 1] !== '>')) {
      endSegment();
      if (command[index + 1] === char) index += 1;
    } else {
      current += char;
      started = true;
    }
  }
  endSegment();
  return segments;
}

function nonOptions(args) {
  return args.filter((arg) => !arg.startsWith('-'));
}

function gitParts(args) {
  let index = 0;
  let dir;
  while (index < args.length && args[index].startsWith('-')) {
    if (args[index] === '-C') dir = args[index + 1];
    index += args[index] === '-C' || args[index] === '-c' ? 2 : 1;
  }
  return { dir, subcommand: args[index], rest: args.slice(index + 1) };
}

// Returns { targets, dir, restoreSource, tagChange } for one segment of a shell command.
export function analyzeSegment(segment) {
  const targets = [];
  const words = [];
  for (let index = 0; index < segment.length; index += 1) {
    if (/^\d*</.test(segment[index]) || /^\d*>&|^&>&/.test(segment[index])) {
      if (/^\d*<$/.test(segment[index])) index += 1;
      continue;
    }
    if (REDIRECT.test(segment[index])) {
      if (segment[index + 1]) targets.push(segment[index + 1]);
      index += 1;
      continue;
    }
    words.push(segment[index]);
  }
  while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ['sudo', 'env', 'command', 'exec', 'nohup', 'time', '&'].includes(words[0]))) words.shift();
  if (!words.length) return { targets };
  const name = words[0].split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  const args = words.slice(1);

  if (name === 'git') {
    const { dir, subcommand, rest } = gitParts(args);
    if (subcommand === 'tag' && rest.some((arg) => arg === '--delete' || arg === '--force' || /^-[A-Za-z]*[df][A-Za-z]*$/.test(arg))) {
      return { targets, dir, tagChange: nonOptions(rest) };
    }
    if (subcommand === 'update-ref') {
      return { targets, dir, tagChange: rest.filter((arg) => arg.includes('refs/tags/')).map((arg) => arg.replace(/^.*refs\/tags\//, '')) };
    }
    if (subcommand === 'rm' || subcommand === 'mv') return { targets: [...targets, ...nonOptions(rest)], dir };
    if (subcommand === 'checkout' || subcommand === 'restore') {
      const separator = rest.indexOf('--');
      if (subcommand === 'checkout') {
        if (separator === -1) return { targets, dir };
        return { targets: [...targets, ...rest.slice(separator + 1)], dir, restoreSource: nonOptions(rest.slice(0, separator))[0] };
      }
      const sourceIndex = rest.findIndex((arg) => arg === '--source' || arg === '-s');
      const restoreSource = sourceIndex >= 0 ? rest[sourceIndex + 1] : rest.find((arg) => arg.startsWith('--source='))?.slice(9);
      const paths = separator >= 0 ? rest.slice(separator + 1) : nonOptions(rest.filter((_, index) => sourceIndex < 0 || index !== sourceIndex + 1));
      return { targets: [...targets, ...paths], dir, restoreSource };
    }
    return { targets, dir };
  }
  if (DELETE_OR_MOVE.has(name)) {
    const named = args.flatMap((arg, index) => (PS_TARGET_PARAMS.has(arg.toLowerCase()) && args[index + 1] ? [args[index + 1]] : []));
    return { targets: [...targets, ...nonOptions(args), ...named] };
  }
  if (COPY.has(name)) {
    const destinationIndex = args.findIndex((arg) => arg.toLowerCase() === '-destination');
    const destination = destinationIndex >= 0 ? args[destinationIndex + 1] : nonOptions(args).at(-1);
    return { targets: destination ? [...targets, destination] : targets };
  }
  if (IN_PLACE.has(name) && args.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg.startsWith('--in-place'))) {
    return { targets: [...targets, ...nonOptions(args)] };
  }
  return { targets };
}

function patchPaths(text) {
  return [...text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((match) => (match[1] ?? match[2]).trim());
}

function parseToolArgs(raw) {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return { input: parsed };
    return parsed && typeof parsed === 'object' ? parsed : { input: raw };
  } catch {
    return { input: raw };
  }
}

// Resolves symbolic links in the part of the path that exists, so /var and /private/var compare equal.
function realPath(target) {
  let existing = target;
  const missing = [];
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  try {
    return path.join(realpathSync.native(existing), ...missing);
  } catch {
    return target;
  }
}

function denyMessage(rule) {
  if (!rule.tag) {
    return `SmartTodo TDD guard: ${rule.path} is protected. Don't change it. If it must change, stop and ask the human.`;
  }
  return `SmartTodo TDD guard: ${rule.path} is frozen by the ${rule.tag} tag. Don't change frozen tests. If a test is wrong, stop and report it. To allow test changes, the human runs "git tag -d ${rule.tag}" in a terminal. Then commit the test change as a new red commit and tag it ${rule.tag}.`;
}

export function decide(payload, { repoRoot, activeTags, resolve = realPath }) {
  const toolName = String(payload.toolName ?? payload.tool_name ?? '').toLowerCase();
  const args = parseToolArgs(payload.toolArgs ?? payload.tool_input);
  const cwd = payload.cwd || repoRoot;
  const relative = (target, base) => path.relative(repoRoot, resolve(path.resolve(base, target)));

  if (EDIT_TOOLS.has(toolName)) {
    const candidates = [args.path, args.file_path, args.filePath, ...patchPaths(String(args.input ?? args.patch ?? ''))].filter(Boolean);
    for (const candidate of candidates) {
      const rule = findRule(relative(String(candidate), cwd), activeTags);
      if (rule) return denyMessage(rule);
    }
    return undefined;
  }
  if (!SHELL_TOOLS.has(toolName)) return undefined;

  const command = String(args.command ?? args.input ?? '');
  let segmentCwd = cwd;
  for (const segment of tokenize(command)) {
    const first = segment[0]?.toLowerCase();
    if (['cd', 'pushd', 'set-location', 'sl', 'chdir'].includes(first)) {
      if (segment[1]) segmentCwd = path.resolve(segmentCwd, segment[1]);
      continue;
    }
    const result = analyzeSegment(segment);
    const base = result.dir ? path.resolve(segmentCwd, result.dir) : segmentCwd;
    const tag = (result.tagChange ?? []).find((name) => FROZEN_BY_TAG[name]);
    if (tag) {
      return `SmartTodo TDD guard: only the human moves or deletes the ${tag} tag. Stop and ask the human to run "git tag -d ${tag}" in a terminal.`;
    }
    for (const target of result.targets) {
      const rule = findRule(relative(target, base), activeTags);
      if (rule && !(rule.tag && result.restoreSource === rule.tag)) return denyMessage(rule);
    }
  }
  if (INLINE_WRITE.test(command)) {
    const rules = [...ALWAYS_PROTECTED.filter((rule) => !rule.startsWith('.git/')).map((rule) => ({ rule })), ...activeTags.flatMap((tag) => FROZEN_BY_TAG[tag].map((rule) => ({ rule, tag })))];
    const lower = command.toLowerCase();
    const hit = rules.find(({ rule }) => lower.includes(rule.replace(/^journeys\/smart-todo\//, '').replace(/\/$/, '').toLowerCase()));
    if (hit) return denyMessage({ path: hit.rule, tag: hit.tag });
  }
  return undefined;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function main() {
  const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const cwd = payload.cwd || process.cwd();
  const repoRoot = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!repoRoot) return;
  const activeTags = (git(cwd, ['tag', '--list', 'phase*-red']) ?? '').split(/\r?\n/).filter((tag) => FROZEN_BY_TAG[tag]);
  const reason = decide({ ...payload, cwd: realPath(path.resolve(cwd)) }, { repoRoot: realPath(path.resolve(repoRoot)), activeTags });
  if (reason) process.stdout.write(`${JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    // Allow the call: a crashing preToolUse hook would deny every tool.
  }
}
