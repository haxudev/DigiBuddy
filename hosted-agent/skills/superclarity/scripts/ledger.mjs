// Ledger parsing: physical batch envelopes, corruption classification, and
// closed per-event field validation. See docs/vnext-spec.md §5.
//
// Business-level derivation (contract-recorded history, approvals, step
// attempts, recovery, carry) is built on top of this module's flat validated
// event list by state.mjs. This module only proves the file is syntactically
// and structurally sound.

import { isPositiveInt, parseStrictJson } from './markdown.mjs';

export const LEDGER_EVENT_SCHEMA = 'superclarity-ledger/1';
export const BATCH_SCHEMA = 'superclarity-ledger-batch/1';

export const GATE_VALUES = ['compact', 'terms', 'execution', 'action'];
export const BINDING_VALUES = ['primary', 'fallback'];
export const OUTCOME_VALUES = ['completed', 'failed', 'blocked'];
export const ACCEPTANCE_VERDICT_VALUES = ['complete', 'partial'];
export const RECOVERY_CODE_VALUES = ['unauthorized-work', 'uncertain-effect'];
export const RECOVERY_DECISION_VALUES = ['discard', 'revalidate', 'stop'];
export const RECONCILIATION_VALUES = ['occurred', 'confirmed-not-occurred', 'still-uncertain'];
export const REVALIDATE_BASIS_VALUES = ['stale-evidence', 'recovery-occurred'];

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const isDigest = (v) => typeof v === 'string' && DIGEST_RE.test(v);
const isDigestOrNone = (v) => v === 'none' || isDigest(v);

function stepRef(o) { return `${o.stepId}#${o.attempt}`; }

/** Closed field/shape validators, keyed by event `type`. Each returns true/false. */
const EVENT_VALIDATORS = {
  'task-created': (e, fields) => sameKeys(fields, ['schema', 'task']) && e.schema === LEDGER_EVENT_SCHEMA && isTaskSlug(e.task),
  'contract-recorded': (e, fields) => sameKeys(fields, ['revision', 'mode', 'termsDigest', 'termsContentDigest', 'planDigest', 'contractDigest', 'capabilities', 'steps'])
    && positiveIntValue(e.revision) && (e.mode === 'compact' || e.mode === 'full')
    && isDigest(e.termsDigest) && isDigest(e.termsContentDigest) && isDigestOrNone(e.planDigest) && isDigest(e.contractDigest)
    && Array.isArray(e.capabilities) && e.capabilities.every((c) => isLegacyCapabilityRecord(c) || (sameKeys(Object.keys(c), ['id', 'needDigest', 'binding']) && isNonEmptyString(c.id) && isDigest(c.needDigest) && isCanonicalCapability(c.binding, c.id)))
    && Array.isArray(e.steps) && e.steps.every((s) => isLegacyStepRecord(s) || (sameKeys(Object.keys(s), ['id', 'digest', 'step']) && isNonEmptyString(s.id) && isDigest(s.digest) && isCanonicalStep(s.step, s.id)))
    && uniqueBy(e.capabilities, 'id') && uniqueBy(e.steps, 'id'),
  'gate-prepared': (e, fields) => {
    const base = ['gate', 'recordSeq', 'tokenDigest'];
    if (!GATE_VALUES.includes(e.gate)) return false;
    if (!positiveIntValue(e.recordSeq) || !isDigest(e.tokenDigest)) return false;
    if (e.gate === 'action') {
      return sameKeys(fields, [...base, 'stepId', 'attempt', 'effect', 'binding', 'reason', 'actionDigest', 'actionSource', 'actionPayload', 'readinessConfirmed'])
        && isNonEmptyString(e.stepId) && positiveIntValue(e.attempt) && isNonEmptyString(e.effect)
        && BINDING_VALUES.includes(e.binding) && typeof e.reason === 'string' && isDigest(e.actionDigest)
        && isNonEmptyString(e.actionSource) && typeof e.actionPayload === 'object' && e.actionPayload !== null
        && isStringArray(e.readinessConfirmed);
    }
    if (e.gate === 'compact') {
      return sameKeys(fields, [...base, 'eligibility', 'readinessConfirmed']) && isStringArray(e.eligibility) && isStringArray(e.readinessConfirmed);
    }
    if (e.gate === 'execution') {
      return sameKeys(fields, [...base, 'readinessConfirmed']) && isStringArray(e.readinessConfirmed);
    }
    return sameKeys(fields, base);
  },
  'terms-approved': (e, fields) => sameKeys(fields, ['preparedSeq', 'revision', 'termsDigest']) && positiveIntValue(e.preparedSeq) && positiveIntValue(e.revision) && isDigest(e.termsDigest),
  'plan-approved': (e, fields) => sameKeys(fields, ['preparedSeq', 'revision', 'termsDigest', 'planDigest']) && positiveIntValue(e.preparedSeq) && positiveIntValue(e.revision) && isDigest(e.termsDigest) && isDigestOrNone(e.planDigest),
  'execution-authorized': (e, fields) => sameKeys(fields, ['preparedSeq', 'revision', 'termsDigest', 'planDigest']) && positiveIntValue(e.preparedSeq) && positiveIntValue(e.revision) && isDigest(e.termsDigest) && isDigestOrNone(e.planDigest),
  'action-approved': (e, fields) => sameKeys(fields, ['preparedSeq', 'revision', 'stepId', 'attempt', 'effect', 'binding', 'actionDigest']) && positiveIntValue(e.preparedSeq) && positiveIntValue(e.revision) && isNonEmptyString(e.stepId) && positiveIntValue(e.attempt) && isNonEmptyString(e.effect) && BINDING_VALUES.includes(e.binding) && isDigest(e.actionDigest),
  'fallback-invoked': (e, fields) => sameKeys(fields, ['revision', 'stepId', 'attempt', 'capabilityId', 'reason']) && positiveIntValue(e.revision) && isNonEmptyString(e.stepId) && positiveIntValue(e.attempt) && isNonEmptyString(e.capabilityId) && isNonEmptyString(e.reason),
  'step-started': (e, fields) => sameKeys(fields, ['revision', 'stepId', 'attempt', 'binding', 'readinessConfirmed']) && positiveIntValue(e.revision) && isNonEmptyString(e.stepId) && positiveIntValue(e.attempt) && BINDING_VALUES.includes(e.binding) && isStringArray(e.readinessConfirmed),
  'step-finished': (e, fields) => sameKeys(fields, ['revision', 'stepId', 'attempt', 'outcome', 'detail', 'evidence']) && positiveIntValue(e.revision) && isNonEmptyString(e.stepId) && positiveIntValue(e.attempt) && OUTCOME_VALUES.includes(e.outcome) && isNonEmptyString(e.detail) && Array.isArray(e.evidence) && e.evidence.every(isValidEvidence) && (e.outcome !== 'completed' || e.evidence.length > 0),
  'step-skipped': (e, fields) => sameKeys(fields, ['revision', 'stepId', 'decision', 'impact']) && positiveIntValue(e.revision) && isNonEmptyString(e.stepId) && isNonEmptyString(e.decision) && isNonEmptyString(e.impact),
  'step-revalidated': (e, fields) => sameKeys(fields, ['revision', 'stepId', 'stepDigest', 'basis', 'evidence']) && positiveIntValue(e.revision) && isNonEmptyString(e.stepId) && isDigest(e.stepDigest) && REVALIDATE_BASIS_VALUES.includes(e.basis) && Array.isArray(e.evidence) && e.evidence.length > 0 && e.evidence.every(isValidEvidence),
  'recovery-opened': (e, fields) => {
    if (!RECOVERY_CODE_VALUES.includes(e.code) || !isNonEmptyString(e.summary) || !Array.isArray(e.outputs)) return false;
    if (!positiveIntValue(e.revision)) return false;
    const outputsOk = e.outputs.every((o) => sameKeys(Object.keys(o), ['ref', 'effect']) && isNonEmptyString(o.ref) && isNonEmptyString(o.effect));
    if (!outputsOk) return false;
    if ('stepId' in e || 'attempt' in e) {
      return sameKeys(fields, ['revision', 'code', 'summary', 'outputs', 'stepId', 'attempt']) && isNonEmptyString(e.stepId) && positiveIntValue(e.attempt);
    }
    return sameKeys(fields, ['revision', 'code', 'summary', 'outputs']);
  },
  'recovery-resolved': (e, fields) => sameKeys(fields, ['openedSeq', 'decision', 'reconciliation', 'consequences']) && positiveIntValue(e.openedSeq) && RECOVERY_DECISION_VALUES.includes(e.decision) && RECONCILIATION_VALUES.includes(e.reconciliation) && isNonEmptyString(e.consequences),
  'task-cancelled': (e, fields) => sameKeys(fields, ['reason']) && isNonEmptyString(e.reason),
  repair: (e, fields) => sameKeys(fields, ['discardedBase64', 'discardedDigest', 'reason']) && isNonEmptyString(e.discardedBase64) && isDigest(e.discardedDigest) && isNonEmptyString(e.reason),
  'acceptance-recorded': (e, fields) => sameKeys(fields, ['revision', 'verdict', 'acceptanceDigest']) && positiveIntValue(e.revision) && ACCEPTANCE_VERDICT_VALUES.includes(e.verdict) && isDigest(e.acceptanceDigest),
};

function isValidEvidence(ev) {
  if (!ev || typeof ev !== 'object') return false;
  const keys = Object.keys(ev);
  if (ev.kind === 'file') return sameKeys(keys, ['kind', 'ref', 'digest']) && isNonEmptyString(ev.ref) && isDigest(ev.digest);
  if (ev.kind === 'external') return sameKeys(keys, ['kind', 'ref', 'digest']) && isNonEmptyString(ev.ref) && ev.digest === 'n/a';
  return false;
}

function isCanonicalCapability(value, id) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.id === id
    && sameKeys(Object.keys(value), ['id', 'need', 'primary', 'readiness', 'evidence', 'fallback', 'fallbackWhen', 'consequence']);
}

function isLegacyCapabilityRecord(value) {
  return sameKeys(Object.keys(value), ['id', 'needDigest']) && isNonEmptyString(value.id) && isDigest(value.needDigest);
}

function isLegacyStepRecord(value) {
  return sameKeys(Object.keys(value), ['id', 'digest']) && isNonEmptyString(value.id) && isDigest(value.digest);
}

function isCanonicalStep(value, id) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.id === id
    && sameKeys(Object.keys(value), ['id', 'title', 'capability', 'action', 'verify', 'effect', 'dependsOn', 'output', 'reversible', 'retrySafe', 'gate']);
}

function sameKeys(actualKeys, expectedKeys) {
  const a = [...actualKeys].sort();
  const b = [...expectedKeys].sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

function positiveIntValue(v) {
  return Number.isInteger(v) && v > 0 && Number.isSafeInteger(v);
}

function isTaskSlug(v) {
  return typeof v === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);
}

function uniqueBy(arr, key) {
  const seen = new Set();
  for (const x of arr) { if (seen.has(x[key])) return false; seen.add(x[key]); }
  return true;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function isIso(v) { return typeof v === 'string' && ISO_RE.test(v) && new Date(v).toISOString() === v; }

/**
 * Parse the physical ledger file. Returns a view describing corruption (if
 * any) and, when the ledger is otherwise sound, the flat logical event list
 * plus physical/logical/business head indices.
 */
export function parseLedgerFile(text) {
  let lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  if (lines.length === 0) {
    return ledgerResult(false, { kind: 'middle' }, [], [], [{ code: 'SC301', severity: 'error', location: null, detail: 'ledger is empty' }]);
  }

  const batches = [];
  const events = [];
  let previousAt = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let envelope;
    try {
      envelope = parseStrictJson(line);
    } catch (e) {
      const kind = li === lines.length - 1 ? 'tail' : 'middle';
      return ledgerResult(false, { kind, raw: line }, batches, events, [{ code: kind === 'tail' ? 'SC306' : 'SC104', severity: 'error', location: null, detail: `line ${li + 1}: ${e.message}` }]);
    }
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)
      || !sameKeys(Object.keys(envelope), ['schema', 'events'])
      || envelope.schema !== BATCH_SCHEMA || !Array.isArray(envelope.events) || envelope.events.length === 0) {
      return invalidResult(batches, events, `line ${li + 1}: invalid batch envelope`);
    }

    // Stage a whole physical batch. Nothing from it is exposed unless every
    // event and transition validates, preserving atomic append semantics.
    const batch = { index: li, events: envelope.events };
    const staged = [];
    let batchAt = null;
    for (const e of batch.events) {
      const seq = events.length + staged.length + 1;
      if (typeof e !== 'object' || e === null || Array.isArray(e)) {
        return invalidResult(batches, events, `logical event ${seq} is not an object`);
      }
      const { seq: eSeq, at, type, ...rest } = e;
      if (eSeq !== seq) return invalidResult(batches, events, `logical event ${seq}: seq mismatch (${eSeq})`);
      if (!isIso(at)) return invalidResult(batches, events, `logical event ${seq}: invalid at`);
      if (seq === 1) {
        if (type !== 'task-created') return invalidResult(batches, events, 'first logical event must be task-created');
      } else if (type === 'task-created') {
        return invalidResult(batches, events, `logical event ${seq}: task-created may only be first`);
      }
      if (batchAt === null) batchAt = at; else if (at !== batchAt) return invalidResult(batches, events, `logical event ${seq}: batch events must share one at`);
      if (previousAt !== null && Date.parse(at) < Date.parse(previousAt)) return invalidResult(batches, events, `logical event ${seq}: at goes backwards`);
      const validator = EVENT_VALIDATORS[type];
      if (!validator) return invalidResult(batches, events, `logical event ${seq}: unknown type ${type}`);
      const fields = Object.keys(rest);
      if (!validator(rest, fields)) return invalidResult(batches, events, `logical event ${seq}: invalid ${type} shape`);
      staged.push({ seq, at, type, batchIndex: batch.index, ...rest });
    }

    const transitionError = validateBatchTransitions(events, staged);
    if (transitionError) return invalidResult(batches, events, transitionError);

    batches.push(batch);
    events.push(...staged);
    previousAt = batchAt;
  }

  return ledgerResult(true, null, batches, events, []);
}

const APPROVAL_TYPES = new Set(['terms-approved', 'plan-approved', 'execution-authorized', 'action-approved']);

function validateBatchTransitions(prefix, batch) {
  let cancelled = prefix.some((e) => e.type === 'task-cancelled' || (e.type === 'recovery-resolved' && e.decision === 'stop'));
  for (const e of batch) {
    if (cancelled && e.type !== 'repair') return `logical event ${e.seq}: no business event is allowed after cancellation`;
    if (e.type === 'task-cancelled' || (e.type === 'recovery-resolved' && e.decision === 'stop')) cancelled = true;
  }

  for (let i = 0; i < batch.length; i++) {
    const e = batch[i];
    if (e.type !== 'gate-prepared') continue;
    const record = batch[i - 1];
    if (!record || record.type !== 'contract-recorded' || record.seq !== e.recordSeq) {
      return `logical event ${e.seq}: recordSeq must reference the immediately preceding contract-recorded in the same batch`;
    }
  }

  const approvals = batch.filter((e) => APPROVAL_TYPES.has(e.type));
  if (approvals.length === 0) return validateFallbackStart(batch);

  const prepared = prefix[prefix.length - 1];
  if (!prepared || prepared.type !== 'gate-prepared') {
    return `logical event ${approvals[0].seq}: approval requires the current unconsumed gate-prepared`;
  }
  const record = prefix.find((e) => e.seq === prepared.recordSeq);
  if (!record || record.type !== 'contract-recorded') {
    return `logical event ${approvals[0].seq}: prepared gate has no matching contract-recorded`;
  }
  for (const approval of approvals) {
    const mismatch = validateApprovalReference(approval, prepared, record);
    if (mismatch) return `logical event ${approval.seq}: ${mismatch}`;
  }

  const types = batch.map((e) => e.type);
  if (prepared.gate === 'compact') {
    const planOnly = sameValues(types, ['terms-approved', 'plan-approved']);
    const execute = sameValues(types, ['terms-approved', 'plan-approved', 'execution-authorized']);
    if (!planOnly && !execute) return `logical event ${batch[0].seq}: invalid compact approval batch`;
  } else if (prepared.gate === 'terms') {
    if (!sameValues(types, ['terms-approved'])) return `logical event ${batch[0].seq}: invalid terms approval batch`;
  } else if (prepared.gate === 'execution') {
    const planOnly = sameValues(types, ['plan-approved']);
    const planAndExecute = sameValues(types, ['plan-approved', 'execution-authorized']);
    const executeOnly = sameValues(types, ['execution-authorized']);
    if (!planOnly && !planAndExecute && !executeOnly) return `logical event ${batch[0].seq}: invalid execution approval batch`;
  } else {
    return validateActionApprovalBatch(batch, prepared);
  }
  return null;
}

function validateApprovalReference(approval, prepared, record) {
  if (approval.preparedSeq !== prepared.seq) return `preparedSeq ${approval.preparedSeq} does not reference the current gate-prepared`;
  if (approval.revision !== record.revision) return 'revision does not match the prepared contract record';
  if (approval.type === 'terms-approved') {
    if (prepared.gate !== 'terms' && prepared.gate !== 'compact') return `terms-approved does not match ${prepared.gate} gate`;
    if (approval.termsDigest !== record.termsDigest) return 'termsDigest does not match the prepared contract record';
  } else if (approval.type === 'plan-approved' || approval.type === 'execution-authorized') {
    if (prepared.gate !== 'execution' && prepared.gate !== 'compact') return `${approval.type} does not match ${prepared.gate} gate`;
    if (approval.termsDigest !== record.termsDigest || approval.planDigest !== record.planDigest) return 'approval digests do not match the prepared contract record';
  } else {
    if (prepared.gate !== 'action') return `action-approved does not match ${prepared.gate} gate`;
    for (const field of ['stepId', 'attempt', 'effect', 'binding', 'actionDigest']) {
      if (approval[field] !== prepared[field]) return `${field} does not match the prepared action gate`;
    }
    if (!record.steps.some((s) => s.id === approval.stepId)) return 'stepId does not exist in the prepared contract record';
  }
  return null;
}

function validateActionApprovalBatch(batch, prepared) {
  const approval = batch[0];
  const fallback = prepared.binding === 'fallback';
  const expectedTypes = fallback
    ? ['action-approved', 'fallback-invoked', 'step-started']
    : ['action-approved', 'step-started'];
  if (!sameValues(batch.map((e) => e.type), expectedTypes)) {
    return `logical event ${batch[0].seq}: action-approved and step-started must be one atomic adjacent batch`;
  }
  const started = batch[batch.length - 1];
  for (const field of ['revision', 'stepId', 'attempt', 'binding']) {
    if (started[field] !== approval[field]) return `logical event ${started.seq}: ${field} does not match action-approved`;
  }
  if (!sameValues(started.readinessConfirmed, prepared.readinessConfirmed)) {
    return `logical event ${started.seq}: readinessConfirmed does not match the prepared action gate`;
  }
  if (fallback) {
    const invoked = batch[1];
    for (const field of ['revision', 'stepId', 'attempt']) {
      if (invoked[field] !== approval[field]) return `logical event ${invoked.seq}: ${field} does not match action-approved`;
    }
    if (invoked.reason !== prepared.reason) return `logical event ${invoked.seq}: reason does not match the prepared action gate`;
  }
  return null;
}

function validateFallbackStart(batch) {
  for (let i = 0; i < batch.length; i++) {
    const invoked = batch[i];
    if (invoked.type !== 'fallback-invoked') continue;
    const started = batch[i + 1];
    if (!started || started.type !== 'step-started' || started.binding !== 'fallback') {
      return `logical event ${invoked.seq}: fallback-invoked must be immediately followed by a fallback step-started in the same batch`;
    }
    for (const field of ['revision', 'stepId', 'attempt']) {
      if (started[field] !== invoked[field]) return `logical event ${started.seq}: ${field} does not match fallback-invoked`;
    }
  }
  return null;
}

function sameValues(actual, expected) {
  return actual.length === expected.length && actual.every((v, i) => v === expected[i]);
}

function ledgerResult(valid, corruption, batches, events, errors) {
  const businessEvents = events.filter((e) => e.type !== 'repair');
  return {
    valid,
    corruption,
    batches,
    events,
    errors,
    physicalHeadIndex: batches.length - 1,
    logicalHead: events[events.length - 1] ?? null,
    businessHead: businessEvents[businessEvents.length - 1] ?? null,
    task: events[0]?.task ?? null,
  };
}

function invalidResult(batches, events, detail) {
  return ledgerResult(false, { kind: 'invalid' }, batches, events, [{ code: 'SC303', severity: 'error', location: null, detail }]);
}

/** Serialize one batch of logical events (without seq/at, which the caller fills in) into the on-disk envelope line. */
export function serializeBatch(events) {
  return `${JSON.stringify({ schema: BATCH_SCHEMA, events })}\n`;
}

export { isPositiveInt };
