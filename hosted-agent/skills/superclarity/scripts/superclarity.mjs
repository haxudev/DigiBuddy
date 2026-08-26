#!/usr/bin/env node
// vNext CLI: init / status / check / approve / step / accept / recover /
// repair. See docs/vnext-spec.md §10-11. This is the only place that touches
// the filesystem; parsing/validation/state derivation live in the other
// modules and are pure functions.

import { randomBytes } from 'node:crypto';
import {
  chmodSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync, closeSync,
} from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import {
  decodeUtf8Strict, digest, isIsoTimestamp, isPositiveInt, normalizeNewlines, rawDigest,
} from './markdown.mjs';
import {
  CapabilityIdRe, EXECUTABLE_READINESS, GATED_EFFECTS, RESOLVED_READINESS, TaskSlugRe,
  effectRequiresGate, keywordWarningApplies, parseContract, parseAcceptance, stepDigest,
} from './model.mjs';
import { BATCH_SCHEMA, LEDGER_EVENT_SCHEMA, parseLedgerFile } from './ledger.mjs';
import {
  computeApprovals, deriveState, foldRevision, latestRecordForRevision, maxRecordedRevision,
  occurredRecoveryObligations, occurredObligationClosed, recoveryView,
} from './state.mjs';
import {
  DETAIL_SCHEMA, computeActionDigest, isExpandedPath, pathFields, parseActionJsonText, validateActionJsonShape,
} from './action.mjs';
import { capDiagnostics } from './diagnostics.mjs';

// `report.md` is listed here for the same reason as the pre-vNext artifacts:
// it was the third state file until it was renamed to acceptance.md, and a
// directory still holding it was written by an older protocol. Naming it
// makes such a task `unsupported` — the hard-break answer — instead of the
// misleading "missing required artifact: acceptance.md".
const LEGACY_NAMES = new Set(['brief.md', 'capabilities.md', 'plan.md', 'journal.md', 'observations.json',
  'artifact-times.json', 'recovery.md', 'report.md', 'report.seal.md', 'delivery-proof.json', 'delivery-manifest.json']);
const STATE_FILES = ['contract.md', 'ledger.jsonl', 'acceptance.md'];
const heldLocks = new Set();
let deferredResponse = null;

class CliError extends Error {
  constructor(exitCode, diagnostics) { super(diagnostics[0]?.detail ?? 'error'); this.exitCode = exitCode; this.diagnostics = diagnostics; }
}
const usageError = (detail) => new CliError(2, [{ code: 'SC001', severity: 'error', location: null, detail }]);
const bundleError = (code, detail) => new CliError(3, [{ code, severity: 'error', location: null, detail }]);
/**
 * Report every blocking reason at once.
 *
 * Fail-fast validation makes the caller discover one problem per run, so a
 * contract with three faults costs three edit/check cycles and reads as if
 * the tool were moving the goalposts. Anything a single pass already knows
 * belongs in a single reply. Capped so one malformed file cannot bury the
 * response.
 */
const bundleErrors = (diagnostics) => new CliError(3, capDiagnostics(diagnostics));
const tokenError = (code, detail) => new CliError(4, [{ code, severity: 'error', location: null, detail }]);
const ioError = (code, detail) => new CliError(5, [{ code, severity: 'error', location: null, detail }]);

// -------------------------------------------------------------- arg parsing

const OPTION_SPECS = {
  init: { singleton: ['workspace', 'task', 'mode'], repeatable: [], boolean: ['acknowledge-unignored-state'] },
  status: { singleton: ['workspace', 'task'], repeatable: [], boolean: [] },
  check: {
    singleton: ['workspace', 'task', 'gate', 'step', 'binding', 'action-json', 'reason'],
    repeatable: ['readiness-confirmed'],
    boolean: ['single-session', 'private', 'no-sensitive-data', 'not-consequential', 'continuous'],
  },
  approve: {
    singleton: ['workspace', 'task', 'token', 'decision', 'action-json'],
    repeatable: ['readiness-confirmed'],
    boolean: [],
  },
  'step-start': { singleton: ['workspace', 'task', 'step', 'readiness-confirmed'], repeatable: [], boolean: [] },
  'step-fallback': { singleton: ['workspace', 'task', 'step', 'reason', 'readiness-confirmed'], repeatable: [], boolean: [] },
  'step-finish': { singleton: ['workspace', 'task', 'step', 'outcome', 'detail'], repeatable: ['evidence-file', 'evidence-external'], boolean: [] },
  'step-skip': { singleton: ['workspace', 'task', 'step', 'decision', 'impact'], repeatable: [], boolean: [] },
  'step-revalidate': { singleton: ['workspace', 'task', 'step', 'basis'], repeatable: ['evidence-file', 'evidence-external'], boolean: [] },
  accept: { singleton: ['workspace', 'task', 'verdict'], repeatable: [], boolean: [] },
  'recover-open': { singleton: ['workspace', 'task', 'code', 'summary'], repeatable: ['output'], boolean: [] },
  'recover-resolve': { singleton: ['workspace', 'task', 'decision', 'reconciliation', 'consequences'], repeatable: [], boolean: [] },
  'recover-cancel': { singleton: ['workspace', 'task', 'reason'], repeatable: [], boolean: [] },
  repair: { singleton: ['workspace', 'task'], repeatable: [], boolean: ['lock'] },
};

function parseArgs(argv, spec) {
  const out = {};
  for (const name of spec.repeatable) out[name] = [];
  for (const name of spec.boolean) out[name] = false;
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (!tok.startsWith('--')) throw usageError(`unexpected argument "${tok}"`);
    const name = tok.slice(2);
    if (spec.boolean.includes(name)) { out[name] = true; i += 1; continue; }
    if (i + 1 >= argv.length) throw usageError(`--${name} requires a value`);
    const value = argv[i + 1];
    if (spec.repeatable.includes(name)) { out[name].push(value); i += 2; continue; }
    if (spec.singleton.includes(name)) {
      if (Object.hasOwn(out, name)) throw usageError(`duplicate --${name}`);
      out[name] = value; i += 2; continue;
    }
    throw usageError(`unknown option --${name}${unknownOptionHint(name, spec)}`);
  }
  return out;
}

// Options that belong to `check` and are meaningless on `approve`. Passing
// them is a natural mistake, because the same gate needs them one command
// earlier; saying only "unknown option" invites the caller to suspect the
// token instead of the argument.
const CHECK_ONLY_FLAGS = new Set(['single-session', 'private', 'no-sensitive-data', 'not-consequential', 'continuous']);

function unknownOptionHint(name, spec) {
  if (!CHECK_ONLY_FLAGS.has(name)) return '';
  if (spec.boolean.includes(name)) return '';
  return '; the Compact eligibility flags belong to `check`, and the prepared gate already records them';
}

// ------------------------------------------------------------- filesystem

function realWorkspace(workspaceArg) {
  const resolved = resolve(process.cwd(), workspaceArg);
  if (!existsSync(resolved)) throw ioError('SC901', `workspace does not exist: ${workspaceArg}`);
  return realpathSync(resolved);
}

function assertContained(root, candidate) {
  const rel = relative(root, candidate);
  if (rel === '' ) return;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw ioError('SC103', `path escapes workspace: ${candidate}`);
}

function assertNotSymlink(p) {
  if (existsSync(p)) {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw ioError('SC103', `must not be a symlink: ${p}`);
  }
}

function assertSafeChain(root, candidate, { leaf = 'any', missing = false } = {}) {
  assertContained(root, candidate);
  const rel = relative(root, candidate);
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) {
      if (missing) return;
      throw ioError('SC103', `path does not exist: ${current}`);
    }
    const st = lstatSync(current);
    if (st.isSymbolicLink()) throw ioError('SC103', `links and reparse points are not allowed: ${current}`);
    if (current !== candidate && !st.isDirectory()) throw ioError('SC103', `path ancestor is not a directory: ${current}`);
    if (current === candidate && leaf === 'dir' && !st.isDirectory()) throw ioError('SC103', `not a directory: ${current}`);
    if (current === candidate && leaf === 'file' && (!st.isFile() || st.nlink !== 1)) throw ioError('SC103', `file must be regular and single-linked: ${current}`);
  }
}

function readSecureFile(root, p) {
  assertSafeChain(root, p, { leaf: 'file' });
  const fd = openSync(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw ioError('SC103', `file must be regular and single-linked: ${p}`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function taskDir(workspaceReal, task) {
  if (!TaskSlugRe.test(task ?? '')) throw usageError('task must be a valid TaskSlug');
  const scRoot = join(workspaceReal, '.superclarity');
  if (existsSync(scRoot)) assertSafeChain(workspaceReal, scRoot, { leaf: 'dir' });
  const dir = join(scRoot, task);
  assertContained(workspaceReal, dir);
  if (existsSync(dir)) assertSafeChain(workspaceReal, dir, { leaf: 'dir' });
  return { scRoot, dir };
}

function readStateFile(workspaceReal, dir, name) {
  const p = join(dir, name);
  if (!existsSync(p)) return { present: false, text: null };
  const buf = readSecureFile(workspaceReal, p);
  const { text, errors } = decodeUtf8Strict(buf);
  if (errors.length) return { present: true, text: null, decodeErrors: errors, bytes: buf };
  return { present: true, text, bytes: buf };
}

function atomicWriteNewFile(p, content) {
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  const scratch = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(scratch, content, { encoding: 'utf8', flag: 'wx' });
  renameSync(scratch, p);
}

function atomicReplaceFile(p, content) {
  const scratch = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(scratch, content, { encoding: 'utf8', flag: 'wx' });
  renameSync(scratch, p);
}

// -------------------------------------------------------------------- lock

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function acquireLock(scRoot, task, command) {
  const locksDir = join(scRoot, '.locks');
  if (!existsSync(scRoot)) throw ioError('SC901', '.superclarity does not exist');
  assertSafeChain(dirname(scRoot), scRoot, { leaf: 'dir' });
  if (!existsSync(locksDir)) mkdirSync(locksDir);
  assertSafeChain(dirname(scRoot), locksDir, { leaf: 'dir' });
  const claimPath = join(locksDir, `${task}.lock.claim`);
  if (heldLocks.has(claimPath)) return { release() {} };
  const nonce = randomBytes(16).toString('hex');
  const payload = JSON.stringify({ schema: 'superclarity-lock/1', pid: process.pid, hostname: hostnameSafe(), nonce, createdAt: new Date().toISOString(), command });
  let fd;
  try {
    fd = openSync(claimPath, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') throw ioError('SC902', `task is locked: ${claimPath}`);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw ioError('SC103', 'lock claim must be a regular single-linked file');
    writeFileSync(fd, payload, { encoding: 'utf8' });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const claimStat = lstatSync(claimPath);
  heldLocks.add(claimPath);
  return {
    release() {
      try {
        const currentStat = lstatSync(claimPath);
        const current = JSON.parse(readSecureFile(dirname(scRoot), claimPath).toString('utf8'));
        if (current.nonce === nonce && currentStat.dev === claimStat.dev && currentStat.ino === claimStat.ino) rmSync(claimPath, { force: true });
      } catch { /* best effort */ }
      heldLocks.delete(claimPath);
    },
  };
}

function hostnameSafe() {
  try { return osHostname(); } catch { return 'unknown'; }
}

// ----------------------------------------------------------------- clock

function now() { return new Date().toISOString(); }

function newToken() {
  const token = `sct1_${randomBytes(32).toString('base64url')}`;
  return { token, tokenDigest: rawDigest(token) };
}

// ------------------------------------------------------------- bundle load

function loadBundle(workspaceArg, task) {
  const workspaceReal = realWorkspace(workspaceArg);
  const { scRoot, dir } = taskDir(workspaceReal, task);
  const exists = existsSync(dir);
  if (!exists) return { workspaceReal, scRoot, dir, exists: false };

  const entries = readdirSync(dir);
  const layoutIssues = [];
  const warnings = [];
  for (const name of entries) {
    if (STATE_FILES.includes(name) || name === 'data') continue;
    if (LEGACY_NAMES.has(name)) layoutIssues.push(`legacy artifact present: ${name}`);
    else warnings.push({ code: 'SC102', severity: 'warning', location: null, detail: `unknown entry: ${name}` });
  }
  for (const name of STATE_FILES) {
    if (!entries.includes(name)) layoutIssues.push(`missing required artifact: ${name}`);
  }
  if (entries.includes('data')) assertSafeChain(workspaceReal, join(dir, 'data'), { leaf: 'dir' });

  const contractRaw = readStateFile(workspaceReal, dir, 'contract.md');
  const ledgerRaw = readStateFile(workspaceReal, dir, 'ledger.jsonl');
  const acceptanceRaw = readStateFile(workspaceReal, dir, 'acceptance.md');
  if (contractRaw.decodeErrors) layoutIssues.push('contract.md is not valid UTF-8');
  if (ledgerRaw.decodeErrors) layoutIssues.push('ledger.jsonl is not valid UTF-8');
  if (acceptanceRaw.decodeErrors) layoutIssues.push('acceptance.md is not valid UTF-8');

  const contract = contractRaw.text !== null ? parseContract(contractRaw.text) : null;
  const acceptance = acceptanceRaw.text !== null ? parseAcceptance(acceptanceRaw.text) : null;
  const ledger = ledgerRaw.text !== null ? parseLedgerFile(ledgerRaw.text) : { valid: false, corruption: { kind: 'middle' }, events: [] };

  if (contract && contract.header.task !== task) layoutIssues.push('contract.md task does not match the requested task');
  if (acceptance && acceptance.header.task !== task) layoutIssues.push('acceptance.md task does not match the requested task');
  if (ledger.valid && ledger.task !== task) layoutIssues.push('ledger.jsonl task does not match the requested task');

  return { workspaceReal, scRoot, dir, exists: true, contract, acceptance, ledger, layoutIssues, warnings, contractText: contractRaw.text, acceptanceBytes: acceptanceRaw.bytes };
}

// --------------------------------------------------------------- responses

function baseResponse(command, task) {
  return {
    schema: 'superclarity-diagnostic/1', ok: true, command, task,
    state: null, next: null, revision: null,
    digests: {}, ledger: {}, approvals: {}, steps: [], gate: null, options: [], token: null, display: {},
    deliverables: [], diagnostics: [],
  };
}

function emit(resp) {
  if (deferredResponse !== null) { deferredResponse = resp; return; }
  process.stdout.write(`${JSON.stringify(resp)}\n`);
}

function runLocked(args, command, fn) {
  const workspaceReal = realWorkspace(args.workspace);
  const { scRoot } = taskDir(workspaceReal, args.task);
  const lock = acquireLock(scRoot, args.task, command);
  deferredResponse = undefined;
  try { fn(args); } catch (e) { deferredResponse = null; throw e; } finally { lock.release(); }
  const response = deferredResponse;
  deferredResponse = null;
  if (response) emit(response);
}

/**
 * Pick the one action that actually unblocks this failure.
 *
 * A `next` the caller cannot execute is worse than no `next`: an agent that
 * reads "fix-invocation" has nothing to do with it, so it falls back to
 * reading this file's source to work out what the CLI wanted. Every rejection
 * therefore has to name a runnable command.
 */
function nextFromDiagnostics(diagnostics) {
  const detail = diagnostics.map((d) => `${d.code} ${d.detail}`).join('\n');
  if (/SC001/.test(detail)) return 'show-usage';
  // A task whose three artifacts were hand-written instead of created by
  // `init` reports missing/mismatched artifacts; the fix is always `init`.
  if (/missing required artifact|task does not match/.test(detail)) return 'run-init';
  if (diagnostics.some((d) => (/^SC20[1-6]$/.test(d.code) && !/^action JSON is invalid:/.test(d.detail))
    || (d.code === 'SC221' && /^step S\d+\b/.test(d.detail)))) return 'fix-contract';
  if (/SC30[16]|ledger/i.test(detail)) return 'run-status';
  return 'run-status';
}

function failFromError(command, task, e) {
  const resp = baseResponse(command, task);
  resp.ok = false;
  resp.state = 'drafting';
  resp.diagnostics = e.diagnostics ?? [{ code: 'SC900', severity: 'error', location: null, detail: e.message }];
  resp.next = nextFromDiagnostics(resp.diagnostics);
  if (resp.next === 'show-usage') resp.display = { summary: USAGE, action: null };
  emit(resp);
  process.exitCode = e.exitCode ?? 1;
}

// ------------------------------------------------------------------ status

function computeEvidenceStale(workspaceReal, contract, ledger) {
  if (!contract || !contract.valid || !ledger.valid) return false;
  const memo = new Map();
  const states = foldRevision(contract.header.revision, ledger, memo);
  for (const step of contract.plan.steps) {
    const s = states.get(step.id);
    if (!s || s.status !== 'completed') continue;
    const revalidated = [...ledger.events].reverse().find((e) => e.type === 'step-revalidated' && e.stepId === step.id);
    const finish = [...ledger.events].reverse().find((e) => e.type === 'step-finished' && e.stepId === step.id && e.outcome === 'completed');
    const evidence = revalidated ? revalidated.evidence : finish ? finish.evidence : [];
    for (const ev of evidence) {
      if (ev.kind !== 'file') continue;
      try {
        const abs = resolve(workspaceReal, ev.ref);
        assertContained(workspaceReal, abs);
        if (rawDigest(readSecureFile(workspaceReal, abs)) !== ev.digest) return true;
      } catch { return true; }
    }
  }
  return false;
}

function stateSnapshot(bundle) {
  if (!bundle.exists) return { state: 'drafting', next: 'init', diagnostics: [] };
  const acceptanceDigest = bundle.acceptanceBytes ? rawDigest(bundle.acceptanceBytes) : null;
  if (bundle.layoutIssues.length > 0) return deriveState({ contract: bundle.contract, acceptance: bundle.acceptance, acceptanceDigest, ledger: bundle.ledger, layoutIssues: bundle.layoutIssues });
  const evidenceStale = bundle.ledger.valid ? computeEvidenceStale(bundle.workspaceReal, bundle.contract, bundle.ledger) : false;
  return deriveState({ contract: bundle.contract, acceptance: bundle.acceptance, acceptanceDigest, ledger: bundle.ledger, layoutIssues: [], evidenceStale });
}

function fillCommon(resp, bundle, derived) {
  resp.state = derived.state;
  resp.next = derived.next;
  if (bundle.contract) {
    resp.revision = bundle.contract.header.revision;
    resp.digests = {
      terms: bundle.contract.termsDigest, termsContent: bundle.contract.termsContentDigest,
      plan: bundle.contract.planDigest, contract: bundle.contract.contractDigest,
      acceptance: bundle.acceptanceBytes ? rawDigest(bundle.acceptanceBytes) : null,
    };
  }
  if (bundle.ledger && bundle.ledger.valid) {
    resp.ledger = { batches: bundle.ledger.batches.length, seq: bundle.ledger.logicalHead?.seq ?? 0, businessSeq: bundle.ledger.businessHead?.seq ?? 0 };
  }
  if (derived.approvals) resp.approvals = derived.approvals;
  if (derived.steps) resp.steps = derived.steps;
  if (derived.gate) resp.gate = { type: derived.gate.gate, preparedSeq: derived.gate.seq, stepId: derived.gate.stepId ?? null };
  if (derived.state === 'accepted' && bundle.acceptance?.valid) {
    resp.deliverables = bundle.acceptance.deliverables.map(({ id, location, purpose }) => ({ id, location, purpose }));
    resp.display.delivery = {
      summary: bundle.acceptance.outcomeSummary,
      gaps: bundle.acceptance.gaps,
      instruction: 'Open every deliverable and present the requested result to the user before ending the response; internal .superclarity files are not deliverables.',
    };
  }
  resp.diagnostics.push(...(bundle.warnings ?? []));
  return resp;
}

function cmdStatus(args) {
  const bundle = loadBundle(args.workspace, args.task);
  const resp = baseResponse('status', args.task);
  const derived = stateSnapshot(bundle);
  fillCommon(resp, bundle, derived);
  resp.diagnostics.push(...(derived.diagnostics ?? []));
  emit(resp);
}

// ------------------------------------------------------------------- init

function cmdInit(args) {
  if (!args.mode || (args.mode !== 'compact' && args.mode !== 'full')) throw usageError('--mode must be compact or full');
  const workspaceReal = realWorkspace(args.workspace);
  const { scRoot, dir } = taskDir(workspaceReal, args.task);
  const gitDir = join(workspaceReal, '.git');
  if (existsSync(gitDir)) {
    const gitignore = join(workspaceReal, '.gitignore');
    const ignored = existsSync(gitignore) && /(^|\n)\.superclarity\/?\s*$/m.test(readFileSync(gitignore, 'utf8'));
    if (!ignored && !args['acknowledge-unignored-state']) {
      throw new CliError(3, [{ code: 'SC212', severity: 'warning', location: null, detail: '.superclarity/ is not ignored by git; re-run with --acknowledge-unignored-state after confirming with the user' }]);
    }
  }
  if (!existsSync(scRoot)) mkdirSync(scRoot);
  assertSafeChain(workspaceReal, scRoot, { leaf: 'dir' });
  const locksDir = join(scRoot, '.locks');
  if (!existsSync(locksDir)) mkdirSync(locksDir);
  assertSafeChain(workspaceReal, locksDir, { leaf: 'dir' });
  const lock = acquireLock(scRoot, args.task, 'init');
  try {
    if (existsSync(dir)) throw bundleError('SC301', 'task already exists');

  const t = now();
  const contract = contractTemplate(args.task, args.mode, t);
  const acceptance = acceptanceTemplate(args.task, t);
  const ledger = `${JSON.stringify({ schema: BATCH_SCHEMA, events: [{ seq: 1, at: t, type: 'task-created', schema: LEDGER_EVENT_SCHEMA, task: args.task }] })}\n`;

  const staging = mkdtempSync(join(scRoot, '.init-'));
  try {
    writeFileSync(join(staging, 'contract.md'), contract, 'utf8');
    writeFileSync(join(staging, 'acceptance.md'), acceptance, 'utf8');
    writeFileSync(join(staging, 'ledger.jsonl'), ledger, 'utf8');
    mkdirSync(dirname(dir), { recursive: true });
    renameSync(staging, dir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

    const bundle = loadBundle(args.workspace, args.task);
    const resp = baseResponse('init', args.task);
    const derived = stateSnapshot(bundle);
    fillCommon(resp, bundle, derived);
    emit(resp);
  } finally { lock.release(); }
}

function contractTemplate(task, mode, t) {
  return `---\nschema: superclarity-contract/1\ntask: ${task}\nmode: ${mode}\nrevision: 1\ncreated_at: ${t}\n---\n\n# Contract: ${task}\n\n## Objective\n\n### Problem and current state\n<fill in>\n\n### Outcome and audience\n<fill in>\n\n## Scope\n\n### In\n- <fill in>\n\n### Out\n- <fill in>\n\n## Constraints\n\n| Constraint | Value |\n| --- | --- |\n| Deadline | <fill in> |\n| Effort or budget ceiling | <fill in> |\n| Output format | <fill in> |\n| Permitted sources | <fill in> |\n| Access and exposure | <fill in> |\n\n## Success criteria\n\n| ID | Criterion | Verification |\n| --- | --- | --- |\n| K1 | <fill in> | <fill in> |\n\n## Assumptions\n\nnone\n\n## Capability bindings\n\n| ID | Need | Primary | Readiness | Evidence | Fallback | Use fallback when | Consequence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| C1 | <fill in> | <fill in> | unverified | <fill in> | none | n/a | n/a |\n\n## Execution plan\n\nPending until terms approval.\n`;
}

/**
 * The acceptance record's opening line is not decoration.
 *
 * While this file was called `report.md` and opened with `## Result`, agents
 * read it as the thing being delivered and wrote the deliverable into it —
 * which is why the Deliverables table, whose `Location` column exists
 * precisely because the deliverables are elsewhere, kept coming back empty or
 * self-referential. The name and the first sentence now say what it is.
 */
function acceptanceTemplate(task, t) {
  return `---\nschema: superclarity-acceptance/1\ntask: ${task}\ncontract_revision: 1\ncreated_at: ${t}\n---\n\n# Acceptance record: ${task}\n\nThis file is the acceptance record, not the deliverable. Each deliverable is\na separate file; the Deliverables table below says where each one lives.\n\n## Outcome summary\n<one or two sentences: what was produced and whether it met the criteria>\n\n## Deliverables\n\n| ID | Location | Purpose | Evidence |\n| --- | --- | --- | --- |\n| D1 | <fill in> | <fill in> | <fill in> |\n\n## Success criteria\n\n| ID | Result | Evidence | Explanation |\n| --- | --- | --- | --- |\n| K1 | no | <fill in> | <fill in> |\n\n## Coverage and gaps\n\n| Gap | Cause | Effect |\n| --- | --- | --- |\n| none | n/a | n/a |\n\n## Deviations and recovery\n\nnone\n\n## Remaining actions\n\nnone\n`;
}

// ---------------------------------------------------------------- ledger IO

/**
 * Append one batch, but only if the on-disk ledger is still exactly where the
 * caller's in-memory view left it.
 *
 * Every mutating command reads the bundle before taking the lock, so the lock
 * alone serializes the writes without serializing the read-modify-write cycle:
 * two processes could each read head=N, then append two batches that both
 * start at seq N+1. A duplicated seq makes the whole ledger invalid, which
 * derives to `unsupported`/`start-new-task` — a concurrent invocation would
 * silently destroy the task. So re-read the head under the lock and refuse
 * rather than corrupt; the caller can simply run the command again.
 */
function appendBatch(dir, events) {
  const p = join(dir, 'ledger.jsonl');
  const expectedPriorSeq = events[0].seq - 1;
  const currentText = readSecureFile(dirname(dirname(dir)), p).toString('utf8');
  const current = parseLedgerFile(currentText);
  const actualPriorSeq = current.valid ? (current.logicalHead?.seq ?? 0) : null;
  if (actualPriorSeq !== expectedPriorSeq) {
    throw ioError('SC903', `the ledger changed underneath this command (expected head ${expectedPriorSeq}, found ${actualPriorSeq ?? 'an invalid ledger'}); nothing was written, re-run the command`);
  }
  const line = `${currentText.endsWith('\n') ? '' : '\n'}${JSON.stringify({ schema: BATCH_SCHEMA, events })}\n`;
  const candidate = parseLedgerFile(`${currentText}${line}`);
  if (!candidate.valid) throw bundleError('SC104', `refusing to append an invalid ledger batch: ${candidate.errors[0]?.detail ?? 'invalid ledger'}`);
  const fd = openSync(p, constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw ioError('SC103', 'ledger must be a regular single-linked file');
    writeFileSync(fd, line, { encoding: 'utf8' });
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function nextSeq(ledger) { return (ledger.logicalHead?.seq ?? 0) + 1; }

// ------------------------------------------------------------------- check

function requireValidContract(bundle) {
  if (!bundle.contract) throw bundleError('SC202', 'contract.md is missing or unreadable');
  if (bundle.contract.valid) return;
  // The parser already knows exactly which field failed and why. Collapsing
  // that into "contract.md is not currently valid" leaves the caller no move
  // except to mutate the file and guess, so pass its own diagnostics through.
  const parsed = (bundle.contract.errors ?? []).filter((d) => d.severity === 'error');
  throw bundleErrors(parsed.length
    ? parsed
    : [{ code: 'SC202', severity: 'error', location: null, detail: 'contract.md is not currently valid' }]);
}

function capabilityIdsUsedByPlan(contract) {
  return new Set(contract.plan.steps.map((s) => s.capability));
}

function checkCompactEligibility(bundle, args) {
  const { contract } = bundle;
  requireValidContract(bundle);

  // Collect, do not throw on the first hit: a proposal that is both missing
  // its plan and holding an unready capability should say so once.
  const blockers = [];
  const block = (detail) => blockers.push({ code: 'SC221', severity: 'error', location: null, detail });

  if (contract.header.mode !== 'compact') block('mode is not compact');
  if (contract.plan.pending || contract.plan.steps.length === 0) {
    block('plan must be complete for the compact gate; replace "Pending until terms approval." with real steps');
  }
  for (const c of contract.terms.capabilities) {
    if (c.readiness !== 'ready') block(`capability ${c.id} is ${c.readiness}, but Compact requires ready`);
  }
  for (const s of contract.plan.steps) {
    if (s.effect !== 'none' && s.effect !== 'read-external') block(`step ${s.id} effect ${s.effect} is not allowed in Compact`);
    if (!s.reversible) block(`step ${s.id} must be reversible`);
    if (effectRequiresGate(s.effect)) block(`step ${s.id} requires an action gate, so it cannot run under Compact`);
  }
  if (bundle.ledger.valid && bundle.ledger.events.some((e) => e.type === 'step-started' || e.type === 'recovery-opened')) {
    block('task already has execution or recovery history');
  }
  for (const flag of ['single-session', 'private', 'no-sensitive-data', 'not-consequential', 'continuous']) {
    if (!args[flag]) block(`--${flag} is required for the compact gate`);
  }
  const needed = capabilityIdsUsedByPlan(contract);
  const provided = new Set(args['readiness-confirmed']);
  for (const id of needed) if (!provided.has(id)) block(`--readiness-confirmed ${id} is required`);

  if (blockers.length) throw bundleErrors(blockers);
}

function cmdCheck(args) {
  const bundle = loadBundle(args.workspace, args.task);
  if (!bundle.exists) throw bundleError('SC301', 'task does not exist; run init first');
  if (bundle.layoutIssues.length) throw bundleError('SC101', bundle.layoutIssues.join('; '));
  if (!bundle.ledger.valid) throw bundleError('SC104', 'ledger is not valid');
  const recovery = recoveryView(bundle.ledger);
  if (recovery.open) throw bundleError('SC601', 'an open recovery must be resolved first');
  const derived = deriveState({ contract: bundle.contract, acceptance: bundle.acceptance, ledger: bundle.ledger });
  if (derived.state === 'cancelled') throw bundleError('SC304', 'task is cancelled');
  validateRevisionAndIds(bundle);

  const gate = args.gate;
  const lock = acquireLock(bundle.scRoot, args.task, 'check');
  try {
    if (gate === 'compact') checkCompactEligibility(bundle, args);
    else if (gate === 'terms') {
      requireValidContract(bundle);
      if (bundle.contract.header.mode !== 'full') throw bundleError('SC221', 'terms gate requires mode full');
    } else if (gate === 'execution') {
      requireValidContract(bundle);
      if (bundle.contract.plan.pending) throw bundleError('SC206', 'plan is still pending');
      const approvals = computeApprovals(bundle.ledger, bundle.contract);
      if (!approvals.termsApproved) throw bundleError('SC401', 'terms are not currently approved');
      const needed = capabilityIdsUsedByPlan(bundle.contract);
      for (const id of needed) {
        const cap = bundle.contract.capabilitiesById.get(id);
        if (!EXECUTABLE_READINESS.has(cap.readiness)) throw bundleError('SC401', `capability ${id} is not executable (${cap.readiness})`);
      }
      if (bundle.contract.header.mode === 'compact') {
        for (const flag of ['single-session', 'private', 'no-sensitive-data', 'not-consequential', 'continuous']) {
          if (!args[flag]) throw bundleError('SC221', `--${flag} is required for the compact execution gate`);
        }
      }
      const provided = new Set(args['readiness-confirmed']);
      for (const id of needed) if (!provided.has(id)) throw bundleError('SC221', `--readiness-confirmed ${id} is required`);
    } else if (gate === 'action') {
      handleActionCheckPreconditions(bundle, args, derived);
    } else {
      throw usageError('--gate must be compact, terms, execution, or action');
    }

    const revision = bundle.contract.header.revision;
    const capabilities = bundle.contract.terms.capabilities.map((c) => ({ id: c.id, needDigest: digest({ need: c.need }), binding: c }));
    const steps = bundle.contract.plan.pending ? [] : bundle.contract.plan.steps.map((s) => ({ id: s.id, digest: stepDigest(s, bundle.contract.capabilitiesById.get(s.capability)), step: s }));
    const t = now();
    const recordSeq = nextSeq(bundle.ledger);
    const contractRecorded = {
      seq: recordSeq, at: t, type: 'contract-recorded', revision, mode: bundle.contract.header.mode,
      termsDigest: bundle.contract.termsDigest, termsContentDigest: bundle.contract.termsContentDigest,
      planDigest: bundle.contract.planDigest, contractDigest: bundle.contract.contractDigest,
      capabilities, steps,
    };
    const { token, tokenDigest } = newToken();
    const preparedSeq = recordSeq + 1;
    const gatePrepared = { seq: preparedSeq, at: t, type: 'gate-prepared', gate, recordSeq, tokenDigest };
    let actionExtra = null;
    if (gate === 'compact' || (gate === 'execution' && bundle.contract.header.mode === 'compact')) {
      gatePrepared.eligibility = ['single-session', 'private', 'no-sensitive-data', 'not-consequential', 'continuous'];
    }
    if (gate === 'compact' || gate === 'execution' || gate === 'action') {
      gatePrepared.readinessConfirmed = [...args['readiness-confirmed']];
    }
    let displayAction = null;
    if (gate === 'action') {
      actionExtra = buildActionExtra(bundle, args, derived);
      Object.assign(gatePrepared, actionExtra.eventFields);
      displayAction = actionExtra.display;
    }

    appendBatch(bundle.dir, [contractRecorded, gatePrepared]);

    const resp = baseResponse('check', args.task);
    resp.revision = revision;
    resp.state = 'awaiting-approval';
    resp.next = `request-${gate}-approval`;
    resp.digests = { terms: bundle.contract.termsDigest, termsContent: bundle.contract.termsContentDigest, plan: bundle.contract.planDigest, contract: bundle.contract.contractDigest, acceptance: bundle.acceptanceBytes ? rawDigest(bundle.acceptanceBytes) : null };
    resp.ledger = { batches: bundle.ledger.batches.length + 1, seq: preparedSeq, businessSeq: preparedSeq };
    resp.gate = { type: gate, preparedSeq, stepId: actionExtra?.eventFields.stepId ?? null };
    resp.options = decisionOptions(gate);
    resp.token = token;
    const { review, summary } = gateReview(gate, bundle.contract, args, displayAction);
    resp.display = { summary, review, action: displayAction };
    emit(resp);
  } finally {
    lock.release();
  }
}

function recordForAuthorization(ledger, authorization) {
  const prepared = ledger.events.find((e) => e.seq === authorization?.preparedSeq);
  return prepared ? ledger.events.find((e) => e.seq === prepared.recordSeq) : null;
}

function validateRevisionAndIds(bundle) {
  requireValidContract(bundle);
  const { contract, ledger } = bundle;
  const revision = contract.header.revision;
  const h = maxRecordedRevision(ledger);
  if ((h === 0 && revision !== 1) || (h > 0 && revision !== h && revision !== h + 1)) {
    throw bundleError('SC205', `revision must be ${h || 1}${h ? ` or ${h + 1}` : ''}`);
  }
  if (h > 0 && revision === h + 1) {
    const started = ledger.events.some((e) => e.type === 'step-started' && e.revision === h);
    const recovered = ledger.events.some((e) => e.type === 'recovery-opened');
    const auth = ledger.events.filter((e) => e.type === 'execution-authorized' && e.revision === h).at(-1);
    const prior = recordForAuthorization(ledger, auth) ?? latestRecordForRevision(ledger, h);
    const changed = prior && (prior.termsContentDigest !== contract.termsContentDigest || prior.planDigest !== contract.planDigest);
    if (!started && !recovered) throw bundleError('SC205', 'revision may not increase before execution or recovery requires it');
    if (!changed && !recovered) throw bundleError('SC205', 'revision may not increase when contract semantics are unchanged');
    if ((started || recovered) && contract.header.mode !== 'full') throw bundleError('SC221', 'an executed or recovered revision must upgrade to full');
  }
  if (h > 0 && revision === h) {
    const started = ledger.events.some((e) => e.type === 'step-started' && e.revision === h);
    const auth = ledger.events.filter((e) => e.type === 'execution-authorized' && e.revision === h).at(-1);
    const prior = recordForAuthorization(ledger, auth);
    if (started && prior && (prior.termsContentDigest !== contract.termsContentDigest || prior.planDigest !== contract.planDigest)) {
      throw bundleError('SC205', 'semantic changes after execution starts require revision +1');
    }
    const latestRecovery = ledger.events.filter((e) => e.type === 'recovery-opened').at(-1);
    if (latestRecovery && revision <= latestRecovery.revision) throw bundleError('SC205', 'recovery requires a full contract at revision H+1');
  }
  validateHistoricalIds(contract, ledger);
}

function validateHistoricalIds(contract, ledger) {
  const records = ledger.events.filter((e) => e.type === 'contract-recorded');
  const latest = records.at(-1);
  for (const cap of contract.terms.capabilities) {
    const old = records.flatMap((r) => r.capabilities).find((c) => c.id === cap.id);
    if (old && old.needDigest !== digest({ need: cap.need })) throw bundleError('SC205', `capability ${cap.id} need may not change`);
  }
  for (const [kind, current, field] of [['capability', contract.terms.capabilities, 'capabilities'], ['step', contract.plan.steps, 'steps']]) {
    const historicIds = new Set(records.flatMap((r) => r[field]).map((x) => x.id));
    const latestIds = new Set((latest?.[field] ?? []).map((x) => x.id));
    const max = Math.max(0, ...[...historicIds].map((id) => Number(id.slice(1))));
    for (const item of current) {
      if (historicIds.has(item.id) && !latestIds.has(item.id)) throw bundleError('SC205', `retired ${kind} ID ${item.id} may not be reused`);
      if (!historicIds.has(item.id) && Number(item.id.slice(1)) <= max) throw bundleError('SC205', `new ${kind} IDs must exceed historical maximum ${max}`);
    }
  }
}

function decisionOptions(gate) {
  if (gate === 'compact') {
    return [
      { id: 'approve-plan-only', label: 'Approve only, do not execute', actionKind: 'cli', command: 'approve', arguments: ['--decision', 'approve-plan-only'] },
      { id: 'approve-and-execute', label: 'Approve and execute', actionKind: 'cli', command: 'approve', arguments: ['--decision', 'approve-and-execute'] },
      { id: 'revise', label: 'Revise the contract', actionKind: 'agent' },
      { id: 'use-full', label: 'Use the Full review instead', actionKind: 'agent' },
    ];
  }
  if (gate === 'terms') {
    return [
      { id: 'approve', label: 'Approve the contract terms', actionKind: 'cli', command: 'approve', arguments: ['--decision', 'approve'] },
      { id: 'revise', label: 'Revise the terms', actionKind: 'agent' },
      { id: 'cancel', label: 'Cancel', actionKind: 'cli', command: 'approve', arguments: ['--decision', 'cancel'] },
    ];
  }
  if (gate === 'execution') {
    return [
      { id: 'approve-plan-only', label: 'Approve the plan, do not execute', actionKind: 'cli', command: 'approve', arguments: ['--decision', 'approve-plan-only'] },
      { id: 'approve-and-execute', label: 'Approve and execute', actionKind: 'cli', command: 'approve', arguments: ['--decision', 'approve-and-execute'] },
      { id: 'revise', label: 'Revise the plan', actionKind: 'agent' },
      { id: 'cancel', label: 'Cancel', actionKind: 'cli', command: 'approve', arguments: ['--decision', 'cancel'] },
    ];
  }
  return [
    { id: 'approve', label: 'Approve this action', actionKind: 'cli', command: 'approve', arguments: ['--decision', 'approve'] },
    { id: 'cancel', label: 'Cancel', actionKind: 'cli', command: 'approve', arguments: ['--decision', 'cancel'] },
  ];
}

/**
 * Build the card the user actually reads before granting authority.
 *
 * This is a requirements confirmation, not a file summary: the reviewer is
 * being asked whether we understood the job, so the decisions we made on
 * their behalf matter more than our prose. Leaving it to the agent produced
 * a different shape every run and let the important part -- the assumptions
 * -- go unmentioned, so the CLI renders it from the parsed contract and the
 * agent only relays it.
 */
function gateReview(gate, contract, args, action) {
  if (gate === 'action') {
    const review = {
      task: contract.header.task,
      title: contract.header.title,
      mode: contract.header.mode,
      revision: contract.header.revision,
      confirming: 'the exact runtime action',
      target: action.target,
      summary: action.summary,
      cost: action.cost,
      irreversibleImpact: action.irreversibleImpact,
      alternatives: action.alternatives,
      details: action.details,
      binding: action.binding,
      reason: action.reason,
      consequence: action.consequence,
    };
    return { review, summary: renderActionReview(review) };
  }
  const t = contract.terms;
  const bullets = (items) => (items.length ? items : ['(none stated)']);

  const review = {
    task: contract.header.task,
    title: contract.header.title,
    mode: contract.header.mode,
    revision: contract.header.revision,
    confirming: gate === 'execution'
      ? 'the plan that will run'
      : 'what you asked for, before any work starts',
    objective: { problem: t.problem, outcome: t.outcomeAudience },
    scope: { in: bullets(t.scopeIn), out: bullets(t.scopeOut) },
    constraints: t.constraints.map((c) => ({ name: c.name, value: c.value })),
    criteria: t.criteria.map((c) => ({ id: c.id, criterion: c.criterion, verification: c.verification })),
    // What we decided without asking. This is the part a reviewer is most
    // likely to overturn, so it is never folded into another section.
    decidedForYou: t.assumptions.map((a) => ({ id: a.id, assumption: a.assumption, basis: a.basis, ifWrong: a.ifWrong })),
    capabilities: t.capabilities.map((c) => ({ id: c.id, need: c.need, primary: c.primary, readiness: c.readiness, fallback: c.fallback })),
    plan: contract.plan.pending ? null : contract.plan.steps.map((s) => ({
      id: s.id, title: s.title, action: s.action, verify: s.verify,
      effect: s.effect, reversible: s.reversible, dependsOn: s.dependsOn,
    })),
    grants: gateGrants(gate, contract, args),
  };
  return { review, summary: renderReview(gate, review) };
}

/** Say plainly what approving actually authorizes, in the reviewer's terms. */
function gateGrants(gate, contract, args) {
  if (gate === 'terms') return ['Agreement on the objective, scope, constraints, and success criteria. No work runs yet.'];
  if (gate === 'action') return ['This one external action, once.'];
  const steps = contract.plan.pending ? [] : contract.plan.steps;
  const effects = [...new Set(steps.map((s) => s.effect))];
  const gated = effects.filter((e) => GATED_EFFECTS.has(e));
  const irreversible = steps.filter((s) => !s.reversible).map((s) => s.id);
  const out = [];
  out.push(gate === 'compact'
    ? 'Approving and executing runs every step below without stopping again.'
    : 'Approving the plan freezes it; approving and executing also runs it.');
  if (steps.length && irreversible.length === 0 && effects.every((e) => e === 'none')) {
    out.push('Every step has effect none and is reversible.');
  } else {
    if (effects.some((e) => e !== 'none')) out.push(`Step effects: ${effects.join(', ')}.`);
    if (irreversible.length) out.push(`Irreversible steps: ${irreversible.join(', ')}.`);
  }
  if (gated.length) out.push(`${gated.join(', ')} steps still stop for their own approval.`);
  return out;
}

function renderActionReview(r) {
  return [
    `Confirm the exact runtime action — ${r.title}  [${r.mode}, revision ${r.revision}]`,
    '',
    `Target: ${r.target}`,
    `Summary: ${r.summary}`,
    `Cost: ${r.cost}`,
    `Irreversible impact: ${r.irreversibleImpact}`,
    `Alternatives: ${r.alternatives}`,
    'Details:',
    JSON.stringify(r.details, null, 2),
    `Binding: ${r.binding}`,
    `Reason: ${r.reason}`,
    `Consequence: ${r.consequence}`,
  ].join('\n');
}

function renderReview(gate, r) {
  const L = [];
  const head = gate === 'execution' ? 'Confirm the plan' : 'Confirm the requirement';
  L.push(`${head} — ${r.title}  [${r.mode}, revision ${r.revision}]`);
  L.push('');
  L.push(`You are confirming ${r.confirming}.`);
  L.push('');
  L.push('WHAT YOU ASKED FOR');
  L.push(`  Problem  ${r.objective.problem}`);
  L.push(`  Outcome  ${r.objective.outcome}`);
  L.push('');
  L.push('IN SCOPE');
  for (const s of r.scope.in) L.push(`  + ${s}`);
  L.push('NOT IN SCOPE');
  for (const s of r.scope.out) L.push(`  - ${s}`);
  L.push('');
  L.push('CONSTRAINTS');
  for (const c of r.constraints) L.push(`  ${c.name}: ${c.value}`);
  L.push('');
  L.push('DONE MEANS');
  for (const c of r.criteria) L.push(`  ${c.id}  ${c.criterion}\n        checked by: ${c.verification}`);
  L.push('');
  L.push('DECIDED FOR YOU — change any of these if they are wrong');
  if (r.decidedForYou.length === 0) L.push('  (nothing; everything above came from you)');
  for (const a of r.decidedForYou) L.push(`  ${a.id}  ${a.assumption}\n        because: ${a.basis}\n        if wrong: ${a.ifWrong}`);
  L.push('');
  L.push('WILL USE');
  for (const c of r.capabilities) {
    const fb = /^none$/i.test(c.fallback) ? '' : `, else ${c.fallback}`;
    L.push(`  ${c.id}  ${c.need} — ${c.primary} (${c.readiness}${fb})`);
  }
  L.push('');
  if (r.plan) {
    L.push('PLAN');
    for (const s of r.plan) {
      const dep = s.dependsOn.length ? ` after ${s.dependsOn.join(', ')}` : '';
      const rev = s.reversible ? '' : ', NOT reversible';
      L.push(`  ${s.id}  ${s.title}${dep}`);
      L.push(`        ${s.action}`);
      L.push(`        verify: ${s.verify}  [${s.effect}${rev}]`);
    }
    L.push('');
  }
  L.push('APPROVING MEANS');
  for (const g of r.grants) L.push(`  ${g}`);
  return L.join('\n');
}

function handleActionCheckPreconditions(bundle, args, derived) {
  if (!args.step) throw usageError('--step is required for the action gate');
  const step = bundle.contract.stepsById.get(args.step);
  if (!step) throw bundleError('SC501', `unknown step ${args.step}`);
  if (!effectRequiresGate(step.effect)) throw bundleError('SC501', `step ${args.step} does not require an action gate`);
  const binding = args.binding;
  if (binding !== 'primary' && binding !== 'fallback') throw usageError('--binding must be primary or fallback');
  requireExactReadiness(args, step.capability);

  // An action gate authorizes one real call; it never substitutes for the
  // approval that authorized the plan containing it. Without this, a payment
  // step in a never-approved contract could be gated and approved on its own,
  // which inverts the entire model.
  const approvals = computeApprovals(bundle.ledger, bundle.contract);
  if (!approvals.executionAuthorized) {
    throw bundleError('SC401', 'execution is not authorized for the current contract; approve the plan before gating any action inside it');
  }
  if (derived.current !== args.step) {
    throw bundleError('SC501', `step ${args.step} is not the current schedulable step`);
  }

  // A confirmed-occurred effect is re-inspected, never re-performed.
  const revision = bundle.contract.header.revision;
  const obligations = occurredRecoveryObligations(bundle.ledger);
  if (obligations.some((o) => o.ref === step.output && !occurredObligationClosed(bundle.ledger, args.step, o.resolvedSeq))) {
    throw bundleError('SC601', 'a resolved recovery confirmed this step\'s effect already occurred; close it with step revalidate --basis recovery-occurred instead of performing it again');
  }

  const memo = new Map();
  const states = foldRevision(revision, bundle.ledger, memo);
  const s = states.get(args.step);
  const status = s?.status ?? 'pending';
  if (binding === 'primary') {
    if (status !== 'pending' && !(status === 'failed' || status === 'blocked')) throw bundleError('SC501', `step ${args.step} is not eligible to start`);
  } else {
    if (status !== 'failed' && status !== 'blocked') throw bundleError('SC501', 'fallback requires the primary attempt to have failed or been blocked');
    const cap = bundle.contract.capabilitiesById.get(step.capability);
    if (!cap || /^none$/i.test(cap.fallback)) throw bundleError('SC503', 'this capability has no fallback');
    if (bundle.ledger.events.some((e) => e.type === 'fallback-invoked' && e.revision === revision && e.stepId === args.step)) {
      throw bundleError('SC503', 'fallback has already been used this revision');
    }
    if (!args.reason || args.reason.trim() === '') throw usageError('--reason is required for a fallback action gate');
  }
}

function buildActionExtra(bundle, args, derived) {
  const step = bundle.contract.stepsById.get(args.step);
  const cap = bundle.contract.capabilitiesById.get(step.capability);
  if (!args['action-json']) throw usageError('--action-json is required for the action gate');
  const { abs: actionPath, rel: actionSource } = resolveWorkspaceFile(bundle.workspaceReal, args['action-json']);
  const raw = readSecureFile(bundle.workspaceReal, actionPath).toString('utf8');
  const parsed = parseActionJsonText(raw);
  const shape = validateActionJsonShape(parsed, step.effect);
  if (!shape.valid) throw bundleError('SC206', `action JSON is invalid: ${shape.errors.join('; ')}`);
  const expandedDetails = { ...parsed.details };
  for (const { field, array } of pathFields(step.effect)) {
    if (array) {
      expandedDetails[field] = parsed.details[field].map((p) => expandPath(bundle.workspaceReal, p));
    } else {
      expandedDetails[field] = expandPath(bundle.workspaceReal, parsed.details[field]);
    }
  }
  const actionPayload = { ...parsed, details: expandedDetails };
  const revision = bundle.contract.header.revision;
  const memo = new Map();
  const states = foldRevision(revision, bundle.ledger, memo);
  const s = states.get(args.step);
  const attempt = attemptCountFor(bundle.ledger, revision, args.step) + 1;
  const reason = args.binding === 'fallback' ? args.reason : 'n/a';
  const actionDigest = computeActionDigest({ revision, stepId: args.step, attempt, effect: step.effect, binding: args.binding, actionPayload, step, capability: cap, reason });
  const eventFields = { stepId: args.step, attempt, effect: step.effect, binding: args.binding, reason, actionDigest, actionSource, actionPayload };
  return { eventFields, display: { ...actionPayload, binding: args.binding, reason, consequence: cap.consequence } };
}

function attemptCountFor(ledger, revision, stepId) {
  return ledger.events.filter((e) => e.type === 'step-started' && e.revision === revision && e.stepId === stepId).length;
}

function resolveWorkspacePath(workspaceReal, p) {
  if (isAbsolute(p)) throw ioError('SC103', `path must be workspace-relative: ${p}`);
  const abs = resolve(workspaceReal, p);
  assertContained(workspaceReal, abs);
  return abs;
}

function assertRegularFile(p) {
  if (!existsSync(p)) throw ioError('SC103', `file not found: ${p}`);
  const st = lstatSync(p);
  if (st.isSymbolicLink()) throw ioError('SC103', `must not be a symlink: ${p}`);
  if (!st.isFile()) throw ioError('SC103', `not a regular file: ${p}`);
}

function expandPath(workspaceReal, p) {
  const { abs, rel } = resolveWorkspaceFile(workspaceReal, p);
  const bytes = readSecureFile(workspaceReal, abs);
  return { path: rel, digest: rawDigest(bytes) };
}

function resolveWorkspaceFile(workspaceReal, p) {
  const abs = resolveWorkspacePath(workspaceReal, p);
  assertSafeChain(workspaceReal, abs, { leaf: 'file' });
  return { abs, rel: relative(workspaceReal, abs).split(sep).join('/') };
}

function requireExactReadiness(args, capabilityId) {
  const provided = args['readiness-confirmed'];
  if (provided.length !== 1 || provided[0] !== capabilityId) {
    throw usageError(`--readiness-confirmed must contain exactly ${capabilityId}`);
  }
}

// ----------------------------------------------------------------- approve

function cmdApprove(args) {
  const bundle = loadBundle(args.workspace, args.task);
  if (!bundle.exists || bundle.layoutIssues.length || !bundle.ledger.valid) throw bundleError('SC401', 'task bundle is not in a state that can be approved');
  const head = bundle.ledger.logicalHead;
  if (!head || head.type !== 'gate-prepared') throw tokenError('SC401', 'no gate is currently prepared');
  if (rawDigest(args.token ?? '') !== head.tokenDigest) throw tokenError('SC402', 'token does not match the prepared gate');

  const lock = acquireLock(bundle.scRoot, args.task, 'approve');
  try {
    // Re-derive digests from current bytes and compare to what was prepared.
    const record = bundle.ledger.events.find((e) => e.seq === head.recordSeq);
    if (!record) throw tokenError('SC403', 'prepared gate has no matching record');
    const contract = bundle.contract;
    if (record.termsDigest !== contract.termsDigest || record.planDigest !== contract.planDigest || record.contractDigest !== contract.contractDigest) {
      throw tokenError('SC403', 'contract has changed since the gate was prepared');
    }

    const gate = head.gate;
    const decision = args.decision;
    if (decision === 'cancel') {
      const t = now();
      appendBatch(bundle.dir, [{ seq: nextSeq(bundle.ledger), at: t, type: 'task-cancelled', reason: 'approval cancelled by user' }]);
      return emitReloaded('approve', args.task, bundle.workspaceReal, args.task);
    }

    const legalDecisions = { compact: ['approve-plan-only', 'approve-and-execute'], terms: ['approve'], execution: ['approve-plan-only', 'approve-and-execute'], action: ['approve'] };
    if (!legalDecisions[gate]?.includes(decision)) throw usageError(`decision "${decision}" is not legal for gate ${gate}`);

    const t = now();
    let events = [];
    let actionExtraDisplay = null;
    if (gate === 'compact') {
      requireReadinessConfirmed(bundle, contract, args, capabilityIdsUsedByPlan(contract));
      events.push({ seq: 0, at: t, type: 'terms-approved', preparedSeq: head.seq, revision: contract.header.revision, termsDigest: contract.termsDigest });
      events.push({ seq: 0, at: t, type: 'plan-approved', preparedSeq: head.seq, revision: contract.header.revision, termsDigest: contract.termsDigest, planDigest: contract.planDigest });
      if (decision === 'approve-and-execute') {
        events.push({ seq: 0, at: t, type: 'execution-authorized', preparedSeq: head.seq, revision: contract.header.revision, termsDigest: contract.termsDigest, planDigest: contract.planDigest });
      }
    } else if (gate === 'terms') {
      events.push({ seq: 0, at: t, type: 'terms-approved', preparedSeq: head.seq, revision: contract.header.revision, termsDigest: contract.termsDigest });
    } else if (gate === 'execution') {
      const approvals = computeApprovals(bundle.ledger, contract);
      requireReadinessConfirmed(bundle, contract, args, capabilityIdsUsedByPlan(contract));
      if (!approvals.planApproved) {
        events.push({ seq: 0, at: t, type: 'plan-approved', preparedSeq: head.seq, revision: contract.header.revision, termsDigest: contract.termsDigest, planDigest: contract.planDigest });
      }
      if (decision === 'approve-and-execute') {
        events.push({ seq: 0, at: t, type: 'execution-authorized', preparedSeq: head.seq, revision: contract.header.revision, termsDigest: contract.termsDigest, planDigest: contract.planDigest });
      } else if (approvals.planApproved) {
        throw usageError('plan is already approved; use approve-and-execute or a new gate');
      }
    } else if (gate === 'action') {
      if (!args['action-json']) throw usageError('--action-json is required to approve an action gate');
      const step = contract.stepsById.get(head.stepId);
      const cap = contract.capabilitiesById.get(step.capability);
      requireExactReadiness(args, step.capability);
      const { abs: actionPath, rel: relSource } = resolveWorkspaceFile(bundle.workspaceReal, args['action-json']);
      if (relSource !== head.actionSource) throw tokenError('SC404', 'action-json does not match the prepared source');
      const raw = readSecureFile(bundle.workspaceReal, actionPath).toString('utf8');
      const parsed = parseActionJsonText(raw);
      const shape = validateActionJsonShape(parsed, head.effect);
      if (!shape.valid) throw tokenError('SC404', `action JSON is invalid: ${shape.errors.join('; ')}`);
      const expandedDetails = { ...parsed.details };
      const sourceFiles = new Map();
      for (const { field, array } of pathFields(head.effect)) {
        const capture = (p) => {
          const { abs, rel } = resolveWorkspaceFile(bundle.workspaceReal, p);
          const bytes = readSecureFile(bundle.workspaceReal, abs);
          const expanded = { path: rel, digest: rawDigest(bytes) };
          sourceFiles.set(expanded.digest, bytes);
          return expanded;
        };
        expandedDetails[field] = array ? parsed.details[field].map(capture) : capture(parsed.details[field]);
      }
      const actionPayload = { ...parsed, details: expandedDetails };
      const actionDigest = computeActionDigest({ revision: record.revision, stepId: head.stepId, attempt: head.attempt, effect: head.effect, binding: head.binding, actionPayload, step, capability: cap, reason: head.reason });
      if (actionDigest !== head.actionDigest) throw tokenError('SC404', 'action payload has changed since the gate was prepared');
      const snapshotPayload = snapshotActionPayload(bundle, actionDigest, actionPayload, sourceFiles);
      actionExtraDisplay = { ...snapshotPayload, binding: head.binding, reason: head.reason, consequence: cap.consequence };
      events.push({ seq: 0, at: t, type: 'action-approved', preparedSeq: head.seq, revision: record.revision, stepId: head.stepId, attempt: head.attempt, effect: head.effect, binding: head.binding, actionDigest });
      if (head.binding === 'fallback') events.push({ seq: 0, at: t, type: 'fallback-invoked', revision: record.revision, stepId: head.stepId, attempt: head.attempt, capabilityId: step.capability, reason: head.reason });
      events.push({ seq: 0, at: t, type: 'step-started', revision: record.revision, stepId: head.stepId, attempt: head.attempt, binding: head.binding, readinessConfirmed: head.readinessConfirmed });
    }
    let seq = nextSeq(bundle.ledger);
    events = events.map((e) => ({ ...e, seq: seq++ }));
    const fresh = loadBundle(bundle.workspaceReal, args.task);
    if (fresh.contract?.contractDigest !== contract.contractDigest || fresh.ledger.logicalHead?.seq !== bundle.ledger.logicalHead?.seq) {
      throw tokenError('SC403', 'contract or ledger changed while approval was being committed');
    }
    appendBatch(bundle.dir, events);
    return emitReloaded('approve', args.task, bundle.workspaceReal, args.task, gate === 'action' ? 'perform-step' : undefined, [], actionExtraDisplay);
  } finally {
    lock.release();
  }
}

function requireReadinessConfirmed(bundle, contract, args, needed) {
  const provided = new Set(args['readiness-confirmed']);
  for (const id of needed) if (!provided.has(id)) throw usageError(`--readiness-confirmed ${id} is required`);
}

function snapshotActionPayload(bundle, actionDigest, actionPayload, sourceFiles) {
  const hex = actionDigest.slice('sha256:'.length);
  const dataDir = join(bundle.dir, 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir);
  assertSafeChain(bundle.workspaceReal, dataDir, { leaf: 'dir' });
  const actionsDir = join(dataDir, 'approved-actions');
  if (!existsSync(actionsDir)) mkdirSync(actionsDir);
  assertSafeChain(bundle.workspaceReal, actionsDir, { leaf: 'dir' });
  const dir = join(actionsDir, hex);
  const snapshotPayload = structuredClone(actionPayload);
  for (const [field, value] of Object.entries(snapshotPayload.details)) {
    const replace = (item) => isExpandedPath(item) ? { path: `.superclarity/${bundle.contract.header.task}/data/approved-actions/${hex}/files/${item.digest.slice(7)}`, digest: item.digest } : item;
    snapshotPayload.details[field] = Array.isArray(value) ? value.map(replace) : replace(value);
  }
  const payloadBytes = Buffer.from(JSON.stringify(snapshotPayload), 'utf8');
  if (existsSync(dir)) {
    assertSafeChain(bundle.workspaceReal, dir, { leaf: 'dir' });
    const expected = new Set(['payload.json', ...(sourceFiles.size ? ['files'] : [])]);
    const actual = new Set(readdirSync(dir));
    if (actual.size !== expected.size || [...actual].some((x) => !expected.has(x))) throw ioError('SC103', 'existing action snapshot has unexpected entries');
    if (!readSecureFile(bundle.workspaceReal, join(dir, 'payload.json')).equals(payloadBytes)) throw tokenError('SC404', 'existing action snapshot payload was modified');
    if (sourceFiles.size) {
      const filesDir = join(dir, 'files');
      assertSafeChain(bundle.workspaceReal, filesDir, { leaf: 'dir' });
      const names = readdirSync(filesDir);
      if (names.length !== sourceFiles.size) throw tokenError('SC404', 'existing action snapshot file set was modified');
      for (const [fileDigest, bytes] of sourceFiles) {
        const name = fileDigest.slice(7);
        if (!names.includes(name) || !readSecureFile(bundle.workspaceReal, join(filesDir, name)).equals(bytes)) throw tokenError('SC404', 'existing action snapshot content was modified');
      }
    }
    return snapshotPayload;
  }
  const staging = mkdtempSync(join(actionsDir, `.${hex}.tmp-`));
  try {
    if (sourceFiles.size) mkdirSync(join(staging, 'files'));
    writeExclusiveSynced(join(staging, 'payload.json'), payloadBytes);
    for (const [fileDigest, bytes] of sourceFiles) writeExclusiveSynced(join(staging, 'files', fileDigest.slice(7)), bytes);
    for (const name of readdirSync(staging)) {
      const p = join(staging, name);
      if (lstatSync(p).isFile()) chmodSync(p, 0o444);
      else for (const child of readdirSync(p)) chmodSync(join(p, child), 0o444);
    }
    renameSync(staging, dir);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return snapshotPayload;
}

function writeExclusiveSynced(path, bytes) {
  const fd = openSync(path, 'wx');
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

// -------------------------------------------------------------------- step

function requireCurrentStep(bundle, stepId) {
  const derived = deriveState({ contract: bundle.contract, acceptance: bundle.acceptance, ledger: bundle.ledger });
  if (derived.current !== stepId) throw bundleError('SC501', `step ${stepId} is not the current schedulable step`);
  return derived;
}

function cmdStepStart(args) {
  const bundle = loadBundle(args.workspace, args.task);
  requireValidContract(bundle);
  const step = bundle.contract.stepsById.get(args.step);
  if (!step) throw usageError(`unknown step ${args.step}`);
  if (effectRequiresGate(step.effect)) throw bundleError('SC501', 'this step requires an action gate; use check --gate action');
  requireCurrentStep(bundle, args.step);
  const revision = bundle.contract.header.revision;
  const obligations = occurredRecoveryObligations(bundle.ledger);
  if (obligations.some((o) => o.ref === step.output && !occurredObligationClosed(bundle.ledger, args.step, findSeqForRef(bundle.ledger, o)))) {
    throw bundleError('SC601', 'this step must be closed with step revalidate --basis recovery-occurred');
  }
  const provided = new Set([args['readiness-confirmed']].flat());
  if (!provided.has(step.capability)) throw usageError(`--readiness-confirmed ${step.capability} is required`);
  const attempt = attemptCountFor(bundle.ledger, revision, args.step) + 1;
  const lock = acquireLock(bundle.scRoot, args.task, 'step-start');
  try {
    appendBatch(bundle.dir, [{ seq: nextSeq(bundle.ledger), at: now(), type: 'step-started', revision, stepId: args.step, attempt, binding: 'primary', readinessConfirmed: [step.capability] }]);
  } finally { lock.release(); }
  emitReloaded('step-start', args.task, bundle.workspaceReal, args.task, 'perform-step');
}

function findSeqForRef(ledger, obligation) { return obligation.resolvedSeq; }
function cmdStepFallback(args) {
  const bundle = loadBundle(args.workspace, args.task);
  requireValidContract(bundle);
  const step = bundle.contract.stepsById.get(args.step);
  if (!step) throw usageError(`unknown step ${args.step}`);
  if (effectRequiresGate(step.effect)) throw bundleError('SC501', 'this step requires an action gate; use check --gate action --binding fallback');
  const revision = bundle.contract.header.revision;
  const memo = new Map();
  const states = foldRevision(revision, bundle.ledger, memo);
  const s = states.get(args.step);
  if (!s || (s.status !== 'failed' && s.status !== 'blocked')) throw bundleError('SC503', 'fallback requires the primary attempt to have failed or been blocked');
  const cap = bundle.contract.capabilitiesById.get(step.capability);
  if (!cap || /^none$/i.test(cap.fallback)) throw bundleError('SC503', 'this capability has no fallback');
  if (bundle.ledger.events.some((e) => e.type === 'fallback-invoked' && e.revision === revision && e.stepId === args.step)) throw bundleError('SC503', 'fallback already used this revision');
  if (!args.reason) throw usageError('--reason is required');
  const provided = new Set([args['readiness-confirmed']].flat());
  if (!provided.has(step.capability)) throw usageError(`--readiness-confirmed ${step.capability} is required`);
  const attempt = attemptCountFor(bundle.ledger, revision, args.step) + 1;
  const lock = acquireLock(bundle.scRoot, args.task, 'step-fallback');
  try {
    const t = now();
    appendBatch(bundle.dir, [
      { seq: nextSeq(bundle.ledger), at: t, type: 'fallback-invoked', revision, stepId: args.step, attempt, capabilityId: step.capability, reason: args.reason },
      { seq: nextSeq(bundle.ledger) + 1, at: t, type: 'step-started', revision, stepId: args.step, attempt, binding: 'fallback', readinessConfirmed: [step.capability] },
    ]);
  } finally { lock.release(); }
  emitReloaded('step-fallback', args.task, bundle.workspaceReal, args.task, 'perform-step');
}

function cmdStepFinish(args) {
  const bundle = loadBundle(args.workspace, args.task);
  requireValidContract(bundle);
  const revision = bundle.contract.header.revision;
  const running = bundle.ledger.events.filter((e) => e.type === 'step-started' && e.revision === revision)
    .filter((e) => !bundle.ledger.events.some((f) => (f.type === 'step-finished') && f.stepId === e.stepId && f.attempt === e.attempt && f.revision === revision && f.seq > e.seq));
  const current = running[running.length - 1];
  if (!current || current.stepId !== args.step) throw bundleError('SC502', 'no matching running attempt for this step');
  if (bundle.ledger.events.some((e) => e.type === 'recovery-opened' && e.seq > current.seq)) {
    throw bundleError('SC601', 'a recovery opened after this attempt started; the attempt can no longer be finished');
  }
  if (!['completed', 'failed', 'blocked'].includes(args.outcome)) throw usageError('--outcome must be completed, failed, or blocked');
  if (!args.detail) throw usageError('--detail is required');
  const evidence = buildEvidence(bundle.workspaceReal, args);
  if (args.outcome === 'completed' && evidence.length === 0) throw bundleError('SC504', 'completed requires at least one evidence item');
  const lock = acquireLock(bundle.scRoot, args.task, 'step-finish');
  try {
    appendBatch(bundle.dir, [{ seq: nextSeq(bundle.ledger), at: now(), type: 'step-finished', revision, stepId: args.step, attempt: current.attempt, outcome: args.outcome, detail: args.detail, evidence }]);
  } finally { lock.release(); }
  emitReloaded('step-finish', args.task, bundle.workspaceReal, args.task);
}

function cmdStepSkip(args) {
  const bundle = loadBundle(args.workspace, args.task);
  requireValidContract(bundle);
  const approvals = computeApprovals(bundle.ledger, bundle.contract);
  if (!approvals.executionAuthorized) throw bundleError('SC401', 'execution is not authorized for the current contract');
  requireCurrentStep(bundle, args.step);
  const revision = bundle.contract.header.revision;
  const memo = new Map();
  const states = foldRevision(revision, bundle.ledger, memo);
  const s = states.get(args.step);
  const status = s?.status ?? 'pending';
  if (!['pending', 'failed', 'blocked'].includes(status)) throw bundleError('SC501', 'only a pending, failed, or blocked step may be skipped');
  if (!args.decision || !args.impact) throw usageError('--decision and --impact are required');
  const lock = acquireLock(bundle.scRoot, args.task, 'step-skip');
  try {
    appendBatch(bundle.dir, [{ seq: nextSeq(bundle.ledger), at: now(), type: 'step-skipped', revision, stepId: args.step, decision: args.decision, impact: args.impact }]);
  } finally { lock.release(); }
  emitReloaded('step-skip', args.task, bundle.workspaceReal, args.task);
}

function cmdStepRevalidate(args) {
  const bundle = loadBundle(args.workspace, args.task);
  requireValidContract(bundle);
  const revision = bundle.contract.header.revision;
  const step = bundle.contract.stepsById.get(args.step);
  if (!step) throw usageError(`unknown step ${args.step}`);
  if (args.basis !== 'stale-evidence' && args.basis !== 'recovery-occurred') throw usageError('--basis must be stale-evidence or recovery-occurred');
  const memo = new Map();
  const states = foldRevision(revision, bundle.ledger, memo);
  const s = states.get(args.step);
  const cap = bundle.contract.capabilitiesById.get(step.capability);
  const digestNow = stepDigest(step, cap);
  if (args.basis === 'stale-evidence') {
    if (!s || s.status !== 'completed') throw bundleError('SC501', 'stale-evidence revalidation requires an existing completed result');
  } else {
    const obligations = occurredRecoveryObligations(bundle.ledger);
    const open = obligations.filter((o) => !occurredObligationClosed(bundle.ledger, args.step, o.resolvedSeq));
    const matchingSteps = bundle.contract.plan.steps.filter((candidate) => open.some((o) => o.ref === candidate.output));
    if (bundle.contract.header.mode !== 'full') throw bundleError('SC601', 'recovery-occurred revalidation requires mode full');
    if (!computeApprovals(bundle.ledger, bundle.contract).executionAuthorized) throw bundleError('SC401', 'recovery-occurred revalidation requires current execution authorization');
    if (open.length !== 1 || matchingSteps.length !== 1 || matchingSteps[0].id !== args.step) throw bundleError('SC601', 'occurred output must match exactly one current revalidation step');
    const derived = deriveState({ contract: bundle.contract, acceptance: bundle.acceptance, ledger: bundle.ledger });
    if (derived.current !== args.step) throw bundleError('SC501', 'revalidation step is not current');
    if (!/\b(verify|validate|inspect|confirm|check|revalidat)/i.test(step.action)) throw bundleError('SC601', 'recovery-occurred step action must verify rather than repeat the effect');
  }
  const evidence = buildEvidence(bundle.workspaceReal, args);
  if (evidence.length === 0) throw bundleError('SC504', 'at least one evidence item is required');
  const lock = acquireLock(bundle.scRoot, args.task, 'step-revalidate');
  try {
    appendBatch(bundle.dir, [{ seq: nextSeq(bundle.ledger), at: now(), type: 'step-revalidated', revision, stepId: args.step, stepDigest: digestNow, basis: args.basis, evidence }]);
  } finally { lock.release(); }
  emitReloaded('step-revalidate', args.task, bundle.workspaceReal, args.task);
}

function buildEvidence(workspaceReal, args) {
  const evidence = [];
  for (const f of args['evidence-file']) {
    const { abs, rel } = resolveWorkspaceFile(workspaceReal, f);
    evidence.push({ kind: 'file', ref: rel, digest: rawDigest(readSecureFile(workspaceReal, abs)) });
  }
  for (const ext of args['evidence-external']) {
    if (!ext.includes(':')) throw usageError('--evidence-external must contain a colon');
    evidence.push({ kind: 'external', ref: ext, digest: 'n/a' });
  }
  return evidence;
}

// -------------------------------------------------------------- acceptance

function cmdAccept(args) {
  const bundle = loadBundle(args.workspace, args.task);
  requireValidContract(bundle);
  if (!bundle.acceptance || !bundle.acceptance.valid) throw bundleError('SC701', 'acceptance.md is not currently valid');
  if (bundle.acceptance.header.contractRevision !== bundle.contract.header.revision) throw bundleError('SC701', 'acceptance contract_revision does not match the current contract revision');
  const recovery = recoveryView(bundle.ledger);
  if (recovery.open) throw bundleError('SC601', 'an open recovery must be resolved first');
  if (!computeApprovals(bundle.ledger, bundle.contract).executionAuthorized) {
    throw bundleError('SC401', 'execution is not authorized for the current contract');
  }
  const revision = bundle.contract.header.revision;
  const memo = new Map();
  const states = foldRevision(revision, bundle.ledger, memo);
  for (const step of bundle.contract.plan.steps) {
    const s = states.get(step.id);
    const status = s?.status ?? 'pending';
    if (!['completed', 'skipped'].includes(status)) throw bundleError('SC702', `step ${step.id} is not terminal`);
  }
  validateDeliverableLocations(bundle);
  validateAcceptanceEvidence(bundle, states);
  const anySkipped = [...states.values()].some((s) => s.status === 'skipped');
  const anyGap = bundle.acceptance.hasGaps;
  const anyNo = bundle.acceptance.criteria.some((c) => c.result !== 'yes');
  const verdict = args.verdict;
  if (!['complete', 'partial'].includes(verdict)) throw usageError('--verdict must be complete or partial');
  if (verdict === 'complete' && (anySkipped || anyGap || anyNo)) throw bundleError('SC704', 'complete requires all criteria yes, no skips, and no gaps');
  const acceptanceDigest = rawDigest(bundle.acceptanceBytes);
  const lock = acquireLock(bundle.scRoot, args.task, 'accept');
  try {
    appendBatch(bundle.dir, [{ seq: nextSeq(bundle.ledger), at: now(), type: 'acceptance-recorded', revision, verdict, acceptanceDigest }]);
  } finally { lock.release(); }
  emitReloaded('accept', args.task, bundle.workspaceReal, args.task);
}

function validateDeliverableLocations(bundle) {
  for (const row of bundle.acceptance.deliverables) {
    try {
      const { abs, rel } = resolveWorkspaceFile(bundle.workspaceReal, row.location);
      const internal = relative(bundle.scRoot, abs);
      if (internal === '' || (!internal.startsWith(`..${sep}`) && internal !== '..' && !isAbsolute(internal))) {
        throw new Error(`must be a user-facing file outside .superclarity/ (resolved ${rel})`);
      }
    } catch (e) {
      const detail = e instanceof CliError ? e.diagnostics[0]?.detail : e.message;
      throw bundleError('SC701', `deliverable ${row.id} location "${row.location}" is invalid: ${detail}`);
    }
  }
}

function validateAcceptanceEvidence(bundle, states) {
  const stepFinishedById = new Map();
  for (const e of bundle.ledger.events) {
    if (e.type === 'step-finished' || e.type === 'step-skipped' || e.type === 'step-revalidated') {
      const key = e.stepId;
      const list = stepFinishedById.get(key) ?? [];
      list.push(e);
      stepFinishedById.set(key, list);
    }
  }
  const resolveRef = (ref) => {
    if (/^L\d+$/.test(ref)) {
      const seq = Number(ref.slice(1));
      const ev = bundle.ledger.events.find((e) => e.seq === seq);
      if (!ev) return { ok: false };
      if (!['step-finished', 'step-skipped', 'step-revalidated'].includes(ev.type)) return { ok: false };
      return { ok: true, event: ev };
    }
    const at = ref.lastIndexOf('@');
    if (at === -1) return { ok: false };
    const relPath = ref.slice(0, at);
    const want = ref.slice(at + 1);
    try {
      const abs = resolve(bundle.workspaceReal, relPath);
      assertContained(bundle.workspaceReal, abs);
       const bytes = readSecureFile(bundle.workspaceReal, abs);
      if (rawDigest(bytes).slice(7, 19) !== want) return { ok: false };
      return { ok: true };
    } catch { return { ok: false }; }
  };
  for (const row of bundle.acceptance.deliverables) {
    for (const ref of row.evidence) if (!resolveRef(ref).ok) throw bundleError('SC703', `deliverable ${row.id} evidence ${ref} is not valid`);
  }
  for (const row of bundle.acceptance.criteria) {
    for (const ref of row.evidence) {
      const r = resolveRef(ref);
      if (!r.ok) throw bundleError('SC703', `criterion ${row.id} evidence ${ref} is not valid`);
      if (r.event && row.result === 'yes' && !['step-finished', 'step-revalidated'].includes(r.event.type)) throw bundleError('SC702', `criterion ${row.id} cannot be yes with a skipped reference`);
      if (r.event && r.event.type === 'step-finished' && r.event.outcome !== 'completed') throw bundleError('SC702', `criterion ${row.id} cannot cite a failed/blocked event`);
    }
  }
  for (const [stepId, status] of states) {
    if (status.status === 'completed') {
      for (const e of bundle.ledger.events) {
        if (e.type === 'step-revalidated' && e.stepId === stepId) continue; // superseded
      }
      const finish = [...bundle.ledger.events].reverse().find((e) => e.type === 'step-finished' && e.stepId === stepId && e.outcome === 'completed');
      const revalidated = [...bundle.ledger.events].reverse().find((e) => e.type === 'step-revalidated' && e.stepId === stepId);
      const evidenceList = revalidated ? revalidated.evidence : finish ? finish.evidence : [];
      for (const ev of evidenceList) {
        if (ev.kind !== 'file') continue;
        const abs = resolve(bundle.workspaceReal, ev.ref);
        try {
          assertContained(bundle.workspaceReal, abs);
           const bytes = readSecureFile(bundle.workspaceReal, abs);
          if (rawDigest(bytes) !== ev.digest) throw bundleError('SC703', `evidence for step ${stepId} is stale`);
        } catch (e) {
          if (e instanceof CliError) throw e;
          throw bundleError('SC703', `evidence for step ${stepId} is missing`);
        }
      }
    }
  }
}

// ----------------------------------------------------------------- recover

function cmdRecoverOpen(args) {
  const bundle = loadBundle(args.workspace, args.task);
  if (!bundle.ledger.valid) throw bundleError('SC104', 'ledger is not valid');
  const recovery = recoveryView(bundle.ledger);
  if (recovery.open) throw bundleError('SC601', 'a recovery is already open');
  if (!RECOVERY_CODE_OK(args.code)) throw usageError('--code must be unauthorized-work or uncertain-effect');
  if (!args.summary) throw usageError('--summary is required');
  const outputs = args.output.map((o) => {
    const idx = o.lastIndexOf('=');
    if (idx === -1) throw usageError('--output must be ref=effect');
    const ref = o.slice(0, idx).trim();
    const effect = o.slice(idx + 1).trim();
    if (!ref || !effect) throw usageError('--output ref and effect must both be non-empty');
    return { ref, effect };
  });
  if (outputs.length === 0) throw usageError('at least one --output is required');
  const revision = bundle.contract?.header?.revision ?? 1;
  const running = findRunningAttempt(bundle.ledger, revision);
  const event = { seq: nextSeq(bundle.ledger), at: now(), type: 'recovery-opened', revision, code: args.code, summary: args.summary, outputs };
  if (running) { event.stepId = running.stepId; event.attempt = running.attempt; }
  const lock = acquireLock(bundle.scRoot, args.task, 'recover-open');
  try { appendBatch(bundle.dir, [event]); } finally { lock.release(); }
  emitReloaded('recover-open', args.task, bundle.workspaceReal, args.task);
}

function RECOVERY_CODE_OK(v) { return v === 'unauthorized-work' || v === 'uncertain-effect'; }

function findRunningAttempt(ledger, revision) {
  const started = ledger.events.filter((e) => e.type === 'step-started' && e.revision === revision);
  for (const e of started) {
    const finished = ledger.events.some((f) => f.type === 'step-finished' && f.stepId === e.stepId && f.attempt === e.attempt && f.revision === revision && f.seq > e.seq);
    if (!finished) return e;
  }
  return null;
}

function cmdRecoverResolve(args) {
  const bundle = loadBundle(args.workspace, args.task);
  const recovery = recoveryView(bundle.ledger);
  if (!recovery.open) throw bundleError('SC602', 'no open recovery to resolve');
  if (!['discard', 'revalidate', 'stop'].includes(args.decision)) throw usageError('--decision must be discard, revalidate, or stop');
  if (!['occurred', 'confirmed-not-occurred', 'still-uncertain'].includes(args.reconciliation)) throw usageError('--reconciliation is required');
  if (!args.consequences) throw usageError('--consequences is required');
  const legal = {
    occurred: ['revalidate'],
    'confirmed-not-occurred': ['discard', 'revalidate'],
    'still-uncertain': ['stop'],
  };
  if (!legal[args.reconciliation].includes(args.decision)) throw bundleError('SC602', `${args.reconciliation} may only use ${legal[args.reconciliation].join(' or ')}`);
  const lock = acquireLock(bundle.scRoot, args.task, 'recover-resolve');
  try {
    appendBatch(bundle.dir, [{ seq: nextSeq(bundle.ledger), at: now(), type: 'recovery-resolved', openedSeq: recovery.open.opened.seq, decision: args.decision, reconciliation: args.reconciliation, consequences: args.consequences }]);
  } finally { lock.release(); }
  emitReloaded('recover-resolve', args.task, bundle.workspaceReal, args.task);
}

function cmdRecoverCancel(args) {
  const bundle = loadBundle(args.workspace, args.task);
  const recovery = recoveryView(bundle.ledger);
  if (recovery.open) throw bundleError('SC601', 'resolve the open recovery before cancelling');
  const revision = bundle.contract?.header?.revision ?? 1;
  if (findRunningAttempt(bundle.ledger, revision)) throw bundleError('SC501', 'reconcile the running step before cancelling');
  if (!args.reason) throw usageError('--reason is required');
  const lock = acquireLock(bundle.scRoot, args.task, 'recover-cancel');
  try {
    appendBatch(bundle.dir, [{ seq: nextSeq(bundle.ledger), at: now(), type: 'task-cancelled', reason: args.reason }]);
  } finally { lock.release(); }
  emitReloaded('recover-cancel', args.task, bundle.workspaceReal, args.task);
}

// ------------------------------------------------------------------ repair

function cmdRepair(args) {
  const workspaceReal = realWorkspace(args.workspace);
  const { scRoot, dir } = taskDir(workspaceReal, args.task);
  if (args.lock) {
    const outcome = repairLock(scRoot, args.task);
    const detail = outcome.cleared ? `lock claim cleared: ${outcome.reason}`
      : outcome.present === false ? outcome.reason
        : `lock claim left in place: ${outcome.reason}`;
    return emitReloaded('repair', args.task, workspaceReal, args.task, undefined, [{
      code: outcome.cleared ? 'SC905' : 'SC904',
      severity: outcome.cleared || outcome.present === false ? 'info' : 'warning',
      location: null,
      detail,
    }]);
  }
  const ledgerPath = join(dir, 'ledger.jsonl');
  const text = readFileSync(ledgerPath, 'utf8');
  const view = parseLedgerFile(text);
  if (view.valid || view.corruption?.kind !== 'tail') throw bundleError('SC104', 'nothing to repair: only a truncated final batch can be repaired');
  const lock = acquireLock(scRoot, args.task, 'repair');
  try {
    // Re-read under the lock: repair rewrites the whole file, so acting on a
    // view taken before the lock could discard a batch another process
    // appended in between.
    const fresh = readFileSync(ledgerPath, 'utf8');
    if (fresh !== text) {
      throw ioError('SC903', 'the ledger changed underneath this command; nothing was written, re-run the command');
    }
    const raw = view.corruption.raw;
    const lines = text.split('\n');
    const goodLines = lines.slice(0, view.batches.length);
    const discardedBytes = Buffer.from(raw, 'utf8');
    const repairEvent = { seq: (view.logicalHead?.seq ?? 0) + 1, at: now(), type: 'repair', discardedBase64: discardedBytes.toString('base64'), discardedDigest: rawDigest(discardedBytes), reason: 'interrupted append' };
    const newContent = `${goodLines.join('\n')}${goodLines.length ? '\n' : ''}${JSON.stringify({ schema: BATCH_SCHEMA, events: [repairEvent] })}\n`;
    const candidate = parseLedgerFile(newContent);
    if (!candidate.valid) throw bundleError('SC104', `repair candidate is invalid: ${candidate.errors[0]?.detail ?? 'invalid ledger'}`);
    const scratch = `${ledgerPath}.${process.pid}.tmp`;
    writeFileSync(scratch, newContent, { encoding: 'utf8', flag: 'wx' });
    renameSync(scratch, ledgerPath);
  } finally { lock.release(); }
  emitReloaded('repair', args.task, workspaceReal, args.task);
}

/**
 * Clear a lock claim only when it is provably dead. Returns why, because
 * reporting a bare success for a lock this command deliberately left in
 * place would be exactly the "claimed done without checking" failure the
 * whole protocol exists to prevent.
 */
function repairLock(scRoot, task) {
  const claimPath = join(scRoot, '.locks', `${task}.lock.claim`);
  if (!existsSync(claimPath)) return { cleared: false, present: false, reason: 'no lock claim was present; nothing to clear' };
  let parsed = null;
  assertSafeChain(dirname(scRoot), join(scRoot, '.locks'), { leaf: 'dir' });
  assertSafeChain(dirname(scRoot), claimPath, { leaf: 'file' });
  try { parsed = JSON.parse(readSecureFile(dirname(scRoot), claimPath).toString('utf8')); } catch { /* malformed/truncated */ }
  const st = lstatSync(claimPath);
  const ageMs = Date.now() - st.mtimeMs;
  if (!parsed) {
    if (ageMs > 60000) {
      rmSync(claimPath, { force: true });
      return { cleared: true, reason: 'the claim was unreadable and older than 60s' };
    }
    return { cleared: false, reason: 'the claim is unreadable but too recent to assume abandoned; retry in a minute' };
  }
  if (parsed.hostname !== hostnameSafe()) {
    return { cleared: false, reason: `the claim belongs to host "${parsed.hostname}"; this machine cannot tell whether that process is alive` };
  }
  if (pidAlive(parsed.pid)) {
    return { cleared: false, reason: `pid ${parsed.pid} is still running; wait for it or stop it first` };
  }
  rmSync(claimPath, { force: true });
  return { cleared: true, reason: `pid ${parsed.pid} on this host is gone` };
}

// ------------------------------------------------------------- reload/emit

function emitReloaded(command, task, workspaceReal, taskAgain, nextOverride, extraDiagnostics = [], displayAction = null) {
  const bundle = loadBundle(workspaceReal, task);
  const resp = baseResponse(command, task);
  const derived = stateSnapshot(bundle);
  fillCommon(resp, bundle, derived);
  if (nextOverride) resp.next = nextOverride;
  if (displayAction) resp.display = { summary: 'Approved action snapshot', action: displayAction };
  if (extraDiagnostics.length) resp.diagnostics = [...extraDiagnostics, ...(resp.diagnostics ?? [])];
  emit(resp);
}

// ---------------------------------------------------------------- dispatch

/**
 * The command surface, as data.
 *
 * This exists so an agent never has to read this file to learn how to drive
 * it. `--help` and a bare invocation both print it, so the CLI can describe
 * itself the way `status` describes a task.
 */
const USAGE = [
  'superclarity — task state lives in contract.md, ledger.jsonl, acceptance.md',
  '',
  'Always start a NEW task with `init`; never hand-write the three artifacts.',
  'Always resume an EXISTING task with `status`, then follow its `next`.',
  '',
  'Commands:',
  '  init      --workspace <dir> --task <slug> --mode compact|full',
  '  status    --workspace <dir> --task <slug>',
  '  check     --workspace <dir> --task <slug> --gate compact|terms|execution|action [...]',
  '  approve   --workspace <dir> --task <slug> --token <t> --decision <d> [...]',
  '  step      start|fallback|finish|skip|revalidate --workspace <dir> --task <slug> --step <id> [...]',
  '  accept    --workspace <dir> --task <slug> --verdict complete|partial',
  '  recover   open|resolve|cancel --workspace <dir> --task <slug> [...]',
  '  repair    --workspace <dir> --task <slug> [--lock]',
  '',
  'Every command prints one JSON object with `state`, `next`, and `diagnostics`.',
  'Follow `next`; do not re-derive state by reading the artifacts or this source.',
  'Full flag reference: references/cli.md',
].join('\n');

function emitUsage() {
  const resp = baseResponse('help', null);
  resp.state = 'drafting';
  resp.next = 'run-init';
  resp.display = { summary: USAGE, action: null };
  emit(resp);
  process.exitCode = 0;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    return emitUsage();
  }
  try {
    switch (command) {
      case 'init': return cmdInit(parseArgs(rest, OPTION_SPECS.init));
      case 'status': return cmdStatus(parseArgs(rest, OPTION_SPECS.status));
      case 'check': { const args = parseArgs(rest, OPTION_SPECS.check); return runLocked(args, 'check', cmdCheck); }
      case 'approve': { const args = parseArgs(rest, OPTION_SPECS.approve); return runLocked(args, 'approve', cmdApprove); }
      case 'step': {
        const sub = rest[0];
        const args2 = rest.slice(1);
        if (sub === 'start') { const args = parseArgs(args2, OPTION_SPECS['step-start']); return runLocked(args, 'step-start', cmdStepStart); }
        if (sub === 'fallback') { const args = parseArgs(args2, OPTION_SPECS['step-fallback']); return runLocked(args, 'step-fallback', cmdStepFallback); }
        if (sub === 'finish') { const args = parseArgs(args2, OPTION_SPECS['step-finish']); return runLocked(args, 'step-finish', cmdStepFinish); }
        if (sub === 'skip') { const args = parseArgs(args2, OPTION_SPECS['step-skip']); return runLocked(args, 'step-skip', cmdStepSkip); }
        if (sub === 'revalidate') { const args = parseArgs(args2, OPTION_SPECS['step-revalidate']); return runLocked(args, 'step-revalidate', cmdStepRevalidate); }
        throw usageError(`unknown step subcommand ${sub}`);
      }
      case 'accept': { const args = parseArgs(rest, OPTION_SPECS.accept); return runLocked(args, 'accept', cmdAccept); }
      case 'recover': {
        const sub = rest[0];
        const args2 = rest.slice(1);
        if (sub === 'open') { const args = parseArgs(args2, OPTION_SPECS['recover-open']); return runLocked(args, 'recover-open', cmdRecoverOpen); }
        if (sub === 'resolve') { const args = parseArgs(args2, OPTION_SPECS['recover-resolve']); return runLocked(args, 'recover-resolve', cmdRecoverResolve); }
        if (sub === 'cancel') { const args = parseArgs(args2, OPTION_SPECS['recover-cancel']); return runLocked(args, 'recover-cancel', cmdRecoverCancel); }
        throw usageError(`unknown recover subcommand ${sub}`);
      }
      case 'repair': {
        const args = parseArgs(rest, OPTION_SPECS.repair);
        return args.lock ? cmdRepair(args) : runLocked(args, 'repair', cmdRepair);
      }
      default: throw usageError(`unknown command ${command}`);
    }
  } catch (e) {
    const taskGuess = (() => { const idx = rest.indexOf('--task'); return idx !== -1 ? rest[idx + 1] : null; })();
    failFromError(command ?? 'unknown', taskGuess, e instanceof CliError ? e : new CliError(1, [{ code: 'SC900', severity: 'error', location: null, detail: e.stack ?? e.message }]));
  }
  if (process.exitCode === undefined) process.exitCode = 0;
}

main();
