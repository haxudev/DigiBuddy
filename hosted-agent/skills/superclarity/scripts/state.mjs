// State derivation: composes a parsed contract, parsed acceptance record, and
// ledger view into the single derived `state` + `next` the CLI reports. See
// docs/vnext-spec.md §7-8.
//
// This module is pure (no filesystem access): callers that need to check
// file evidence freshness do so separately and pass the result in.

import { GATED_EFFECTS } from './model.mjs';

const STEP_EVENT_TYPES = new Set(['step-started', 'step-finished', 'step-skipped', 'step-revalidated']);

function latestRecordForRevision(ledger, revision) {
  const records = ledger.events.filter((e) => e.type === 'contract-recorded' && e.revision === revision);
  return records.length ? records[records.length - 1] : null;
}

function maxRecordedRevision(ledger) {
  const revisions = ledger.events.filter((e) => e.type === 'contract-recorded').map((e) => e.revision);
  return revisions.length ? Math.max(...revisions) : 0;
}

/** The latest gate-prepared event that is still the ledger's logical head (i.e. unconsumed and not superseded). */
function activeGatePrepared(ledger) {
  const head = ledger.logicalHead;
  if (!head || head.type !== 'gate-prepared') return null;
  return head;
}

function findEvent(ledger, seq) {
  return ledger.events.find((e) => e.seq === seq) ?? null;
}

function authorizedRecordForRevision(ledger, revision) {
  const authorizations = ledger.events.filter((e) => e.type === 'execution-authorized' && e.revision === revision);
  const authorization = authorizations[authorizations.length - 1];
  if (!authorization) return null;
  const prepared = findEvent(ledger, authorization.preparedSeq);
  return prepared?.type === 'gate-prepared' ? findEvent(ledger, prepared.recordSeq) : null;
}

/** Does an execution-authorized/plan-approved/terms-approved event exist matching the current digests? Approvals from before the most recent recovery episode never count: recovery-opened invalidates everything before it. */
function computeApprovals(ledger, contract) {
  const revision = contract.header.revision;
  const openedEvents = ledger.events.filter((e) => e.type === 'recovery-opened');
  const cutoffSeq = openedEvents.length ? openedEvents[openedEvents.length - 1].seq : 0;
  const since = (list) => list.filter((e) => e.seq > cutoffSeq);
  const termsApprovedEvents = since(ledger.events.filter((e) => e.type === 'terms-approved' && e.revision === revision && e.termsDigest === contract.termsDigest));
  const termsApproved = termsApprovedEvents.length > 0;
  const planApprovedEvents = since(ledger.events.filter((e) => e.type === 'plan-approved' && e.revision === revision
    && e.termsDigest === contract.termsDigest && e.planDigest === contract.planDigest));
  const planApproved = termsApproved && planApprovedEvents.length > 0;
  const executionEvents = since(ledger.events.filter((e) => e.type === 'execution-authorized' && e.revision === revision
    && e.termsDigest === contract.termsDigest && e.planDigest === contract.planDigest));
  const executionAuthorized = planApproved && executionEvents.length > 0;
  return { termsApproved, planApproved, executionAuthorized };
}

/** Recovery stack: pairs recovery-opened with a later recovery-resolved by openedSeq. */
function recoveryView(ledger) {
  const opened = ledger.events.filter((e) => e.type === 'recovery-opened');
  const resolved = ledger.events.filter((e) => e.type === 'recovery-resolved');
  const resolvedByOpenedSeq = new Map(resolved.map((r) => [r.openedSeq, r]));
  const pairs = opened.map((o) => ({ opened: o, resolved: resolvedByOpenedSeq.get(o.seq) ?? null }));
  const open = pairs.find((p) => !p.resolved) ?? null;
  const latestResolved = resolved.length ? resolved[resolved.length - 1] : null;
  return { pairs, open, latestResolved };
}

function isCancelled(ledger) {
  const head = ledger.businessHead;
  if (!head) return false;
  if (head.type === 'task-cancelled') return true;
  if (head.type === 'recovery-resolved' && head.decision === 'stop') return true;
  return false;
}

/** Fold step events + carry-forward into a Map<stepId, {status, attempt, binding, carriedFromRevision}> for one revision. */
function foldRevision(revision, ledger, memo) {
  if (memo.has(revision)) return memo.get(revision);
  const states = new Map();
  const record = authorizedRecordForRevision(ledger, revision) ?? latestRecordForRevision(ledger, revision);
  if (revision > 1 && record) {
    const prevRecord = authorizedRecordForRevision(ledger, revision - 1);
    const prevStates = foldRevision(revision - 1, ledger, memo);
    const latestResolvedSeq = (() => {
      const resolved = ledger.events.filter((e) => e.type === 'recovery-resolved');
      return resolved.length ? resolved[resolved.length - 1].seq : 0;
    })();
    if (prevRecord) {
      for (const step of record.steps) {
        const prevStep = prevRecord.steps.find((s) => s.id === step.id);
        if (!prevStep || prevStep.digest !== step.digest) continue;
        const prevState = prevStates.get(step.id);
        if (!prevState || !['completed', 'skipped'].includes(prevState.status)) continue;
        if (prevState.seq <= latestResolvedSeq) continue;
        states.set(step.id, { ...prevState, carriedFromRevision: prevState.carriedFromRevision ?? revision - 1 });
      }
    }
  }
  const latestResolvedSeq = ledger.events.filter((e) => e.type === 'recovery-resolved').at(-1)?.seq ?? 0;
  const openRecovery = recoveryView(ledger).open?.opened ?? null;
  const events = ledger.events.filter((e) => STEP_EVENT_TYPES.has(e.type) && e.revision === revision && e.seq > latestResolvedSeq).sort((a, b) => a.seq - b.seq);
  for (const e of events) {
    if (e.type === 'step-started') {
      states.set(e.stepId, { status: openRecovery && e.seq < openRecovery.seq ? 'quarantined' : 'running', attempt: e.attempt, binding: e.binding, carriedFromRevision: null, at: e.at, seq: e.seq });
    } else if (e.type === 'step-finished') {
      const outcome = e.outcome === 'completed' ? 'completed' : e.outcome;
      states.set(e.stepId, { status: outcome, attempt: e.attempt, binding: states.get(e.stepId)?.binding ?? 'primary', carriedFromRevision: null, at: e.at, seq: e.seq });
    } else if (e.type === 'step-skipped') {
      states.set(e.stepId, { status: 'skipped', attempt: 0, binding: null, carriedFromRevision: null, at: e.at, seq: e.seq });
    } else if (e.type === 'step-revalidated') {
      const prev = states.get(e.stepId) ?? { attempt: 0, binding: 'primary' };
      states.set(e.stepId, { ...prev, status: 'completed', at: e.at, seq: e.seq });
    }
  }
  memo.set(revision, states);
  return states;
}

function attemptsFor(ledger, revision, stepId, binding) {
  return ledger.events.filter((e) => e.type === 'step-started' && e.revision === revision && e.stepId === stepId && e.binding === binding).length;
}

function fallbackUsed(ledger, revision, stepId) {
  return ledger.events.some((e) => e.type === 'fallback-invoked' && e.revision === revision && e.stepId === stepId);
}

/** Occurred-recovery revalidation obligations: one per recovery-resolved(occurred, revalidate), each naming the output ref(s) that must be closed by a `recovery-occurred` step-revalidated before ordinary execution may use that step. */
function occurredRecoveryObligations(ledger) {
  const obligations = [];
  for (const ev of ledger.events) {
    if (ev.type !== 'recovery-resolved' || ev.decision !== 'revalidate' || ev.reconciliation !== 'occurred') continue;
    const opened = findEvent(ledger, ev.openedSeq);
    if (!opened) continue;
    for (const output of opened.outputs) obligations.push({ ref: output.ref, resolvedAt: ev.at, resolvedSeq: ev.seq });
  }
  return obligations;
}

/** Whether the obligation for `ref` has been closed by a matching recovery-occurred step-revalidated event on `stepId` at or after `resolvedSeq`. */
export function occurredObligationClosed(ledger, stepId, resolvedSeq) {
  return ledger.events.some((e) => e.type === 'step-revalidated' && e.basis === 'recovery-occurred' && e.stepId === stepId && e.seq > resolvedSeq);
}


export function deriveState({ contract, acceptance, acceptanceDigest = null, ledger, layoutIssues = [], evidenceStale = false }) {
  const diagnostics = [];

  if (layoutIssues.length > 0) {
    return { state: 'unsupported', next: 'start-new-task', diagnostics: layoutIssues.map((d) => ({ code: 'SC101', severity: 'error', location: null, detail: d })) };
  }

  if (!ledger.valid) {
    if (ledger.corruption?.kind === 'tail') {
      return { state: 'blocked', next: 'repair-ledger', diagnostics: [{ code: 'SC306', severity: 'error', location: null, detail: 'the final ledger batch is truncated and can be repaired' }] };
    }
    const events = ledger.events ?? [];
    const hasUnclosedAction = events.some((e) => (e.type === 'step-started' || e.type === 'action-approved')
      && !events.some((f) => f.type === 'step-finished' && f.stepId === e.stepId && f.attempt === e.attempt && f.seq > e.seq));
    return {
      state: 'unsupported',
      next: hasUnclosedAction ? 'reconcile-external-state' : 'start-new-task',
      diagnostics: [{ code: 'SC104', severity: 'error', location: null, detail: 'the ledger is corrupted and cannot be trusted' }],
    };
  }

  const recovery = recoveryView(ledger);
  if (recovery.open) {
    return { state: 'recovery-required', next: 'resolve-recovery', diagnostics };
  }
  if (isCancelled(ledger)) {
    return { state: 'cancelled', next: 'none', diagnostics };
  }

  const approvals = computeApprovals(ledger, contract);
  const gate = activeGatePrepared(ledger);
  const record = latestRecordForRevision(ledger, contract.header.revision);
  const recordMatchesCurrent = Boolean(record) && record.termsDigest === contract.termsDigest
    && record.planDigest === contract.planDigest && record.contractDigest === contract.contractDigest;

  const memo = new Map();
  const stepStates = foldRevision(contract.header.revision, ledger, memo);
  const anyRunning = [...stepStates.values()].some((s) => s.status === 'running');

  const gateMatchesCurrent = Boolean(gate) && (() => {
    const gRecord = findEvent(ledger, gate.recordSeq);
    return gRecord && gRecord.revision === contract.header.revision && gRecord.termsDigest === contract.termsDigest
      && gRecord.planDigest === contract.planDigest && gRecord.contractDigest === contract.contractDigest;
  })();

  const hasApprovalHistory = ledger.events.some((e) => ['terms-approved', 'plan-approved', 'execution-authorized'].includes(e.type));
  const recoveryJustResolvedUnchanged = Boolean(recovery.latestResolved) && recovery.latestResolved.decision !== 'stop' && contract.header.mode === 'compact';

  const contentMismatch = hasApprovalHistory && !recordMatchesCurrent && !gateMatchesCurrent;
  if (contentMismatch || recoveryJustResolvedUnchanged) {
    if (recoveryJustResolvedUnchanged) {
      return { state: 'needs-reapproval', next: 'upgrade-to-full', diagnostics };
    }
    if (anyRunning) return { state: 'executing', next: 'reconcile-step', diagnostics };
    if (approvals.executionAuthorized === false && approvals.termsApproved && record && record.termsDigest === contract.termsDigest) {
      return { state: 'needs-reapproval', next: 'check-execution', diagnostics };
    }
    return { state: 'needs-reapproval', next: 'check-terms', diagnostics };
  }

  if (gate && gateMatchesCurrent) {
    return { state: 'awaiting-approval', next: `reprepare-${gate.gate}`, diagnostics, gate };
  }

  // accepted?
  const recorded = ledger.businessHead && ledger.businessHead.type === 'acceptance-recorded' ? ledger.businessHead : null;
  if (recorded && acceptance?.valid && recorded.revision === contract.header.revision
    && recorded.acceptanceDigest === acceptanceDigest && !evidenceStale) {
    return { state: 'accepted', next: 'none', diagnostics, approvals };
  }

  // drafting?
  const draftingNext = draftingCheck(contract, approvals, record, recordMatchesCurrent);
  if (draftingNext) return { state: 'drafting', next: draftingNext, diagnostics, approvals };

  // executing / blocked / verifying
  if (!approvals.executionAuthorized) {
    // plan approved but not authorized yet (Full plan-only path)
    return { state: 'drafting', next: 'check-execution', diagnostics, approvals };
  }

  const scheduled = scheduleSteps(contract, ledger, stepStates);
  if (scheduled) return { state: scheduled.state, next: scheduled.next, diagnostics, approvals, steps: scheduled.steps, current: scheduled.current };

  if (recorded) {
    return { state: 'verifying', next: evidenceStale ? 'revalidate-evidence' : 'record-acceptance', diagnostics, approvals };
  }
  return { state: 'verifying', next: 'write-acceptance', diagnostics, approvals };
}

function draftingCheck(contract, approvals, record, recordMatchesCurrent) {
  if (!contract.valid) return 'fix-contract';
  const gapOrUnverified = contract.terms.capabilities.some((c) => c.readiness === 'gap' || c.readiness === 'unverified');
  if (contract.header.mode === 'compact') {
    if (gapOrUnverified) return 'resolve-capability';
    if (!approvals.termsApproved) {
      if (contract.plan.pending) return 'write-plan';
      return recordMatchesCurrent ? null : 'check-compact';
    }
    return null;
  }
  // full
  if (!approvals.termsApproved) return 'check-terms';
  if (gapOrUnverified) return 'resolve-capability';
  if (contract.plan.pending) return 'write-plan';
  if (!approvals.planApproved) return recordMatchesCurrent ? null : 'check-execution';
  return null;
}

function scheduleSteps(contract, ledger, stepStates) {
  for (const step of contract.plan.steps) {
    const s = stepStates.get(step.id);
    const status = s?.status ?? 'pending';
    if (status === 'completed' || status === 'skipped') continue;

    if (status === 'running') {
      return { state: 'executing', next: 'reconcile-step', current: step.id };
    }

    if (status === 'failed' || status === 'blocked') {
      const capability = contract.capabilitiesById.get(step.capability);
      const hasFallback = capability && capability.fallback && capability.fallback.trim().toLowerCase() !== 'none';
      const usedFallback = fallbackUsed(ledger, contract.header.revision, step.id);
      if (hasFallback && !usedFallback) {
        return { state: 'blocked', next: 'assess-fallback', current: step.id };
      }
      const primaryAttempts = attemptsFor(ledger, contract.header.revision, step.id, 'primary');
      if (step.retrySafe && primaryAttempts < 2 && (!hasFallback || usedFallback)) {
        return { state: 'executing', next: GATED_EFFECTS.has(step.effect) ? 'check-action' : 'start-step', current: step.id };
      }
      return { state: 'blocked', next: 'ask-user', current: step.id };
    }

    // pending
    const depsReady = step.dependsOn.every((depId) => {
      const depState = stepStates.get(depId);
      return depState && (depState.status === 'completed' || depState.status === 'skipped');
    });
    if (!depsReady) return { state: 'blocked', next: 'ask-user', current: step.id };
    return { state: 'executing', next: GATED_EFFECTS.has(step.effect) ? 'check-action' : 'start-step', current: step.id };
  }
  return null;
}

export { computeApprovals, foldRevision, recoveryView, maxRecordedRevision, latestRecordForRevision, occurredRecoveryObligations };
