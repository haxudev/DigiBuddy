#!/usr/bin/env node

import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseProfileContract } from './profile-contract.mjs';

const [scope, fileArg, workspaceArg = process.cwd(), snapshotArg] = process.argv.slice(2);
const fail = (message) => { console.error(message); process.exit(1); };
if (!['project', 'user', 'built-in'].includes(scope) || !fileArg) {
  fail('usage: validate-profile.mjs <project|user|built-in> <profile-file> [workspace]');
}

const skillRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const expectedRoot = scope === 'project' ? join(resolve(workspaceArg), '.superclarity', 'profiles')
  : scope === 'user' ? join(homedir(), '.superclarity', 'profiles')
    : join(skillRoot, 'profiles');
const base = scope === 'project' ? realpathSync(resolve(workspaceArg))
  : scope === 'user' ? realpathSync(homedir()) : realpathSync(skillRoot);
let current = base;
for (const component of relative(base, expectedRoot).split(/[\\/]/).filter(Boolean)) {
  current = join(current, component);
  if (!existsSync(current)) fail(`profile root component does not exist: ${current}`);
  const item = lstatSync(current);
  if (item.isSymbolicLink() || realpathSync(current).toLowerCase() !== resolve(current).toLowerCase()) {
    fail(`profile root contains a linked/reparse component: ${current}`);
  }
}
const rootStat = lstatSync(expectedRoot);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('profile root must be a real directory');
const root = realpathSync(expectedRoot);

const file = resolve(fileArg);
const stat = lstatSync(file);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) fail('profile must be a regular unlinked file');
const canonical = realpathSync(file);
if (dirname(canonical) !== root || relative(root, canonical).startsWith('..')) {
  fail('profile must be a direct child of its selected scope root');
}
if (extname(canonical) !== '.md') fail('profile must use the .md extension');

// Read once; validation, hashing, and the subsequent task-local copy all use
// these exact bytes. Reopening the source after validation would permit a
// validate/swap/copy race.
const fd = openSync(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
const opened = fstatSync(fd);
if (!opened.isFile() || opened.nlink > 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) {
  closeSync(fd); fail('profile changed or is linked');
}
const text = readFileSync(fd, 'utf8');
closeSync(fd);
const id = basename(canonical, '.md');
const skillsRoot = dirname(skillRoot);
const forbiddenSkillNames = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const parsed = parseProfileContract(text, id, scope, { forbiddenSkillNames });
if (!parsed.valid) fail(parsed.errors.join('; '));

if (snapshotArg) {
  const snapshot = resolve(snapshotArg);
  const taskRoot = join(realpathSync(resolve(workspaceArg)), '.superclarity');
  if (basename(snapshot) !== 'profile.md' || !dirname(snapshot).startsWith(`${taskRoot}${process.platform === 'win32' ? '\\' : '/'}`)) {
    fail('snapshot must be task-local .superclarity/<task>/profile.md');
  }
  mkdirSync(dirname(snapshot), { recursive: true });
  writeFileSync(snapshot, text, { encoding: 'utf8', flag: 'wx', flush: true });
}

process.stdout.write(JSON.stringify({
  id, source: scope, sha256: parsed.digest, canonical,
}));
