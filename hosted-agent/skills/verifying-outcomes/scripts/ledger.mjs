import { exactTimestamp, sha256, validSlug } from './artifact-controls.mjs';

/**
 * The task ledger: one append-only JSONL file carrying what four separate files
 * used to carry �?the journal's boundaries, recovery's incidents, the direct
 * observations, and each artifact's first-observed time.
 *
 * It is deliberately not hash-chained. An agent has to be able to append a line
 * with nothing but its file tools, on a machine where Node exists only at
 * delivery; a chain that needs a script at every step boundary would make
 * execution itself depend on a runtime this pack does not require. The
 * integrity it offers is therefore exactly the integrity the four files offered:
 * the agent asserts, and the delivery manifest freezes the assertion.
 *
 * What it does add over those files is contemporaneity. A first-observed time
 * used to be written at the end, from memory, in `artifact-times.json`; here it
 * is an event that has to be appended when the artifact appears, because a later
 * event with an earlier `at` invalidates the whole ledger.
 *
 * Every event about the work carries the plan revision it belongs to. Without it
 * a completion recorded under revision 1 silently becomes a completion of
 * whatever revision 2 renumbered into that position, which is the one thing a
 * prospective contract may never let happen.
 *
 * `task-ledger/2` adds two things the first grammar could not express. Artifact
 * observation became per revision, because one observation per file left a task
 * that already had a plan unable to leave recovery: the recovery plan has to be
 * written after the resolution, and the only recorded observation was older than
 * it. And an authorization now binds what it approved — the plan revision's
 * digest, and one contract digest per stable step id — because that is the only
 * evidence that lets a later revision keep an unchanged step's finished work
 * without inheriting by position, which would land a completion on whatever the
 * revision renumbered into that place.
 *
 * A revision is not one set of bytes. A brief is drafted and then approved; a
 * plan is drafted, approved, and then authorized, all under revision 1. So the
 * observation of a revision is not one event either: the first appearance opens
 * it and any later snapshot of the same revision records what the file became.
 * The alternative — one event per revision carrying a digest that must equal the
 * current bytes — is a rule no honest task can satisfy, because the digest would
 * have to be of bytes that did not exist yet.
 *
 * Which is why a revision keeps both of its times. The first snapshot says when
 * the revision appeared and orders nothing else; the latest says which bytes it
 * now means. Collapsing them into one field let a digest recorded before the
 * approved bytes existed stand as the attestation of the approval, so the
 * snapshot a control transition consumes has to be the one taken at that
 * instant.
 */

export const LEDGER_SCHEMA = 'task-ledger/1';
export const LEDGER_REVISION_SCHEMA = 'task-ledger/2';
export const LEDGER_SCHEMAS = [LEDGER_SCHEMA, LEDGER_REVISION_SCHEMA];
export const LEDGER_ARTIFACTS = ['profile', 'brief', 'capabilities', 'plan', 'report'];
// The artifacts that carry a `revision` control field, and so are observed once
// per revision rather than once per file. `profile` is an immutable snapshot and
// `report` has no revision of its own, so neither gains anything from it.
export const REVISED_ARTIFACTS = ['brief', 'capabilities', 'plan'];
export const OBSERVATION_KINDS = ['artifact', 'claim', 'verification', 'criterion'];
export const NOTE_TOPICS = ['progress', 'deviation', 'assumption', 'correction', 'decision'];
export const FAILURE_DIAGNOSES = ['configuration', 'input', 'external'];
export const MISSING_GATES = [
  'brief approval', 'capability resolution', 'plan approval', 'execution authorization',
];
export const RECOVERY_DECISIONS = [
  'discard and restart', 'adopt as untrusted input and revalidate', 'stop',
];

export const STEP_STATUS = {
  'step-started': 'running',
  'step-completed': 'completed',
  'step-skipped': 'skipped',
  'step-failed': 'failed',
  'step-blocked': 'blocked',
};
export const TERMINAL_KINDS = new Set(['step-completed', 'step-skipped']);
const TERMINAL_STATUSES = new Set(['completed', 'skipped']);
const STEP_KINDS = new Set(Object.keys(STEP_STATUS));
// What counts as evidence that the task itself was acted on. Appending a note is
// bookkeeping about work, not the work; treating it as work evidence would make
// writing the record look like an ordering breach. An observation is not work
// either, but it is still ordered �?see `observationsAt`.
const WORK_KINDS = new Set([...STEP_KINDS, 'work']);

const positiveInt = (value) => Number.isInteger(value) && value > 0;
const text = (value) => typeof value === 'string' && value.trim() !== '';
const notAfter = (earlier, later) => Date.parse(earlier) <= Date.parse(later);
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const digest = (value) => typeof value === 'string' && SHA256_RE.test(value);
const stepId = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
const absent = (event, ...keys) => keys.every((key) => !Object.hasOwn(event, key));

/**
 * The ten fields that decide what a step will do. A step's identity is its `id`;
 * this is its contract, and the pair is what makes carrying an earlier terminal
 * result into a later revision safe. `depends` names the id it points at rather
 * than the position, so renumbering alone does not invalidate finished work
 * while a genuinely changed dependency does.
 */
export const STEP_CONTRACT_FIELDS = ['capability', 'provider', 'fallback', 'verify', 'depends',
  'risk', 'operations', 'origin', 'revalidates', 'retry-safe'];

export function stepContractDigest(step) {
  return sha256(STEP_CONTRACT_FIELDS.map((name) => `${name}:${name === 'depends'
    ? (step.dependsContract ?? step.depends ?? 'none') : (step[name] ?? '')}`).join('\n'));
}

function validEvent(event, revisions) {
  switch (event.kind) {
    case 'task':
      return validSlug(event.task ?? '') && LEDGER_SCHEMAS.includes(event.schema);
    case 'artifact':
      if (!LEDGER_ARTIFACTS.includes(event.artifact)) return false;
      return revisions && REVISED_ARTIFACTS.includes(event.artifact)
        ? positiveInt(event.revision) && digest(event.digest)
        : absent(event, 'revision', 'digest');
    case 'plan-authorized':
      if (!positiveInt(event.planRevision)) return false;
      if (!revisions) return absent(event, 'planDigest', 'steps');
      return digest(event.planDigest) && Array.isArray(event.steps) && event.steps.length > 0
        && event.steps.every((row) => stepId(row?.id) && digest(row?.contract))
        && new Set(event.steps.map((row) => row.id)).size === event.steps.length;
    case 'step-started':
      return validStepRef(event, revisions) && text(event.provider);
    case 'step-completed':
      return validStepRef(event, revisions) && text(event.evidence);
    case 'step-skipped':
      return validStepRef(event, revisions) && text(event.decision);
    case 'step-failed':
      return validStepRef(event, revisions)
        && FAILURE_DIAGNOSES.includes(event.diagnosis) && text(event.detail);
    case 'step-blocked':
      return validStepRef(event, revisions) && text(event.detail);
    case 'observation':
      return OBSERVATION_KINDS.includes(event.observed) && text(event.ref)
        && positiveInt(event.planRevision) && Boolean(exactTimestamp(event.contentUpdatedAt))
        && notAfter(event.contentUpdatedAt, event.at) && text(event.contentDigest);
    case 'recovery-incident':
      return MISSING_GATES.includes(event.missingGate) && Array.isArray(event.outputs)
        && event.outputs.length > 0
        && event.outputs.every((row) => text(row?.output) && Boolean(exactTimestamp(row?.evidenceAt))
          && notAfter(row.evidenceAt, event.at) && text(row?.effect) && text(row?.why));
    case 'recovery-resolution':
      return RECOVERY_DECISIONS.includes(event.decision) && text(event.consequences)
        && (event.decision === 'stop' ? event.planRevision === null : positiveInt(event.planRevision));
    case 'work':
      return text(event.detail);
    case 'note':
      return NOTE_TOPICS.includes(event.topic) && text(event.detail);
    case 'repair':
      return text(event.discarded) && text(event.reason);
    default:
      return false;
  }
}

/**
 * A step is named by position on the first grammar and by stable id on the
 * second. Carrying both would be two names for one thing that can disagree.
 */
function validStepRef(event, revisions) {
  if (!positiveInt(event.planRevision)) return false;
  return revisions
    ? stepId(event.id) && absent(event, 'step')
    : positiveInt(event.step) && absent(event, 'id');
}

/**
 * Recovery keeps the shape the separate file produced, because the ordering
 * rules are the same rules: an incident opens, a resolution closes, nothing
 * follows a stop, and the latest event decides whether recovery is open.
 *
 * "Nothing follows a stop" is checked against the whole ledger, not just the
 * recovery events in it: a stop that still lets a report be written is not a
 * stop.
 */
function foldRecovery(slug, events) {
  const lastStop = events.findIndex((event) => event.kind === 'recovery-resolution'
    && event.decision === 'stop');
  const sequence = events.filter((event) => event.kind.startsWith('recovery-'));
  if (sequence.length === 0) return null;
  const mapped = sequence.map((event) => (event.kind === 'recovery-incident'
    ? {
      kind: 'incident', at: event.at, missingGate: event.missingGate,
      outputs: event.outputs.map((row) => row.output),
      workTimes: event.outputs.map((row) => row.evidenceAt), valid: true,
    }
    : {
      kind: 'resolution', at: event.at, decision: event.decision,
      prospectivePlanRevision: event.planRevision, valid: true,
    }));
  let sequenceValid = mapped[0].kind === 'incident'
    && (lastStop === -1 || events.slice(lastStop + 1)
      .every((event) => event.kind === 'note' || event.kind === 'repair'));
  for (let i = 1; i < mapped.length; i++) {
    if (mapped[i].kind === mapped[i - 1].kind) sequenceValid = false;
    if (Date.parse(mapped[i].at) <= Date.parse(mapped[i - 1].at)) sequenceValid = false;
  }
  const latest = mapped.at(-1);
  const status = latest.kind === 'resolution' ? 'resolved' : 'open';
  return {
    type: 'recovery', slug, status, events: mapped, valid: sequenceValid,
    allOutputs: [...new Set(mapped.filter((event) => event.kind === 'incident')
      .flatMap((event) => event.outputs))],
    detectedAt: mapped[0].at,
    coveredThrough: mapped.filter((event) => event.kind === 'incident')
      .map((event) => event.at).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
    resolvedAt: status === 'resolved' ? latest.at : null,
    decision: status === 'resolved' ? latest.decision : null,
    prospectivePlanRevision: status === 'resolved' ? latest.prospectivePlanRevision : null,
  };
}

/**
 * Read the lines, honouring the one repair an append-only file can express.
 *
 * A half-written final line is the ordinary way an append dies, and a file that
 * can never be repaired is a task that can never be resumed, cancelled, or even
 * recovered. Skipping the broken line silently would shorten the history the
 * file exists to preserve, so the only way past it is an explicit `repair` event
 * quoting the discarded text verbatim: the loss stays in the record.
 */
function readEvents(source) {
  const lines = typeof source === 'string'
    ? source.split('\n').filter((line) => line.trim() !== '') : [];
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    let event = null;
    try { event = JSON.parse(lines[i]); } catch { event = null; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      let repair = null;
      try { repair = JSON.parse(lines[i + 1] ?? ''); } catch { repair = null; }
      if (repair?.kind !== 'repair' || repair.discarded !== lines[i]) return null;
      continue;
    }
    events.push(event);
  }
  return events;
}

export function parseLedger(source) {
  const parsed = readEvents(source);
  const events = parsed ?? [];
  let valid = parsed !== null && events.length > 0;

  const schema = events[0]?.schema ?? null;
  const revisions = schema === LEDGER_REVISION_SCHEMA;
  const artifactCreatedAt = {};
  const artifactRevisions = Object.fromEntries(REVISED_ARTIFACTS.map((name) => [name, []]));
  const observations = [];
  const observationsAt = [];
  const workEvidenceAt = [];
  const unauthorizedWorkAt = [];
  const authorizations = new Map();
  const authorizationDetail = new Map();
  const stepEvents = [];
  const slug = valid && events[0]?.kind === 'task' && validSlug(events[0].task ?? '')
    ? events[0].task : '';
  if (!slug) valid = false;

  let previousAt = null;
  let seq = 0;
  for (const event of events) {
    if (!valid) break;
    seq += 1;
    const at = exactTimestamp(event.at);
    if (event.seq !== seq || !at || (seq > 1 && event.kind === 'task')
        || (seq === 1 && event.kind !== 'task')
        || (previousAt && Date.parse(at) < Date.parse(previousAt))
        || !validEvent(event, revisions)) { valid = false; break; }
    previousAt = at;
    if (event.kind === 'artifact') {
      const revised = revisions && REVISED_ARTIFACTS.includes(event.artifact);
      if (!revised && Object.hasOwn(artifactCreatedAt, event.artifact)) { valid = false; break; }
      if (revised) {
        // Revisions are the file's own numbering, so they start at 1 and count
        // up: a gap would mean a revision nobody observed, and going back to an
        // earlier one would mean a file with an approval history the record says
        // was superseded.
        //
        // Within a revision the bytes still change — drafted, then approved,
        // then authorized — so the same revision may be observed again, and the
        // latest snapshot is the one that describes the file now. Allowing only
        // one event per revision while requiring its digest to equal the current
        // bytes is a rule that can only be satisfied by writing the digest of
        // bytes that do not exist yet.
        const seen = artifactRevisions[event.artifact];
        const latest = seen.at(-1) ?? null;
        if (event.revision === (latest?.revision ?? 0) + 1) {
          seen.push({
            revision: event.revision, at, latestAt: at, digest: event.digest,
            snapshots: [{ at, digest: event.digest }],
          });
        } else if (latest && event.revision === latest.revision) {
          // Nothing legitimate edits an authorized plan: its step status lives
          // in these events, so a revision is the only way to change one. A
          // later snapshot of an authorized revision is an edit the
          // authorization never covered, however honestly it was appended.
          if (event.artifact === 'plan' && authorizations.has(event.revision)) { valid = false; break; }
          latest.digest = event.digest;
          latest.latestAt = at;
          latest.snapshots.push({ at, digest: event.digest });
        } else { valid = false; break; }
      }
      if (!Object.hasOwn(artifactCreatedAt, event.artifact)) artifactCreatedAt[event.artifact] = at;
    }
    if (event.kind === 'plan-authorized') {
      if (authorizations.has(event.planRevision)) { valid = false; break; }
      if (revisions) {
        // An authorization that names bytes no observation recorded is an
        // approval of a plan nobody saw. The digest it has to name is the one in
        // force where this line stands, not whatever the file became later:
        // an authorization is prospective, so it binds the bytes that exist when
        // it is appended. And the snapshot carrying that digest has to have been
        // taken at this same instant: a digest recorded earlier attests bytes
        // that did not exist when it was written.
        const observed = artifactRevisions.plan.find((row) => row.revision === event.planRevision);
        if (!observed || observed.digest !== event.planDigest
          || Date.parse(observed.latestAt) !== Date.parse(at)) { valid = false; break; }
        authorizationDetail.set(event.planRevision, {
          at, planDigest: event.planDigest,
          contracts: new Map(event.steps.map((row) => [row.id, row.contract])),
        });
      }
      authorizations.set(event.planRevision, at);
    }
    if (event.kind === 'observation') {
      observations.push({
        kind: event.observed, ref: event.ref, taskSlug: slug, planRevision: event.planRevision,
        contentUpdatedAt: event.contentUpdatedAt, observedAt: at, contentDigest: event.contentDigest,
      });
      observationsAt.push({ at, planRevision: event.planRevision });
    }
    if (WORK_KINDS.has(event.kind)) {
      workEvidenceAt.push(at);
      // Work is authorized by the authorization in force for it: a step's own
      // plan revision, and for unplanned work any authorization at all.
      const authorizedAt = STEP_KINDS.has(event.kind)
        ? authorizations.get(event.planRevision)
        : [...authorizations.values()].sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      if (!authorizedAt || Date.parse(at) < Date.parse(authorizedAt)) unauthorizedWorkAt.push(at);
    }
    if (STEP_KINDS.has(event.kind)) {
      stepEvents.push({
        seq, at, kind: event.kind, planRevision: event.planRevision, step: event.step,
        id: event.id ?? null, key: revisions ? event.id : event.step,
        provider: event.provider ?? null,
      });
    }
  }

  const recovery = valid ? foldRecovery(slug, events) : null;
  return {
    type: 'ledger', slug, schema, revisions, events,
    artifactCreatedAt, artifactRevisions, observations, observationsAt, workEvidenceAt,
    unauthorizedWorkAt, authorizations, authorizationDetail, stepEvents, recovery,
    latestWorkAt: [...workEvidenceAt].sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
    valid: valid && (!recovery || recovery.valid),
  };
}

/**
 * Fold the ledger's step events onto the plan they claim to be executing.
 *
 * The events and the plan are two halves of one contract, and a shape check on
 * each half separately proves nothing about the pair. An event naming a step the
 * plan does not have, a provider the plan did not bind, a completion with no
 * start, or a completion whose dependency has not finished, are all ways to
 * record work the approved plan never authorized.
 */
export function reconcileLedger(plan, ledger) {
  const states = new Map();
  if (!plan?.steps || !ledger?.valid) return { ok: false, states };
  // The two grammars name a step differently, so a plan that does not carry the
  // identity its ledger uses is a pair no reader can reconcile.
  if (Boolean(ledger.revisions) !== Boolean(plan.stepIdentity)) return { ok: false, states };
  const revision = plan.revision;
  const authorizedAt = ledger.authorizations.get(revision) ?? null;
  // The plan file and the ledger must agree on when this revision was
  // authorized, or the two readers of one authorization disagree.
  if (plan.execution === 'authorized' && authorizedAt !== plan.authorizedAt) return { ok: false, states };
  if (plan.execution !== 'authorized' && authorizedAt) return { ok: false, states };

  // An authorization for a revision the plan never reached is not merely unused:
  // unplanned work is judged against the earliest authorization of any revision,
  // so a backdated ghost would make work that predates the plan file look
  // approved.
  if ([...ledger.authorizations.keys()].some((claimed) => claimed > revision)) {
    return { ok: false, states };
  }
  const contractNow = ledger.revisions
    ? new Map(plan.steps.map((step) => [step.id, stepContractDigest(step)])) : new Map();
  // The authorization is the record of what was approved. If it does not name
  // exactly this plan's steps with the contracts the file now computes to, the
  // ledger and the plan disagree about the contract, and preferring either one
  // silently is how work gets done under an approval nobody gave.
  if (ledger.revisions && plan.execution === 'authorized') {
    const authorized = ledger.authorizationDetail.get(revision)?.contracts;
    if (!authorized || authorized.size !== contractNow.size
      || [...contractNow].some(([id, contract]) => authorized.get(id) !== contract)) {
      return { ok: false, states };
    }
  }
  const { ok, byRevision } = foldSteps(plan, ledger, contractNow);
  if (!ok) return { ok: false, states };
  for (const [key, state] of carryForward(ledger, byRevision, revision, contractNow)) states.set(key, state);
  for (const [key, state] of byRevision.get(revision) ?? []) states.set(key, state);
  // An observation cannot predate the authorization that permitted the work it
  // observes, and it is judged against the authorization of the revision it
  // names — a carried step is verified under whichever revision the verifier was
  // standing in, and both of those revisions were authorized before it. A
  // revision the plan never reached authorized nothing at all.
  for (const item of ledger.observationsAt) {
    if (item.planRevision > revision) return { ok: false, states: new Map() };
    const gate = ledger.authorizations.get(item.planRevision) ?? null;
    if (gate && Date.parse(item.at) < Date.parse(gate)) return { ok: false, states: new Map() };
  }
  return { ok: true, states };
}

/**
 * Fold the revisions in order, each one standing on what the ones before it
 * finished. The current revision is checked against the plan file; an earlier
 * one can only be checked against the contract list its own authorization
 * recorded, because the plan it executed is gone — which is exactly why that
 * list exists.
 *
 * Folding them sequentially is what makes a dependency chain survive a
 * revision. Revision 1 finishes A, revision 2 carries A and finishes B on top
 * of it, revision 3 changes neither: seeding only the current revision with
 * carried results left revision 2's fold judging B against an empty history, so
 * a chain that every revision authorized honestly could never reconcile.
 */
function foldSteps(plan, ledger, contractNow) {
  const revision = plan.revision;
  const byKey = new Map(plan.steps.map((step) => [ledger.revisions ? step.id : step.n, step]));
  const byRevision = new Map();
  const grouped = new Map();
  // What a revision may inherit is judged against the contracts that revision
  // was authorized under, not against the current plan's: an earlier fold has
  // to be reconstructed as it stood, or a contract the current revision changed
  // would be enforced backwards against history that predates it.
  const contractsFor = (rev) => (rev === revision ? contractNow
    : (ledger.authorizationDetail.get(rev)?.contracts ?? new Map()));
  for (const event of ledger.stepEvents) {
    // A revision above the plan file's cannot exist honestly - the plan is
    // incremented before its authorization is appended - so it is work claiming
    // an approval that was never given.
    if (event.planRevision > revision) return { ok: false, byRevision };
    // The first grammar cannot tell an earlier revision's step from this one's,
    // so it keeps the behaviour it always had: only this revision is folded.
    if (!ledger.revisions && event.planRevision !== revision) continue;
    if (!grouped.has(event.planRevision)) grouped.set(event.planRevision, []);
    grouped.get(event.planRevision).push(event);
  }
  for (const rev of [...grouped.keys()].sort((a, b) => a - b)) {
    const states = new Map();
    const terminalAt = new Map();
    // Carried results are already terminal when this revision opens, so a step
    // that depends on one has its dependency met.
    for (const [key, state] of carryForward(ledger, byRevision, rev, contractsFor(rev))) {
      terminalAt.set(key, state.verifiedAt ?? state.skipApprovedAt);
    }
    for (const event of grouped.get(rev)) {
      const authorized = ledger.authorizationDetail.get(rev)?.contracts;
      if (rev === revision ? !byKey.get(event.key) : !authorized?.has(event.key)) return { ok: false, byRevision };
      // An earlier revision's event whose authorized contract still matches the
      // current plan's is exactly the one this revision may carry forward, so it
      // is judged against the same step the carry will land on: the provider it
      // bound and the dependency order it kept have to hold now, not only for
      // the revision that is executing, or a changed dependency could smuggle a
      // stale completion through as if it still met the plan it is joining.
      // A changed contract is never eligible, and stays unresolved here so it is
      // not misapplied to a step it no longer describes.
      const carryEligible = rev !== revision
        && authorized?.get(event.key) && authorized.get(event.key) === contractNow.get(event.key);
      const step = rev === revision || carryEligible ? byKey.get(event.key) : null;
      const current = states.get(event.key);
      if (event.kind === 'step-started') {
        // Only the current revision's plan can say which provider it bound.
        if (step && event.provider !== step.provider && event.provider !== step.fallback) {
          return { ok: false, byRevision };
        }
      } else {
        // Nothing may finish, fail, or block before it has started; a terminal
        // event after an earlier terminal one needs its own fresh start, which
        // is what makes a mistaken record correctable without editing a line.
        if (!current || current.status !== 'running') return { ok: false, byRevision };
        if (TERMINAL_KINDS.has(event.kind) && step) {
          const dependencyKey = ledger.revisions ? step.dependsOnId : step.dependsOn;
          const dependency = dependencyKey === null || dependencyKey === undefined
            ? null : terminalAt.get(dependencyKey);
          if (step.dependsOn !== null && (!dependency || Date.parse(dependency) > Date.parse(event.at))) {
            return { ok: false, byRevision };
          }
        }
        if (TERMINAL_KINDS.has(event.kind)) terminalAt.set(event.key, event.at);
      }
      states.set(event.key, {
        status: STEP_STATUS[event.kind],
        verifiedAt: event.kind === 'step-completed' ? event.at : null,
        skipApprovedAt: event.kind === 'step-skipped' ? event.at : null,
      });
    }
    byRevision.set(rev, states);
  }
  return { ok: true, byRevision };
}

/**
 * What the revisions before `target` finished that `target` may keep.
 *
 * Only a terminal result crosses, and only when the stable id is present in both
 * revisions with the same contract digest. `running`, `failed` and `blocked`
 * describe an attempt rather than a result, and a revision that started an id
 * again supersedes whatever an earlier one recorded for it. Nothing crosses a
 * recovery resolution at all: the incident found that the work was never
 * authorized, so inheriting it would launder what recovery exists to refuse.
 *
 * `target` is any revision, not only the plan file's, because an intermediate
 * revision inherits on exactly these terms too — and `targetContracts` is what
 * that revision was authorized under, so the comparison is between two
 * contracts that were both in force rather than between history and the present.
 */
function carryForward(ledger, byRevision, target, targetContracts) {
  const carried = new Map();
  if (!ledger.revisions) return carried;
  const resolutions = (ledger.recovery?.events ?? [])
    .filter((event) => event.kind === 'resolution').map((event) => event.at);
  for (const rev of [...byRevision.keys()].sort((a, b) => a - b)) {
    if (rev >= target) continue;
    const authorizedAt = ledger.authorizations.get(rev);
    const crossesRecovery = resolutions.some((at) => !authorizedAt
      || Date.parse(at) >= Date.parse(authorizedAt));
    const contracts = ledger.authorizationDetail.get(rev)?.contracts;
    for (const [key, state] of byRevision.get(rev)) {
      if (!crossesRecovery && TERMINAL_STATUSES.has(state.status)
        && contracts?.get(key) && contracts.get(key) === targetContracts.get(key)) {
        carried.set(key, { ...state, carriedFromRevision: rev });
      } else carried.delete(key);
    }
  }
  return carried;
}
