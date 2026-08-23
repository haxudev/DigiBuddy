/** Executable form of the Compact eligibility rules in entry-protocol.md. */

export const COMPACT_MAX_OPERATIONS_PER_STEP = 2;
export const COMPACT_FORBIDDEN_CAPABILITIES = new Set(['communicate', 'cloud-ops']);
export const INITIAL_MODE_ROUTES = Object.freeze({
  COMPACT_CANDIDATE: 'compact-candidate',
  FULL: 'full',
  RECOVERY: 'recovery',
});
export const MODE_SELECTIONS = Object.freeze({
  COMPACT: 'compact',
  FULL: 'full',
});
export const UNIVERSAL_DIMENSIONS = [
  'problem-current-state', 'outcome-audience', 'scope-boundary', 'constraints', 'success-criteria',
];

const ACTIVATION_SIGNALS = [
  'multiStep', 'longRunning', 'hasMoney', 'hasSensitiveData', 'hasIrreversibleAction',
  'hasExternalAction', 'hasSubmission', 'hasThirdPartyDeliverable', 'hasImportantDecisionOutput',
];

export function shouldActivate(input = {}) {
  if (input.explicit === true) return true;
  if (![true, false].includes(input.isWorkTask)
      || ACTIVATION_SIGNALS.some((signal) => typeof input[signal] !== 'boolean')) {
    return true;
  }
  return ACTIVATION_SIGNALS.some((signal) => input[signal]);
}

// Every way a universal dimension can be closed. `request:` and `answer:` are
// schema 1; schema 2 splits `answer:` into the prompt that produced it, the
// information the user volunteered, and the revision the user initiated, because
// only the first is a discovery prompt.
const SOURCED_BASIS = /^(?:request:|answer:\s*\d{4}-\d{2}-\d{2}T|discovery:\s*Q\d+:\s*\d{4}-\d{2}-\d{2}T|volunteered:\s*\d{4}-\d{2}-\d{2}T|revision:\s*\d{4}-\d{2}-\d{2}T)/i;

const hasSourcedUniversalClosure = (input) => {
  if (!Array.isArray(input.requiredDimensions) || !Array.isArray(input.closureRows)) return false;
  if (!UNIVERSAL_DIMENSIONS.every((dimension) => input.requiredDimensions.includes(dimension))) return false;
  const rows = new Map(input.closureRows.map((row) => [row[0], row]));
  return input.requiredDimensions.every((dimension) => {
    const row = rows.get(dimension);
    if (!row || row[4] !== 'none') return false;
    if (UNIVERSAL_DIMENSIONS.includes(dimension)) {
      return row[1] === 'confirmed' && row[2] === 'none' && SOURCED_BASIS.test(row[3]);
    }
    return row[1] === 'confirmed'
      || (row[1] === 'assumed' && row[2] === 'low')
      || (row[1] === 'deferred-operational' && row[2] === 'none' && /named gate:/i.test(row[3]));
  });
};

/**
 * Entry classification uses only facts available before clarification, survey,
 * and planning. Unknown downstream facts keep a new task eligible for candidate
 * assembly; they do not pretend that final Compact eligibility is proven.
 */
export function assessInitialMode(input = {}) {
  if (input.recoveryRequired === true) {
    return { route: INITIAL_MODE_ROUTES.RECOVERY, reason: 'invalid-or-unauthorized-prior-state' };
  }

  if (input.finalizedMode === 'full' || input.userPreference === 'full') {
    return { route: INITIAL_MODE_ROUTES.FULL, reason: 'full-selected' };
  }

  const disqualifiers = [
    ['not-a-new-task', input.newTask === false],
    ['conflicting-state', input.hasConflictingState === true],
    ['risk-above-low', ['medium', 'high'].includes(input.risk)],
    ['not-reversible', input.reversible === false],
    ['not-single-session', input.singleSession === false],
    ['money', input.hasMoney === true],
    ['sensitive-data', input.hasSensitiveData === true],
    ['external-effect', input.hasExternalEffect === true],
    ['consequential-deliverable', input.hasConsequentialDeliverable === true],
    ['active-readiness-check', input.requiresActiveReadinessCheck === true],
    ['setup-required', input.needsSetup === true],
    ['capability-gap', input.hasCapabilityGap === true],
    ['mid-execution-user-gate', input.hasMidExecutionUserGate === true],
    ['known-replanning-branch', input.hasKnownReplanningBranch === true],
    ['independent-workstreams', input.hasIndependentWorkstreams === true],
    ['long-running', input.longRunning === true],
  ];
  const blocker = disqualifiers.find(([, present]) => present);
  if (blocker) return { route: INITIAL_MODE_ROUTES.FULL, reason: blocker[0] };

  return { route: INITIAL_MODE_ROUTES.COMPACT_CANDIDATE, reason: 'no-known-disqualifier' };
}

export function recommendMode(input = {}) {
  const assessment = assessInitialMode(input);
  if (assessment.route === INITIAL_MODE_ROUTES.RECOVERY) {
    return { recommendation: 'recovery', reason: assessment.reason };
  }
  return {
    recommendation: assessment.route === INITIAL_MODE_ROUTES.FULL ? 'full' : 'compact',
    reason: assessment.reason,
  };
}

export function resolveModeSelection({
  selection, compactEligible = null, upgradeReason = null,
} = {}) {
  if (!Object.values(MODE_SELECTIONS).includes(selection)) {
    throw new Error(`unknown mode selection: ${selection}`);
  }
  if (selection === MODE_SELECTIONS.FULL) {
    return {
      mode: 'full', approveBrief: true, upgraded: false,
      next: 'resolve-capabilities', reason: 'user-selected-full',
    };
  }
  if (compactEligible === false) {
    if (typeof upgradeReason !== 'string' || upgradeReason.trim() === '') {
      throw new Error('Compact auto-upgrade requires a reason');
    }
    return {
      mode: 'full', approveBrief: false, upgraded: true,
      next: 'get-upgraded-full-brief-approval', reason: upgradeReason.trim(),
    };
  }
  return {
    mode: 'compact', approveBrief: false, upgraded: false,
    next: 'assemble-compact-bundle', reason: 'user-selected-compact-attempt',
  };
}

export function resolvePlanDecision(decision) {
  switch (decision) {
    case 'approve-and-auto-execute':
      return { status: 'approved', execution: 'authorized', next: 'execute' };
    case 'approve-plan-only':
      return { status: 'approved', execution: 'not-authorized', next: 'ready-to-run' };
    case 'revise':
      return { status: 'draft', execution: 'not-authorized', next: 'revise-plan' };
    case 'cancel':
      return {
        status: 'awaiting-approval', execution: 'not-authorized',
        briefStatus: 'cancelled', next: 'cancel-task',
      };
    default:
      throw new Error(`unknown plan decision: ${decision}`);
  }
}

export function chooseMode(input = {}) {
  const eligible = input.finalizedMode !== 'full'
    && input.userPreference !== 'full'
    && input.newTask === true
    && input.hasConflictingState === false
    && input.risk === 'low'
    && input.reversible === true
    && input.singleSession === true
    && input.hasMoney === false
    && input.hasSensitiveData === false
    && input.hasExternalEffect === false
    && input.hasConsequentialDeliverable === false
    && input.continuousExecution === true
    && input.hasMidExecutionUserGate === false
    && input.hasKnownReplanningBranch === false
    && input.hasIndependentWorkstreams === false
    && input.longRunning === false
    && Number.isInteger(input.maxCapabilitiesPerStep) && input.maxCapabilitiesPerStep === 1
    && Number.isInteger(input.maxOperationsPerStep) && input.maxOperationsPerStep >= 1
    && input.maxOperationsPerStep <= COMPACT_MAX_OPERATIONS_PER_STEP
    && input.providersReady === true
    && input.needsSetup === false
    && input.hasCapabilityGap === false
    && hasSourcedUniversalClosure(input);
  return eligible ? 'compact' : 'full';
}

export function canExecute(state) {
  return ['executing', 'awaiting-user', 'blocked', 'verifying'].includes(state);
}

export function routeIntent({ maintenanceRequested = false } = {}) {
  return maintenanceRequested ? 'distilling-lessons' : 'task-lifecycle';
}

export function compactArtifactsEligible(brief, capabilities, plan) {
  if (!brief?.compactEligible || !capabilities?.compactEligible || !plan?.compactEligible) return false;
  if (brief.mode !== 'compact' || capabilities.mode !== 'compact' || plan.mode !== 'compact') return false;
  if (brief.risk !== 'low' || plan.risk !== 'low') return false;
  return plan.steps.every((step) => {
    const binding = capabilities.bindings?.get?.(step.capability);
    return !COMPACT_FORBIDDEN_CAPABILITIES.has(step.capability)
      && step.operations <= COMPACT_MAX_OPERATIONS_PER_STEP && step.origin === 'new-work'
      && step.risk === 'low' && binding?.readiness === 'confirmed'
      && binding.provider === step.provider && binding.fallback === step.fallback;
  });
}
