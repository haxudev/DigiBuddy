#!/usr/bin/env node

import {
  appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseProfileContract } from './profile-contract.mjs';

const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const eventId = () => `evt-${randomBytes(16).toString('hex')}`;
const fail = (message) => { throw new Error(message); };
function appendEvent(ledger, event) {
  const history = events(ledger, false);
  const previous = history.at(-1)?.event_sha256 ?? 'none';
  const record = { ...event, previous_event_sha256: previous };
  record.event_sha256 = sha256(JSON.stringify(record));
  appendFileSync(ledger, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flush: true });
  const head = `${ledger}.head`;
  const temp = `${head}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(temp, record.event_sha256, { encoding: 'utf8', flag: 'wx', flush: true });
  renameSync(temp, head);
}
const validProfileId = (value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
// The verifier and this skill build the same manifest and neither may import
// the other, so key order must not be part of the agreement between them.
const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value));

function assertNoLinkedComponents(base, target) {
  let current = base;
  for (const part of relative(base, target).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || realpathSync(current).toLowerCase() !== resolve(current).toLowerCase()) {
        fail(`linked/reparse path component is not allowed: ${current}`);
      }
    }
  }
}

const configuredHome = () => process.env.NODE_ENV === 'test' && process.env.SUPERCLARITY_TEST_HOME
  ? resolve(process.env.SUPERCLARITY_TEST_HOME) : homedir();

function scopePaths({ scope, workspace = process.cwd(), profileId }) {
  if (!['project', 'user'].includes(scope)) fail('scope must be project or user');
  if (!validProfileId(profileId)) fail('invalid profile id');
  const base = scope === 'project' ? realpathSync(resolve(workspace)) : realpathSync(configuredHome());
  const profileRoot = join(base, '.superclarity', 'profiles');
  const learningRoot = join(base, '.superclarity', 'learning', profileId);
  assertNoLinkedComponents(base, profileRoot);
  assertNoLinkedComponents(base, learningRoot);
  return {
    target: join(profileRoot, `${profileId}.md`), learningRoot,
    ledger: join(learningRoot, 'events.jsonl'), lock: join(learningRoot, 'write.lock'),
  };
}

function acquire(lock) {
  mkdirSync(dirname(lock), { recursive: true });
  try {
    const fd = openSync(lock, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }), { flush: true });
    return fd;
  } catch { fail(`profile lock is held or unreadable: ${lock}; recover it explicitly`); }
}

function events(ledger, verify = true) {
  if (!existsSync(ledger)) {
    if (existsSync(`${ledger}.head`)) fail('ledger is missing but its head remains');
    return [];
  }
  const parsed = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (verify) {
    let previous = 'none';
    const byId = new Map();
    const allowed = new Set(['proposal-created', 'initialization-proposal', 'approved', 'rejected',
      'prepared', 'applied', 'aborted', 'rollback-prepared', 'rolled-back', 'rollback-aborted']);
    for (const event of parsed) {
      const { event_sha256: stored, ...withoutDigest } = event;
      if (event.previous_event_sha256 !== previous || stored !== sha256(JSON.stringify(withoutDigest))) {
        fail('ledger event chain is invalid');
      }
      previous = stored;
      if (!allowed.has(event.type) || byId.has(event.event_id)) fail('ledger event schema is invalid');
      const predecessor = byId.get(event.references_event_id);
      if (event.type === 'approved' && !['proposal-created', 'initialization-proposal'].includes(predecessor?.type)) fail('approval has no proposal');
      if (event.type === 'rejected' && predecessor?.type !== 'proposal-created') fail('rejection has no proposal');
      if (event.type === 'prepared' && predecessor?.type !== 'approved') fail('prepared has no approval');
      if (event.type === 'applied' && predecessor?.type !== 'prepared') fail('applied has no prepared event');
      if (event.type === 'aborted' && predecessor?.type !== 'prepared') fail('aborted has no prepared event');
      if (event.type === 'rollback-prepared' && predecessor?.type !== 'applied') fail('rollback has no applied event');
      if (['rolled-back', 'rollback-aborted'].includes(event.type)
          && predecessor?.type !== 'rollback-prepared') fail('rollback result has no prepared event');
      byId.set(event.event_id, event);
    }
    const headFile = `${ledger}.head`;
    if (!existsSync(headFile) || readFileSync(headFile, 'utf8').trim() !== previous) {
      fail('ledger head does not match its event chain');
    }
  }
  return parsed;
}

function ensureProjectId(workspace) {
  const state = join(resolve(workspace), '.superclarity');
  const file = join(state, 'project-id');
  mkdirSync(state, { recursive: true });
  if (!existsSync(file)) writeFileSync(file, `${randomUUID()}\n`, { encoding: 'utf8', flag: 'wx', flush: true });
  const value = readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9-]{36}$/.test(value)) fail('invalid project-id');
  return value;
}

function secretFile(root, name) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, name);
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'),
    { encoding: 'utf8', flag: 'wx', flush: true, mode: 0o600 });
  return readFileSync(file, 'utf8').trim();
}

const sourcePayload = ({ verification, ...payload }) => payload;
const projectSecret = (workspace) => {
  const file = join(resolve(workspace), '.superclarity', 'learning', '.source-verification-key');
  if (!existsSync(file)) fail('delivery verification key is missing');
  return readFileSync(file, 'utf8').trim();
};
const sourceSignature = (workspace, source) => createHmac('sha256', projectSecret(workspace))
  .update(JSON.stringify(sourcePayload(source))).digest('hex');

const PROOF_SCHEMA = 'delivery-proof/1';
const MANIFEST_SCHEMA = 'delivery-manifest/1';

/**
 * The verifier refused to seal a bundle that was not ready to deliver, so
 * re-deriving that state here would only repeat it with a second, weaker
 * reader. Recompute the closed manifest instead: every input the derivation read
 * is covered, so any byte that changed since sealing fails.
 *
 * A bundle sealed before the ledger existed keeps its own reader. Its approvals
 * cannot be recreated, and a source that verified yesterday has to keep
 * verifying tomorrow.
 */
export function verifyDeliveredSource({ workspace = process.cwd(), taskSlug, candidateId }) {
  if (!validProfileId(taskSlug) || !/^L[1-9]\d*$/.test(candidateId)) fail('invalid task or candidate id');
  const task = join(realpathSync(resolve(workspace)), '.superclarity', taskSlug);
  if (!existsSync(task) || realpathSync(task) !== task) fail('task directory is missing or is a link');
  const readTask = (name) => readFileSync(join(task, name), 'utf8');
  const readJson = (name) => {
    // A half-written sidecar is a refusal with a reason, not a stack trace.
    try { return JSON.parse(readTask(name)); } catch { fail(`${name} is not readable JSON`); }
    return null;
  };
  const optional = (name) => (existsSync(join(task, name)) ? sha256(readTask(name)) : 'none');
  const jsonDigest = (name) => sha256(JSON.stringify(readJson(name)));
  const report = readTask('report.md');
  // Which seal a bundle uses is declared by its brief, not guessed from which
  // files happen to be present: a stray manifest beside a schema 2 bundle, or a
  // stray ledger beside a schema 2 proof, would otherwise pick the wrong reader.
  const schemaVersion = Number(readTask('brief.md').match(/^schema_version:\s*(\d+)\s*$/m)?.[1] ?? '1');
  const ledgerBundle = schemaVersion >= 3;
  const sealFile = ledgerBundle ? 'delivery-manifest.json' : 'delivery-proof.json';
  const writer = ledgerBundle ? 'delivery-manifest.mjs' : 'delivery-proof.mjs';
  const schema = ledgerBundle ? MANIFEST_SCHEMA : PROOF_SCHEMA;
  if (ledgerBundle && existsSync(join(task, 'delivery-proof.json'))) fail('bundle carries both seals');
  if (!ledgerBundle && existsSync(join(task, 'delivery-manifest.json'))) fail('bundle carries both seals');
  if (!ledgerBundle && existsSync(join(task, 'ledger.jsonl'))) fail('schema 2 bundle carries a ledger');
  const proof = readJson(sealFile);
  if (proof.schema !== schema) {
    fail(`delivery seal schema is ${proof.schema ?? 'absent'}, not ${schema}; delete ${sealFile} and re-run ${writer}`);
  }
  const artifacts = ledgerBundle ? {
    profile: optional('profile.md'),
    brief: sha256(readTask('brief.md')),
    capabilities: sha256(readTask('capabilities.md')),
    plan: sha256(readTask('plan.md')),
    ledger: sha256(readTask('ledger.jsonl')),
    report: sha256(report),
  } : {
    profile: optional('profile.md'),
    brief: sha256(readTask('brief.md')),
    capabilities: sha256(readTask('capabilities.md')),
    plan: sha256(readTask('plan.md')),
    report: sha256(report),
    seal: sha256(readTask('report.seal.md')),
    recovery: optional('recovery.md'),
    observations: jsonDigest('observations.json'),
    artifact_times: jsonDigest('artifact-times.json'),
  };
  const planRevision = proof.plan_revision;
  const finalizedAt = proof.report_finalized_at;
  const proofPayload = ledgerBundle
    ? { schema, task_slug: taskSlug, plan_revision: planRevision,
      report_finalized_at: finalizedAt, sealed_at: proof.sealed_at, artifacts }
    : { schema, task_slug: taskSlug, plan_revision: planRevision,
      report_finalized_at: finalizedAt, artifacts };
  const expectedProof = createHmac('sha256', projectSecret(workspace))
    .update(canonical(proofPayload)).digest('hex');
  if (canonical(proof.artifacts) !== canonical(artifacts)
      || proof.task_slug !== taskSlug || !Number.isInteger(planRevision) || planRevision < 1
      || typeof finalizedAt !== 'string' || !finalizedAt
      || proof.signature !== `hmac-sha256:${expectedProof}`) fail('delivery seal does not match source bundle');
  // The directory name is not the bundle's identity. A bundle sealed under
  // another task's slug verifies against that slug and would be counted as an
  // independent delivery of work it never describes.
  if (readTask('brief.md').match(/^task_slug:\s*(\S+)\s*$/m)?.[1] !== taskSlug) {
    fail('sealed bundle belongs to a different task than its directory');
  }
  const lessonSection = report.split(/^## Reusable lesson candidates\s*$/m)[1]?.split(/\n## /, 1)[0] ?? '';
  const candidateLine = lessonSection.split('\n').find((line) => new RegExp(`^\\|\\s*${candidateId}\\s*\\|`).test(line));
  if (!candidateLine) fail('candidate is not in the sealed report');
  const cells = candidateLine.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  if (cells.length !== 5) fail('candidate row is malformed');
  const source = { project_id: ensureProjectId(workspace), task_slug: taskSlug,
    plan_revision: planRevision, report_finalized_at: finalizedAt, report_sha256: sha256(report),
    report_candidate_id: candidateId, candidate_target: cells[1], candidate_lesson: cells[2],
    candidate_applies_when: cells[3], candidate_evidence: cells[4], candidate_sha256: sha256(candidateLine) };
  source.verification = `hmac-sha256:${sourceSignature(workspace, source)}`;
  return source;
}

function globalSecret() {
  return secretFile(join(resolve(configuredHome()), '.superclarity', 'learning'), '.source-hmac-key');
}

function storedSource(scope, source, workspace) {
  if (source.verification !== `hmac-sha256:${sourceSignature(workspace, source)}`) {
    fail('source verification token is invalid');
  }
  if (scope === 'project') return sourcePayload(source);
  const identity = [source.project_id, source.task_slug, source.plan_revision, source.report_finalized_at,
    source.report_sha256].join('|');
  return { source_ref: `hmac-sha256:${createHmac('sha256', globalSecret()).update(identity).digest('hex')}` };
}

const globalAlias = (kind, value) => `${kind}-${createHmac('sha256', globalSecret())
  .update(`${kind}|${value}`).digest('hex').slice(0, 32)}`;

function canonicalDiff(before, after) {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const rows = oldLines.length + 1, cols = newLines.length + 1;
  const lcs = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = oldLines.length - 1; i >= 0; i--) for (let j = newLines.length - 1; j >= 0; j--) {
    lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1
      : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const operations = [];
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      operations.push(['=', oldLines[i]]); i++; j++;
    } else if (j < newLines.length && (i === oldLines.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      operations.push(['+', newLines[j++]]);
    } else operations.push(['-', oldLines[i++]]);
  }
  return JSON.stringify({ before_sha256: before ? sha256(before) : 'none',
    after_sha256: sha256(after), operations });
}

export function proposeProfileInitialization({ scope, workspace, profileId,
  baseSha256, beforeContent, afterContent }) {
  const diff = canonicalDiff(beforeContent, afterContent);
  const parsed = parseProfileContract(afterContent, profileId, scope);
  if (!parsed.valid) fail(`initial profile is invalid: ${parsed.errors.join('; ')}`);
  const paths = scopePaths({ scope, workspace, profileId });
  const fd = acquire(paths.lock);
  try {
    recoverPrepared({ ...paths, profileId });
    if (baseSha256 === 'none') {
      if (existsSync(paths.target) || beforeContent !== '') fail('initialization target already exists');
    } else if (!existsSync(paths.target) || sha256(readFileSync(paths.target, 'utf8')) !== baseSha256
        || readFileSync(paths.target, 'utf8') !== beforeContent) fail('fork base changed');
    const proposalId = eventId();
    appendEvent(paths.ledger, { event_id: proposalId, type: 'initialization-proposal', at: new Date().toISOString(),
      profile_id: profileId, candidate_id: 'initialization', references_event_id: 'none',
      payload: { scope, base_sha256: baseSha256, result_sha256: sha256(afterContent), target_path: resolve(paths.target),
        approved_diff: diff, before_content: beforeContent, after_content: afterContent } });
    return { proposalId, approvedDiff: diff, resultSha256: sha256(afterContent), afterContent };
  } finally { closeSync(fd); rmSync(paths.lock, { force: true }); }
}

function recoverPrepared({ target, ledger, profileId }) {
  const history = events(ledger);
  const resolved = new Set(history.filter((event) => ['applied', 'aborted'].includes(event.type))
    .map((event) => event.references_event_id));
  for (const prepared of history.filter((event) => event.type === 'prepared' && !resolved.has(event.event_id))) {
    if (prepared.profile_id !== profileId || resolve(prepared.payload.target_path) !== resolve(target)) {
      fail('prepared event does not belong to this profile target');
    }
    const current = existsSync(target) ? sha256(readFileSync(target, 'utf8')) : 'none';
    const type = current === prepared.payload.result_sha256 ? 'applied'
      : current === prepared.payload.base_sha256 ? 'aborted' : null;
    if (!type) fail('unresolved prepared event conflicts with current profile');
    appendEvent(ledger, { event_id: eventId(), type, at: new Date().toISOString(),
      profile_id: profileId, candidate_id: prepared.candidate_id,
      references_event_id: prepared.event_id, payload: { result_sha256: current, target_path: resolve(target) } });
  }
  const rollbackResolved = new Set(history.filter((event) => ['rolled-back', 'rollback-aborted'].includes(event.type))
    .map((event) => event.references_event_id));
  for (const prepared of history.filter((event) => event.type === 'rollback-prepared'
      && !rollbackResolved.has(event.event_id))) {
    if (prepared.profile_id !== profileId || resolve(prepared.payload.target_path) !== resolve(target)) {
      fail('rollback-prepared event does not belong to this profile target');
    }
    const current = existsSync(target) ? sha256(readFileSync(target, 'utf8')) : 'none';
    const type = current === prepared.payload.result_sha256 ? 'rolled-back'
      : current === prepared.payload.base_sha256 ? 'rollback-aborted' : null;
    if (!type) fail('unresolved rollback conflicts with current profile');
    appendEvent(ledger, { event_id: eventId(), type, at: new Date().toISOString(),
      profile_id: profileId, candidate_id: prepared.candidate_id,
      references_event_id: prepared.event_id,
      payload: { applied_event_id: prepared.references_event_id, result_sha256: current,
        target_path: resolve(target) } });
  }
}

export function recoverProfileLock({ scope, workspace, profileId }) {
  const paths = scopePaths({ scope, workspace, profileId });
  if (!existsSync(paths.lock)) return false;
  let owner;
  try { owner = JSON.parse(readFileSync(paths.lock, 'utf8')); } catch { fail('lock owner is unreadable; inspect manually'); }
  if (owner.host !== hostname()) fail('lock belongs to another host');
  try { process.kill(owner.pid, 0); fail(`lock owner pid ${owner.pid} is still alive`); } catch (error) {
    if (/still alive/.test(error.message)) throw error;
  }
  const claimed = `${paths.lock}.recover-${process.pid}-${randomBytes(8).toString('hex')}`;
  try { renameSync(paths.lock, claimed); } catch { fail('another recovery process claimed the lock'); }
  rmSync(claimed, { force: true });
  return true;
}

export function proposeProfileChange({ scope, workspace, profileId, candidateId,
  target, lessonText, baseSha256, beforeContent, afterContent, sources, overrideReason = '' }) {
  if (!/^cand-[a-f0-9]{32}$/.test(candidateId)) fail('invalid candidate id');
  if (!Array.isArray(sources) || sources.length === 0) fail('at least one verified source is required');
  if (!['pitfall', 'acceptance', 'skeleton'].includes(target) || !lessonText?.trim()) {
    fail('lesson proposal requires a target and synthesized lesson text');
  }
  if (sources.some((source) => source.candidate_target !== target)) fail('source candidate target does not match proposal');
  if (!afterContent.includes(lessonText)) fail('proposed profile does not contain the synthesized lesson');
  if (baseSha256 === 'none') fail('lesson promotion requires an initialized profile; use initialize first');
  const persistedSources = sources.map((source) => storedSource(scope, source, workspace));
  const sourceKeys = persistedSources.map((source) => source.source_ref ?? JSON.stringify([
    source.project_id, source.task_slug, source.plan_revision, source.report_finalized_at, source.report_sha256,
  ]));
  if (new Set(sourceKeys).size !== sourceKeys.length) fail('duplicate corroborating source');
  if (persistedSources.length < 2 && !overrideReason.trim()) {
    fail('one source requires an explicit early-promotion override reason');
  }
  const parsedAfter = parseProfileContract(afterContent, profileId, scope);
  if (!parsedAfter.valid) fail(`proposed profile is invalid: ${parsedAfter.errors.join('; ')}`);
  const parsedBefore = parseProfileContract(beforeContent, profileId, scope);
  if (!parsedBefore.valid) fail('approved base profile is invalid');
  const unchanged = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!unchanged(parsedBefore.dimensions, parsedAfter.dimensions)
      || !unchanged(parsedBefore.deferrable, parsedAfter.deferrable)
      || (target !== 'skeleton' && !unchanged(parsedBefore.stepItems, parsedAfter.stepItems))
      || (target !== 'acceptance' && !unchanged(parsedBefore.criterionItems, parsedAfter.criterionItems))
      || (target !== 'pitfall' && !unchanged(parsedBefore.pitfallItems, parsedAfter.pitfallItems))) {
    fail('lesson promotion changed content outside its approved target section');
  }
  const paths = scopePaths({ scope, workspace, profileId });
  const fd = acquire(paths.lock);
  try {
    recoverPrepared({ ...paths, profileId });
    const prior = events(paths.ledger);
    const persistedCandidateId = scope === 'user' ? globalAlias('cand', candidateId) : candidateId;
    if (prior.some((event) => event.type === 'rejected' && event.candidate_id === persistedCandidateId)) {
      fail('candidate was rejected; create a new candidate only with an explicit reconsideration decision');
    }
    const proposalId = eventId();
    const approvedDiff = canonicalDiff(beforeContent, afterContent);
    appendEvent(paths.ledger, { event_id: proposalId, type: 'proposal-created', at: new Date().toISOString(),
      profile_id: profileId, candidate_id: persistedCandidateId, references_event_id: 'none',
      payload: { scope, base_sha256: baseSha256,
        result_sha256: sha256(afterContent), target_path: resolve(paths.target), approved_diff: approvedDiff,
        before_content: beforeContent, after_content: afterContent, sources: persistedSources,
        target, lesson_text: lessonText,
        source_candidate_sha256: persistedSources.map((source) => source.candidate_sha256 ?? source.source_ref),
        override_reason: scope === 'user' && overrideReason
          ? `sha256:${createHash('sha256').update(overrideReason).digest('hex')}` : overrideReason } });
    return { proposalId, approvedDiff, resultSha256: sha256(afterContent), afterContent };
  } finally { closeSync(fd); rmSync(paths.lock, { force: true }); }
}

export function rejectProfileProposal({ scope, workspace, profileId, proposalId, reason }) {
  if (!reason?.trim()) fail('rejection reason is required');
  const paths = scopePaths({ scope, workspace, profileId });
  const fd = acquire(paths.lock);
  try {
    const history = events(paths.ledger);
    const proposal = history.find((event) => event.event_id === proposalId && event.type === 'proposal-created');
    if (!proposal) fail('proposal not found');
    if (history.some((event) => ['approved', 'rejected'].includes(event.type)
        && event.references_event_id === proposalId)) fail('proposal already decided');
    appendEvent(paths.ledger, { event_id: eventId(), type: 'rejected', at: new Date().toISOString(),
      profile_id: profileId, candidate_id: proposal.candidate_id, references_event_id: proposalId,
      payload: { reason: scope === 'user' ? sha256(reason) : reason } });
  } finally { closeSync(fd); rmSync(paths.lock, { force: true }); }
}

export function approveProfileProposal({ scope, workspace, profileId, proposalId, approvalReceiptPath }) {
  if (!approvalReceiptPath) fail('approval receipt file is required');
  const receiptPath = resolve(approvalReceiptPath);
  const receiptStat = lstatSync(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.nlink > 1) fail('approval receipt must be a regular unlinked file');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const { user_approval_id: userApprovalId, approved_diff: expectedApprovedDiff,
    result_sha256: expectedResultSha256, after_content: expectedAfterContent } = receipt;
  if (receipt.proposal_id !== proposalId || !userApprovalId || !expectedApprovedDiff
      || !expectedResultSha256 || expectedAfterContent === undefined) {
    fail('approval receipt must echo the exact displayed diff, result digest, and content');
  }
  const paths = scopePaths({ scope, workspace, profileId });
  const fd = acquire(paths.lock);
  try {
    recoverPrepared({ ...paths, profileId });
    const history = events(paths.ledger);
    const proposal = history.find((event) => event.event_id === proposalId
      && ['proposal-created', 'initialization-proposal'].includes(event.type)
      && event.profile_id === profileId && event.payload.scope === scope);
    if (!proposal) fail('proposal not found');
    if (history.some((event) => event.type === 'rejected' && event.references_event_id === proposalId)) {
      fail('rejected proposal cannot be approved');
    }
    if (proposal.payload.approved_diff !== expectedApprovedDiff
        || proposal.payload.result_sha256 !== expectedResultSha256
        || proposal.payload.after_content !== expectedAfterContent) fail('approval does not match the displayed proposal');
    if (history.some((event) => event.type === 'approved' && event.references_event_id === proposalId)) {
      fail('proposal is already approved');
    }
    const approvedId = eventId();
    const persistedApprovalId = scope === 'user'
      ? `hmac-sha256:${createHmac('sha256', globalSecret()).update(`approval|${userApprovalId}`).digest('hex')}`
      : userApprovalId;
    appendEvent(paths.ledger, { event_id: approvedId, type: 'approved', at: new Date().toISOString(),
      profile_id: profileId, candidate_id: proposal.candidate_id, references_event_id: proposalId,
      payload: { user_approval_id: persistedApprovalId, scope, proposal_sha256: proposal.event_sha256,
        approved_diff: proposal.payload.approved_diff } });
    return approvedId;
  } finally { closeSync(fd); rmSync(paths.lock, { force: true }); }
}

export function applyProfileTransaction({ scope, workspace, profileId, approvedEventId }) {
  const paths = scopePaths({ scope, workspace, profileId });
  const fd = acquire(paths.lock);
  try {
    recoverPrepared({ ...paths, profileId });
    const history = events(paths.ledger);
    const approval = history.find((event) => event.event_id === approvedEventId && event.type === 'approved'
      && event.profile_id === profileId && event.payload.scope === scope);
    if (!approval) fail('matching approved proposal not found');
    const proposal = history.find((event) => event.event_id === approval.references_event_id
      && ['proposal-created', 'initialization-proposal'].includes(event.type)
      && event.event_sha256 === approval.payload.proposal_sha256);
    if (!proposal || proposal.payload.approved_diff !== approval.payload.approved_diff) {
      fail('approved proposal changed');
    }
    if (history.some((event) => event.type === 'prepared' && event.references_event_id === approvedEventId)) {
      fail('approved proposal was already prepared');
    }
    const { base_sha256: baseSha256, before_content: beforeContent,
      after_content: afterContent, approved_diff: approvedDiff } = proposal.payload;
    const exists = existsSync(paths.target);
    if (baseSha256 === 'none') {
      if (exists || beforeContent !== '') fail('initialization target changed after approval');
    } else {
      if (!exists) fail('approved target no longer exists');
      const current = readFileSync(paths.target, 'utf8');
      if (sha256(current) !== baseSha256 || current !== beforeContent) fail('approved base changed');
    }
    const parsed = parseProfileContract(afterContent, profileId, scope);
    if (!parsed.valid) fail(`proposed profile is invalid: ${parsed.errors.join('; ')}`);
    if (sha256(afterContent) !== proposal.payload.result_sha256) fail('approved result changed');

    const preparedId = eventId();
    appendEvent(paths.ledger, { event_id: preparedId, type: 'prepared', at: new Date().toISOString(),
      profile_id: profileId, candidate_id: approval.candidate_id, references_event_id: approvedEventId,
      payload: { user_approval_id: approval.payload.user_approval_id, base_sha256: baseSha256,
        result_sha256: proposal.payload.result_sha256, target_path: resolve(paths.target),
        approved_diff: approvedDiff, before_content: beforeContent, after_content: afterContent } });
    mkdirSync(dirname(paths.target), { recursive: true });
    const temp = `${paths.target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    writeFileSync(temp, afterContent, { encoding: 'utf8', flush: true });
    renameSync(temp, paths.target);
    const appliedId = eventId();
    appendEvent(paths.ledger, { event_id: appliedId, type: 'applied', at: new Date().toISOString(),
      profile_id: profileId, candidate_id: approval.candidate_id, references_event_id: preparedId,
      payload: { result_sha256: proposal.payload.result_sha256, target_path: resolve(paths.target) } });
    return { appliedId, resultSha256: proposal.payload.result_sha256 };
  } finally { closeSync(fd); rmSync(paths.lock, { force: true }); }
}

export function rollbackProfileTransaction({ scope, workspace, profileId, appliedEventId }) {
  const paths = scopePaths({ scope, workspace, profileId });
  const fd = acquire(paths.lock);
  try {
    recoverPrepared({ ...paths, profileId });
    const history = events(paths.ledger);
    const applied = history.find((event) => event.event_id === appliedEventId && event.type === 'applied'
      && event.profile_id === profileId && resolve(event.payload.target_path) === resolve(paths.target));
    if (!applied) fail('applied event not found for this profile target');
    const active = [];
    for (const event of history) {
      if (event.type === 'applied') active.push(event.event_id);
      if (event.type === 'rolled-back') {
        const index = active.lastIndexOf(event.payload.applied_event_id);
        if (index !== -1) active.splice(index, 1);
      }
    }
    if (active.at(-1) !== appliedEventId) fail('only the latest effective write can be rolled back');
    const prepared = history.find((event) => event.event_id === applied.references_event_id && event.type === 'prepared');
    if (!prepared || resolve(prepared.payload.target_path) !== resolve(paths.target)) fail('prepared event target mismatch');
    const current = readFileSync(paths.target, 'utf8');
    if (sha256(current) !== prepared.payload.result_sha256) fail('profile changed after the applied event');
    const rollbackPreparedId = eventId();
    appendEvent(paths.ledger, { event_id: rollbackPreparedId, type: 'rollback-prepared',
      at: new Date().toISOString(), profile_id: profileId, candidate_id: prepared.candidate_id,
      references_event_id: appliedEventId,
      payload: { base_sha256: prepared.payload.result_sha256,
        result_sha256: prepared.payload.base_sha256, target_path: resolve(paths.target),
        restore_content: prepared.payload.before_content } });
    if (prepared.payload.base_sha256 === 'none') unlinkSync(paths.target);
    else {
      const temp = `${paths.target}.rollback-${process.pid}-${randomBytes(6).toString('hex')}`;
      const tempFd = openSync(temp, 'wx');
      writeFileSync(tempFd, prepared.payload.before_content, { encoding: 'utf8', flush: true });
      closeSync(tempFd);
      renameSync(temp, paths.target);
    }
    appendEvent(paths.ledger, { event_id: eventId(), type: 'rolled-back', at: new Date().toISOString(),
      profile_id: profileId, candidate_id: prepared.candidate_id, references_event_id: rollbackPreparedId,
      payload: { applied_event_id: appliedEventId, result_sha256: prepared.payload.base_sha256,
        target_path: resolve(paths.target) } });
  } finally { closeSync(fd); rmSync(paths.lock, { force: true }); }
}
