import { readFileSync } from 'node:fs';
import { compactArtifactsEligible, UNIVERSAL_DIMENSIONS } from './routing.mjs';
import { parseProfileContract } from './profile-contract.mjs';
import {
  LEDGER_REVISION_SCHEMA, REVISED_ARTIFACTS, parseLedger, reconcileLedger,
} from './ledger.mjs';
import {
  control, embeddedTimestamp, exactTimestamp, field, frontmatter, sha256, slugValue,
  statusWithTime, validSlug,
} from './artifact-controls.mjs';

export {
  parseLedger, reconcileLedger, stepContractDigest,
  LEDGER_SCHEMA, LEDGER_REVISION_SCHEMA, STEP_CONTRACT_FIELDS,
} from './ledger.mjs';

/**
 * Executable form of skills/superclarity/references/state-model.md.
 * The document is authoritative; this module makes its artifact ordering and
 * recovery claims executable. It derives state from parsed artifacts; it never
 * stores status separately.
 */

export const TERMINAL_STATUSES = ['completed', 'skipped'];
export const ALL_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped', 'blocked'];
export const CAPABILITY_NAMES = [...readFileSync(
  new URL('./capability-names.txt', import.meta.url), 'utf8',
).matchAll(/^([a-z][a-z0-9-]*)$/gm)].map((match) => match[1]);
const CAPABILITIES = new Set(CAPABILITY_NAMES);
export const LIFECYCLE_STATES = [
  'new', 'preflight-required', 'clarifying', 'awaiting-clarification-answer', 'awaiting-brief-approval',
  'awaiting-mode-selection', 'assembling-compact', 'awaiting-compact-approval', 'surveying', 'planning',
  'awaiting-plan-approval', 'ready-to-run', 'awaiting-user', 'blocked',
  'executing', 'verifying', 'delivered', 'recovery-required', 'paused', 'cancelled',
];

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const positiveInt = (value) => /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null;
// One version field, moving forward only. 1 is the original brief; 2 replaced the
// question quota with the discovery log; 3 replaced journal, recovery,
// observations and artifact times with the task ledger, and the report seal plus
// delivery proof with one signed manifest; 4 observes each artifact revision
// rather than each file, gives every plan step a stable id, and binds an
// authorization to the plan digest and the step contracts it approved; 5 makes
// mode an Agent recommendation plus a constrained user selection. A brief
// records approvals that cannot be recreated, so every earlier version keeps its
// own rules rather than being rejected or rewritten.
export const BRIEF_SCHEMA = 5;
export const BRIEF_SCHEMAS = [1, 2, 3, 4, 5];
export const LEDGER_BRIEF_SCHEMA = 3;
export const REVISION_BRIEF_SCHEMA = 4;
export const DELIVERY_MANIFEST_SCHEMA = 'delivery-manifest/1';
export const MANIFEST_ARTIFACTS = ['profile', 'brief', 'capabilities', 'plan', 'ledger', 'report'];
export const DISCOVERY_TRIGGERS = [
  'request-silent', 'contradiction', 'profile-selection', 'option-infeasible', 'vague-delegation',
];
export const DISCOVERY_OUTCOMES = ['pending', 'answered', 'partial', 'contradicted', 'withdrawn'];
// An outcome that settles nothing may be re-asked; one that settled the decision
// may not. This is what replaces the old numeric ceiling: churn is what a machine
// can see, and "how many questions is too many" is not.
const REASKABLE_OUTCOMES = ['partial', 'contradicted', 'withdrawn'];
// Decisions a prompt may target that are not brief dimensions. Choosing between
// plausible profiles and settling which of two contradictory answers governs are
// both real plan-changing questions with no dimension of their own.
export const DISCOVERY_META_DECISIONS = ['profile-selection', 'precedence'];
const ISO = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})`;
const hasSections = (text, names) => names.every((name) => new RegExp(`^## ${name}\\s*$`, 'm').test(text));
const sectionCount = (text, name) => [...text.matchAll(new RegExp(`^## ${name}\\s*$`, 'gm'))].length;
const PLACEHOLDER_RE = /<[^>]+>|\b(?:TBD|TODO|FIXME|to be decided|fill (?:this|it) in|placeholder)\b/i;
const noPlaceholders = (text) => !PLACEHOLDER_RE.test(text);
const nonEmpty = (value) => (typeof value === 'number' && Number.isFinite(value))
  || (typeof value === 'string' && value.trim().length > 0);
const meaningful = (value) => nonEmpty(value) && (typeof value === 'number'
  || (/[A-Za-z0-9\u4e00-\u9fff]/.test(value) && !PLACEHOLDER_RE.test(value)));

function sectionBody(text, name) {
  const matches = [...text.matchAll(new RegExp(`^## ${name}\\s*$`, 'gm'))];
  if (matches.length !== 1) return '';
  const start = matches[0].index;
  const rest = text.slice(start).replace(/^##[^\n]*\n?/, '');
  return rest.split(/\n## /, 1)[0].trim();
}

function sectionHasContent(text, name) {
  const lines = sectionBody(text, name).split('\n').map((line) => line.trim()).filter(Boolean);
  const prose = lines.filter((line) => !line.startsWith('|') && meaningful(line.replace(/^[-*#\s]+/, '')));
  if (prose.length > 0) return true;
  const rows = tableRows(text, name).filter((row) => row.some(meaningful));
  return rows.length >= 2;
}

export function parseBrief(text) {
  const fm = frontmatter(text);
  const { state: status, at: approvedAt } = statusWithTime(fm, {
    timeKey: 'approved_at', timed: ['approved'],
    states: ['draft', 'mode-selected', 'awaiting-approval', 'approved', 'paused', 'cancelled'],
  });
  const stoppedAt = exactTimestamp(control(fm, 'stopped_at'));
  const stopReason = control(fm, 'stop_reason');
  const stopValid = ['paused', 'cancelled'].includes(status)
    ? Boolean(stoppedAt) && meaningful(stopReason) && !/^n\/a$/i.test(stopReason)
    : /^n\/a$/i.test(control(fm, 'stopped_at')) && /^n\/a$/i.test(stopReason);

  const mode = control(fm, 'mode').toLowerCase();
  const slug = slugValue(text);
  const revision = positiveInt(control(fm, 'revision'));
  const createdAt = exactTimestamp(control(fm, 'created_at'));
  const risk = control(fm, 'risk_tier').toLowerCase();
  const compactBasis = control(fm, 'compact_basis').toLowerCase();
  const profile = control(fm, 'profile').toLowerCase();
  const profileDimensionsField = control(fm, 'profile_dimensions').toLowerCase();
  const profileDimensions = /^none$/.test(profileDimensionsField) ? []
    : profileDimensionsField.split(',').map((value) => value.trim()).filter(Boolean);
  const profileSource = control(fm, 'profile_source').toLowerCase();
  const profileDigest = control(fm, 'profile_digest').toLowerCase();
  // A brief carries approvals that cannot be recreated, so an unreadable schema
  // may not fail closed the way a delivery manifest does: telling a user to
  // delete and regenerate would destroy the record of what they agreed to. An
  // absent field is schema 1 and keeps its original rules verbatim.
  const schemaField = control(fm, 'schema_version');
  const schemaVersion = schemaField === '' ? 1 : (positiveInt(schemaField) ?? 0);
  const schemaValid = BRIEF_SCHEMAS.includes(schemaVersion);
  const v2 = schemaVersion >= 2;
  const ledgerBundle = schemaVersion >= LEDGER_BRIEF_SCHEMA;
  const revisionBundle = schemaVersion >= REVISION_BRIEF_SCHEMA;
  const sharedModeDecision = schemaVersion >= 5;
  const modeRecommendation = control(fm, 'mode_recommendation').toLowerCase();
  const modeSelection = control(fm, 'mode_selection').toLowerCase();
  const modeSelectedAt = exactTimestamp(control(fm, 'mode_selected_at'));
  const modeUpgradeReason = control(fm, 'mode_upgrade_reason');
  const legacyPrompts = /^\d+$/.test(control(fm, 'discovery_prompts'))
    ? Number(control(fm, 'discovery_prompts')) : null;
  const budgetEscalation = control(fm, 'budget_escalation');
  const compactApprovalEvent = control(fm, 'compact_approval_event');
  const compactApprovalAt = exactTimestamp(control(fm, 'compact_approval_at'));
  const compactApprovalId = /^[a-z0-9-]+$/i.test(compactApprovalEvent)
    && !/^(?:pending|n\/a)$/i.test(compactApprovalEvent) ? compactApprovalEvent : null;
  const pendingPrecedence = control(fm, 'pending_precedence');
  const requiredSections = ['Problem and current state', 'Outcome and audience', 'In scope', 'Out of scope', 'Constraints', 'Success criteria', 'Profile criteria decisions', 'Assumptions',
    ...(v2 ? ['Discovery log'] : [])];
  const closureRows = tableRows(text, 'Clarification closure')
    .filter((row) => row[0] !== 'Dimension' && !/^[-:]+$/.test(row[0]));
  const universal = UNIVERSAL_DIMENSIONS;
  const requiredDimensions = [...universal, ...profileDimensions];
  // Schema 2 replaces the single `answer:` prefix with one prefix per way an
  // answer can arrive, because volunteered information and a user-initiated
  // revision are not discovery prompts and must not be counted as any.
  const universalSource = v2
    ? new RegExp(String.raw`^(?:request:\s*|discovery:\s*Q\d+:\s*${ISO}:\s*|volunteered:\s*${ISO}:\s*|revision:\s*${ISO}:\s*)(.+)$`, 'i')
    : new RegExp(String.raw`^(?:request:\s*|answer:\s*${ISO}:\s*)(.+)$`, 'i');
  const validUniversalSource = (basis) => {
    const source = basis.match(universalSource)?.[1];
    return meaningful(source) && !/^unknown$/i.test(source);
  };
  const genericProfile = profile === 'none - generic';
  const profileValid = meaningful(profile)
    && (genericProfile
      ? profileDimensions.length === 0 && profileSource === 'n/a' && profileDigest === 'n/a'
      : profileDimensions.length > 0 && ['built-in', 'user', 'project'].includes(profileSource)
        && SHA256_RE.test(profileDigest))
    && profileDimensions.every((name) => /^[a-z][a-z0-9-]*$/.test(name));
  const closureValid = profileValid && closureRows.length >= requiredDimensions.length
    && new Set(closureRows.map((row) => row[0])).size === closureRows.length
    && requiredDimensions.every((name) => closureRows.some((row) => row[0] === name))
    && closureRows.every(([dimension, disposition, impact, basis, planImpact]) =>
      /^[a-z][a-z0-9-]*$/.test(dimension)
      && ['confirmed', 'assumed', 'deferred-operational'].includes(disposition)
      && ['none', 'low'].includes(impact)
      && (disposition === 'assumed' ? impact === 'low' : impact === 'none')
      && (!universal.includes(dimension)
        || (disposition === 'confirmed' && impact === 'none' && validUniversalSource(basis)))
      && meaningful(basis) && !/^unknown$/i.test(basis) && planImpact === 'none'
      && (disposition !== 'deferred-operational' || /named gate:/i.test(basis)));
  const assumptionRows = tableRows(text, 'Assumptions')
    .filter((row) => row[0] !== '#' && !/^[-:]+$/.test(row[0]));
  const assumedDimensions = closureRows.filter((row) => row[1] === 'assumed').map((row) => row[0]);
  const assumptionsValid = assumptionRows.every((row) => row.length >= 5
    && meaningful(row[0]) && requiredDimensions.includes(row[1])
    && meaningful(row[2]) && row[3] === 'low' && meaningful(row[4]))
    && assumedDimensions.every((dimension) => assumptionRows.some((row) => row[1] === dimension))
    && assumptionRows.every((row) => assumedDimensions.includes(row[1]));
  const escalation = budgetEscalation.match(/^high-impact:([a-z][a-z0-9-]*):\s*(.+)$/i);
  const legacyBudgetValid = legacyPrompts !== null && legacyPrompts <= 5
    && (legacyPrompts <= 3 ? /^none$/i.test(budgetEscalation)
      : Boolean(escalation && requiredDimensions.includes(escalation[1]) && meaningful(escalation[2])))
    && (legacyPrompts !== 0 || closureRows.filter((row) => universal.includes(row[0]))
      .every((row) => /^request:\s*.+/i.test(row[3])));
  const discoveryRows = v2 ? tableRows(text, 'Discovery log')
    .filter((row) => row[0] !== 'ID' && !/^[-:]+$/.test(row[0])) : [];
  const discoveryEvents = discoveryRows.map(([id, rev, trigger, decisions, consequence, askedAt, outcome]) => ({
    id,
    revision: positiveInt(rev ?? ''),
    trigger: (trigger ?? '').toLowerCase(),
    decisions: (decisions ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    consequence: consequence ?? '',
    askedAt: exactTimestamp(askedAt ?? ''),
    outcome: (outcome ?? '').toLowerCase(),
  }));
  const eventById = new Map(discoveryEvents.map((event) => [event.id, event]));
  const permittedDecision = (name) => requiredDimensions.includes(name)
    || DISCOVERY_META_DECISIONS.includes(name);
  const eventsShapeValid = discoveryRows.every((row) => row.length >= 7)
    && eventById.size === discoveryEvents.length
    && discoveryEvents.every((event, index) => event.id === `Q${index + 1}`
      && event.revision !== null && DISCOVERY_TRIGGERS.includes(event.trigger)
      && event.decisions.length > 0 && event.decisions.every(permittedDecision)
      && new Set(event.decisions).size === event.decisions.length
      && meaningful(event.consequence) && event.askedAt !== null
      && DISCOVERY_OUTCOMES.includes(event.outcome));
  // Re-asking a decision is legitimate only when the previous round left it open.
  // Reopening something already answered is churn, and churn is the failure the
  // old numeric ceiling was really aimed at.
  const churnValid = discoveryEvents.every((event, index) => event.decisions.every((decision) =>
    discoveryEvents.slice(0, index).every((earlier) => !earlier.decisions.includes(decision)
      || REASKABLE_OUTCOMES.includes(earlier.outcome))));
  const citation = new RegExp(String.raw`^discovery:\s*(Q\d+):\s*(${ISO}):`, 'i');
  const citationsValid = closureRows.every((row) => {
    const cited = row[3].match(citation);
    if (!cited) return true;
    const event = eventById.get(cited[1]);
    return Boolean(event) && event.decisions.includes(row[0])
      && ['answered', 'partial'].includes(event.outcome)
      && laterThan(cited[2], event.askedAt);
  });
  // A question the user has not answered yet cannot be part of a brief being
  // presented for approval; a draft may carry one across a compacted session.
  const pendingEvents = discoveryEvents.filter((event) => event.outcome === 'pending');
  const pendingGateValid = !['mode-selected', 'awaiting-approval', 'approved'].includes(status)
    || pendingEvents.length === 0;
  const unresolvedContradiction = discoveryEvents.some((event, index) =>
    event.outcome === 'contradicted' && event.decisions.some((decision) =>
      discoveryEvents.slice(index + 1).every((later) => !later.decisions.includes(decision))));
  const precedenceCoupled = unresolvedContradiction !== /^none$/i.test(pendingPrecedence);
  const discoveryValid = eventsShapeValid && churnValid && citationsValid
    && pendingGateValid && precedenceCoupled;
  const discoveryPrompts = v2 ? discoveryEvents.length : legacyPrompts;
  const compactApprovalValid = mode === 'compact'
    ? (/^pending$/i.test(compactApprovalEvent) ? compactApprovalAt === null
      : Boolean(compactApprovalId && compactApprovalAt))
    : /^n\/a$/i.test(compactApprovalEvent) && compactApprovalAt === null;
  const precedenceValid = /^none$/i.test(pendingPrecedence) || meaningful(pendingPrecedence);
  const successCriteria = sectionBody(text, 'Success criteria').split('\n')
    .map((line) => line.match(/^[-*]\s+(?:\[[ x]\]\s*)?(.+)$/i)?.[1]?.trim())
    .filter(Boolean).filter(meaningful);
  const profileCriteriaRows = tableRows(text, 'Profile criteria decisions')
    .filter((row) => row[0] !== 'Profile criterion' && row[0] !== 'n/a' && !/^[-:]+$/.test(row[0]));
  const profileCriteriaValid = genericProfile ? profileCriteriaRows.length === 0
    : profileCriteriaRows.length > 0 && new Set(profileCriteriaRows.map((row) => row[0])).size === profileCriteriaRows.length
      && profileCriteriaRows.every((row) => row.length >= 3 && /^[a-z][a-z0-9-]*$/.test(row[0])
        && ['accepted', 'declined'].includes(row[1]) && meaningful(row[2])
        && (row[1] !== 'accepted' || successCriteria.includes(row[2])));
  // A brief is drafted, paused, and cancelled as well as approved, so coupling
  // the decision to one status made every draft and every stopped task invalid
  // — and an invalid brief cannot even route a contradiction back to the user.
  // What the schema actually has to prove is narrower: an approval never rests
  // on a choice the user has not made, and an upgrade is never silent.
  const modeStatusValid = status !== 'mode-selected'
    || (sharedModeDecision && mode === 'compact' && modeSelection === 'compact');
  const modeDecisionValid = modeStatusValid && (!sharedModeDecision
    || (mode === 'recovery'
      ? modeRecommendation === 'n/a' && modeSelection === 'n/a'
        && modeSelectedAt === null && /^n\/a$/i.test(modeUpgradeReason)
      : ['compact', 'full'].includes(modeRecommendation)
        && ['pending', 'compact', 'full'].includes(modeSelection)
        && (modeSelection === 'pending'
          ? modeSelectedAt === null && /^n\/a$/i.test(modeUpgradeReason)
            && status !== 'approved'
          : modeSelectedAt !== null && laterThan(modeSelectedAt, createdAt)
            && (modeSelection === 'full'
              // Choosing Full approves the displayed brief, so the selection and
              // the approval are one instant rather than two.
              ? mode === 'full' && /^n\/a$/i.test(modeUpgradeReason)
                && (status !== 'approved' || approvedAt === modeSelectedAt)
              : mode === 'compact'
                ? /^n\/a$/i.test(modeUpgradeReason)
                  && (status !== 'approved' || laterThan(approvedAt, modeSelectedAt))
                // Compact was selected and proved ineligible. The recorded
                // reason is what makes the upgrade auditable rather than silent.
                : mode === 'full' && meaningful(modeUpgradeReason)
                  && !/^n\/a$/i.test(modeUpgradeReason)
                  && (status !== 'approved' || laterThan(approvedAt, modeSelectedAt))))));
  const valid = validSlug(slug) && ['compact', 'full', 'recovery'].includes(mode)
    && revision !== null && createdAt !== null && ['low', 'medium', 'high'].includes(risk)
    && successCriteria.length > 0 && status !== 'invalid' && stopValid && schemaValid
    && hasSections(text, requiredSections) && requiredSections.every((name) => sectionHasContent(text, name))
    && closureValid && assumptionsValid && (v2 ? discoveryValid : legacyBudgetValid)
    && compactApprovalValid && precedenceValid && profileCriteriaValid
    && modeDecisionValid && noPlaceholders(text);
  const basis = new Set(compactBasis.split(',').map((value) => value.trim()).filter(Boolean));
  const compactEligible = mode === 'compact' && risk === 'low'
    && ['new', 'no-conflict', 'reversible', 'one-session', 'no-money', 'no-sensitive-data',
      'no-external-effect', 'no-consequential-deliverable', 'clarity-closed'].every((value) => basis.has(value));

  return {
    type: 'brief', slug, status, mode, revision, createdAt, approvedAt, risk,
    stoppedAt, stopReason, discoveryPrompts, budgetEscalation, closureRows,
    schemaVersion, ledgerBundle, revisionBundle, sharedModeDecision,
    modeRecommendation, modeSelection, modeSelectedAt, modeUpgradeReason,
    modeDecisionValid, discoveryEvents, pendingEvents,
    compactApprovalId, compactApprovalAt, pendingPrecedence,
    profile, profileDimensions, profileSource, profileDigest, profileCriteriaRows,
    requiredDimensions, successCriteria,
    closureValid, assumptionsValid, discoveryValid, legacyBudgetValid,
    compactBasis, compactEligible, valid,
  };
}

export function parseProfile(text, slug, source = 'built-in') {
  return parseProfileContract(text, slug, source);
}

function tableRows(text, heading) {
  const section = sectionBody(text, heading);
  if (!section) return [];
  return section.split('\n').filter((line) => /^\|/.test(line))
    .map((line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.length > 1 && !cells.every((cell) => /^-+$/.test(cell)));
}

export function parseCapabilities(text) {
  const fm = frontmatter(text);
  const statusValue = control(fm, 'status');
  const status = ['draft', 'unresolved', 'resolved'].includes(statusValue) ? statusValue : 'invalid';
  const mode = control(fm, 'mode').toLowerCase();
  const slug = slugValue(text);
  const briefRevision = positiveInt(control(fm, 'brief_revision'));
  const revision = positiveInt(control(fm, 'revision'));
  const surveyedAt = exactTimestamp(control(fm, 'surveyed_at'));
  const compactSection = sectionBody(text, 'Compact eligibility');
  const compactChecks = compactSection.match(/^- \[x\]/gmi)?.length ?? 0;
  const rows = tableRows(text, 'Resolution').filter((row) => row[0] !== 'Capability' && !/^[-:]+$/.test(row[0]));
  const decisions = tableRows(text, 'Gap decisions').filter((row) => row[0] !== 'Capability' && !/^[-:]+$/.test(row[0]));
  const decisionByCapability = new Map(decisions.map((row) => [row[0], {
    decision: row[1], approvedAt: embeddedTimestamp(row[2]), effect: row[3],
  }]));
  const bindings = new Map(rows.map((row) => [row[0], {
    capability: row[0], provider: row[1], readiness: row[2], evidence: row[3], fallback: row[4],
  }]));
  const readiness = rows.map((row) => row[2]);
  const resolvedReadiness = ['confirmed', 'resolved-manual', 'resolved-substitute', 'resolved-drop'];
  const decisionFor = { 'resolved-manual': 'manual', 'resolved-substitute': 'substitute', 'resolved-drop': 'drop' };
  const contentValid = rows.length > 0 && bindings.size === rows.length && rows.every((row) => {
    const [capability, provider, state, evidence, fallback] = row;
    if (!CAPABILITIES.has(capability) || !meaningful(provider) || !meaningful(evidence) || !meaningful(fallback)) return false;
    if (!['confirmed', 'assumed', 'GAP', ...resolvedReadiness.slice(1)].includes(state)) return false;
    if (state === 'confirmed' && (!embeddedTimestamp(evidence) || !laterThan(surveyedAt, embeddedTimestamp(evidence))
        || /^(?:none|gap)$/i.test(provider))) return false;
    if (decisionFor[state]) {
      const decision = decisionByCapability.get(capability);
      return decision?.decision === decisionFor[state] && decision.approvedAt && nonEmpty(decision.effect);
    }
    return true;
  });
  const resolved = status === 'resolved' && contentValid && readiness.every((value) => resolvedReadiness.includes(value));
  const valid = validSlug(slug) && ['compact', 'full', 'recovery'].includes(mode) && briefRevision !== null
    && revision !== null && surveyedAt !== null && status !== 'invalid'
    && contentValid && noPlaceholders(text);
  const compactEligible = mode === 'compact' && resolved && compactChecks === 2
    && rows.every((row) => row[2] === 'confirmed');
  return {
    type: 'capabilities', slug, status, mode, briefRevision, revision, surveyedAt,
    rows, bindings, decisionByCapability, readiness, resolved, compactEligible, valid,
  };
}

export function parsePlan(text) {
  const fm = frontmatter(text);
  const { state: status, at: approvedAt } = statusWithTime(fm, {
    timeKey: 'approved_at', timed: ['approved'],
    states: ['draft', 'awaiting-approval', 'approved'],
  });
  const { state: execution, at: authorizedAt } = statusWithTime(fm, {
    key: 'execution', timeKey: 'authorized_at', timed: ['authorized'],
    states: ['not-authorized', 'authorized'],
  });

  const steps = [];
  let current = null;
  const stepSection = sectionBody(text, 'Steps');
  const duplicateFields = new Set();
  for (const raw of stepSection.split('\n')) {
    const heading = raw.match(/^###\s+Step\s+(\d+)\s+[-—]\s+(.+)$/);
    if (heading) {
      current = { n: Number(heading[1]), title: heading[2].trim() };
      steps.push(current);
      continue;
    }
    if (!current) continue;
    const match = raw.match(/^-\s+([a-z][a-z-]*)\s*:\s*(.*)$/);
    if (match) {
      if (Object.hasOwn(current, match[1])) duplicateFields.add(`${current.n}:${match[1]}`);
      current[match[1]] = match[2].trim();
    }
  }

  // A plan is a prospective contract, and a step's status is not part of the
  // contract. Schema 3 moves status to the ledger so an approved plan stops
  // being rewritten once per step; schema 1 and 2 plans keep it inline and are
  // read exactly as they were written.
  const inlineStateFields = ['status', 'verified-at', 'skip-approved'];
  const stepStateExternal = steps.length > 0
    && steps.every((s) => inlineStateFields.every((name) => !Object.hasOwn(s, name)));
  const stateShapeValid = steps.length > 0 && (stepStateExternal
    || steps.every((s) => inlineStateFields.every((name) => Object.hasOwn(s, name))));
  // Schema 4 gives every step a stable id, so a later revision can keep an
  // unchanged step's finished work without inheriting by position - which would
  // land a completion on whatever the revision renumbered into that place. A
  // plan where only some steps carry one is a plan with two identities.
  const stepIdentity = steps.length > 0 && steps.every((s) => Object.hasOwn(s, 'id'));
  const identityShapeValid = stepIdentity || steps.every((s) => !Object.hasOwn(s, 'id'));

  for (const s of steps) {
    if (stepStateExternal) s.status = 'pending';
    s.verifiedAt = exactTimestamp(s['verified-at']);
    s.skipApprovedAt = exactTimestamp(s['skip-approved']);
    s.retrySafe = s['retry-safe'] === 'yes';
    s.operations = positiveInt(s.operations);
    s.origin = s.origin?.toLowerCase();
    s.revalidates = s.revalidates?.trim();
    const dependency = s.depends?.match(/^Step\s+(\d+)\b/i);
    s.dependsOn = dependency ? Number(dependency[1]) : null;
  }
  // A dependency is written by position because within one revision that is
  // unambiguous, but it is compared by the identity it points at, so renumbering
  // alone never changes a step's contract while a changed dependency does.
  const byNumber = new Map(steps.map((s) => [s.n, s]));
  for (const s of steps) {
    s.dependsOnId = s.dependsOn === null ? null : (byNumber.get(s.dependsOn)?.id ?? null);
    s.dependsContract = s.dependsOn === null || !s.dependsOnId ? s.depends
      : s.depends.replace(/^Step\s+\d+/i, s.dependsOnId);
  }

  const required = ['capability', 'provider', 'fallback', 'verify', 'depends', 'risk', 'operations', 'origin', 'revalidates', 'retry-safe',
    ...(stepIdentity ? ['id'] : []),
    ...(stepStateExternal ? [] : inlineStateFields)];
  const numbersValid = steps.every((s, i) => s.n === i + 1);
  const idsValid = !stepIdentity || (steps.every((s) => /^[a-z][a-z0-9-]*$/.test(s.id))
    && new Set(steps.map((s) => s.id)).size === steps.length
    && steps.every((s) => s.dependsOn === null || s.dependsOnId !== null));
  const fieldsValid = duplicateFields.size === 0 && steps.length > 0 && stateShapeValid
    && identityShapeValid && idsValid
    && sectionCount(text, 'Steps') === 1
    && steps.every((s) => required.every((name) => meaningful(s[name]))
    && CAPABILITIES.has(s.capability) && ALL_STATUSES.includes(s.status)
    && ['low', 'medium', 'high'].includes(s.risk) && [1, 2].includes(s.operations)
    && ['new-work', 'revalidation'].includes(s.origin)
    && (s.origin === 'revalidation' ? !/^n\/a$/i.test(s.revalidates) : /^n\/a$/i.test(s.revalidates))
    && ['yes', 'no'].includes(s['retry-safe']) && !/^(?:GAP|TBD|assumed|none)$/i.test(s.provider)
    && (s.depends === 'none' || (s.dependsOn !== null && s.dependsOn < s.n)));
  const mode = control(fm, 'mode').toLowerCase();
  const slug = slugValue(text);
  const briefRevision = positiveInt(control(fm, 'brief_revision'));
  const capabilitiesRevision = positiveInt(control(fm, 'capabilities_revision'));
  const revision = positiveInt(control(fm, 'revision'));
  const createdAt = exactTimestamp(control(fm, 'created_at'));
  const recoveryHandling = control(fm, 'recovery_handling').toLowerCase();
  const compactApprovalEvent = control(fm, 'compact_approval_event');
  const compactApprovalAt = exactTimestamp(control(fm, 'compact_approval_at'));
  const compactApprovalId = /^[a-z0-9-]+$/i.test(compactApprovalEvent)
    && !/^(?:pending|n\/a)$/i.test(compactApprovalEvent) ? compactApprovalEvent : null;
  const risk = control(fm, 'risk_tier').toLowerCase();
  const profileApplied = control(fm, 'profile_applied').toLowerCase();
  const profileCoverageRows = tableRows(text, 'Profile coverage')
    .filter((row) => row[0] !== 'Profile item' && row[0] !== 'n/a' && !/^[-:]+$/.test(row[0]));
  const validCoverageLanding = (landing) => {
    if (/^not applicable:\s*\S/i.test(landing)) return true;
    const refs = [...landing.matchAll(/\bStep\s+(\d+)\b/g)].map((match) => Number(match[1]));
    return refs.length > 0 && refs.every((n) => n >= 1 && n <= steps.length);
  };
  const profileCoverageValid = meaningful(profileApplied)
    && sectionCount(text, 'Profile coverage') === 1
    && (profileApplied === 'n/a' ? profileCoverageRows.length === 0
      : /^[a-z0-9]+(?:-[a-z0-9]+)*@sha256:[a-f0-9]{64}$/.test(profileApplied)
        && profileCoverageRows.length > 0
        && new Set(profileCoverageRows.map((row) => row[0])).size === profileCoverageRows.length
        && profileCoverageRows.every((row) => row.length >= 3
          && /^[a-z][a-z0-9-]*$/.test(row[0])
          && ['skeleton', 'pitfall'].includes(row[1]) && meaningful(row[2])
          && validCoverageLanding(row[2])));
  const compactApprovalValid = mode === 'compact'
    ? (/^pending$/i.test(compactApprovalEvent) ? compactApprovalAt === null
      : Boolean(compactApprovalId && compactApprovalAt))
    : /^n\/a$/i.test(compactApprovalEvent) && compactApprovalAt === null;
  const valid = validSlug(slug) && ['compact', 'full', 'recovery'].includes(mode) && briefRevision !== null
    && capabilitiesRevision !== null && revision !== null && createdAt !== null
    && ['none', 'discard-and-restart', 'revalidate-untrusted-output'].includes(recoveryHandling)
    && ['low', 'medium', 'high'].includes(risk) && status !== 'invalid' && execution !== 'invalid'
    && compactApprovalValid && profileCoverageValid && numbersValid && fieldsValid && noPlaceholders(text);
  const compactEligible = mode === 'compact' && risk === 'low'
    && steps.every((s) => s.operations <= 2 && s.origin === 'new-work'
      && !['ask-user', 'communicate', 'cloud-ops'].includes(s.capability));

  return {
    type: 'plan', status, approvedAt, execution, authorizedAt,
    slug, mode, briefRevision, capabilitiesRevision, revision, createdAt, recoveryHandling,
    compactApprovalId, compactApprovalAt, stepStateExternal, stepIdentity,
    risk, profileApplied, profileCoverageRows, steps, compactEligible, valid,
  };
}

export function parseReport(text) {
  const fm = frontmatter(text);
  const { state, at: finalizedAt } = statusWithTime(fm, {
    timeKey: 'finalized_at', timed: ['finalized-complete', 'finalized-partial'],
    states: ['draft', 'finalized-complete', 'finalized-partial'],
  });
  const status = state === 'finalized-complete' ? 'complete'
    : state === 'finalized-partial' ? 'partial' : state;
  const planRevision = positiveInt(control(fm, 'plan_revision'));
  const slug = slugValue(text);
  const createdAt = exactTimestamp(control(fm, 'created_at'));
  const requiredSections = [
    'What was delivered', 'Coverage', 'Gaps and what they mean', 'Success criteria',
    'Evidence trail', 'Assumptions surviving delivery', 'Recovery disclosure',
    'Reusable lesson candidates',
  ];
  const criteriaRows = tableRows(text, 'Success criteria')
    .filter((row) => row[0] !== 'Criterion' && !/^[-:]+$/.test(row[0]));
  const deliveryRows = tableRows(text, 'What was delivered')
    .filter((row) => row[0] !== 'Artifact' && !/^[-:]+$/.test(row[0]));
  const coverageRows = tableRows(text, 'Coverage')
    .filter((row) => row[0] !== 'Dimension' && !/^[-:]+$/.test(row[0]));
  const evidenceRows = tableRows(text, 'Evidence trail')
    .filter((row) => row[0] !== 'Claim' && !/^[-:]+$/.test(row[0]));
  const lessonBody = sectionBody(text, 'Reusable lesson candidates');
  const lessonRows = tableRows(text, 'Reusable lesson candidates')
    .filter((row) => row[0] !== 'Candidate' && !/^[-:]+$/.test(row[0]));
  const lessonsValid = sectionCount(text, 'Reusable lesson candidates') === 1 && (/^none$/i.test(lessonBody)
    || (lessonRows.length > 0 && new Set(lessonRows.map((row) => row[0])).size === lessonRows.length
      && lessonRows.every((row) => row.length >= 5 && /^L[1-9]\d*$/.test(row[0])
        && ['pitfall', 'acceptance', 'skeleton', 'needs-dimension-change'].includes(row[1])
        && row.slice(2).every(meaningful))));
  const rowsValid = [deliveryRows, coverageRows, criteriaRows, evidenceRows]
    .every((rows) => rows.length > 0 && rows.every((row) => row.every(meaningful)));
  const criteriaValid = criteriaRows.every((row) => ['yes', 'no', 'partial'].includes(row[1]));
  const hasShortfall = criteriaRows.some((row) => row[1] !== 'yes');
  // Scoped to the section that owns them: these describe the disclosure, not
  // the report's control plane, so they stay where the reader meets them.
  const disclosure = sectionBody(text, 'Recovery disclosure');
  const recoveryIncident = field(disclosure, 'Incident');
  const recoveryDisposition = field(disclosure, 'Disposition').toLowerCase();
  const revalidationEvidence = field(disclosure, 'Revalidation evidence');
  const valid = validSlug(slug) && planRevision !== null && createdAt !== null
    && status !== 'invalid'
    && hasSections(text, requiredSections)
    && requiredSections.every((name) => sectionHasContent(text, name))
    && rowsValid && criteriaValid && lessonsValid && noPlaceholders(text);
  return {
    type: 'report', slug, status, planRevision, createdAt, finalizedAt,
    digest: sha256(text), deliveryRows, evidenceRows, criteriaRows, lessonRows, hasShortfall,
    recoveryIncident, recoveryDisposition, revalidationEvidence, valid,
  };
}

export function parseReportSeal(text) {
  const fm = frontmatter(text);
  const slug = slugValue(text);
  const planRevision = positiveInt(control(fm, 'plan_revision'));
  const reportFinalizedAt = exactTimestamp(control(fm, 'report_finalized_at'));
  const reportDigest = control(fm, 'report_sha256').toLowerCase();
  const sealedAt = exactTimestamp(control(fm, 'sealed_at'));
  const valid = validSlug(slug) && planRevision !== null && reportFinalizedAt !== null
    && SHA256_RE.test(reportDigest) && sealedAt !== null && laterThan(sealedAt, reportFinalizedAt)
    && noPlaceholders(text);
  return { type: 'report-seal', slug, planRevision, reportFinalizedAt, reportDigest, sealedAt, valid };
}

/**
 * One artifact does what the external seal and the signed proof did together.
 * The seal existed because a digest stored inside the content it identifies can
 * be changed along with that content; the proof existed because the seal covered
 * only the report. A manifest that lives outside every file it names and carries
 * one digest per input the `delivered` derivation read satisfies both reasons at
 * once, so there is nothing left for a second artifact to add.
 *
 * The manifest is closed: an absent optional input is signed as `none` rather
 * than omitted, so adding one later invalidates the manifest exactly as removing
 * one does. The signature is checked where the key lives; a reader without the
 * key still gets every binding that orders the bundle.
 */
export function parseDeliveryManifest(source) {
  let data = source;
  if (typeof source === 'string') { try { data = JSON.parse(source); } catch { data = null; } }
  const slug = typeof data?.task_slug === 'string' ? data.task_slug : '';
  const planRevision = Number.isInteger(data?.plan_revision) && data.plan_revision > 0
    ? data.plan_revision : null;
  const reportFinalizedAt = exactTimestamp(data?.report_finalized_at ?? '');
  const sealedAt = exactTimestamp(data?.sealed_at ?? '');
  const artifacts = data?.artifacts && typeof data.artifacts === 'object' && !Array.isArray(data.artifacts)
    ? data.artifacts : null;
  const digest = (name, optional = false) => (optional && artifacts?.[name] === 'none')
    || SHA256_RE.test(artifacts?.[name] ?? '');
  const valid = data?.schema === DELIVERY_MANIFEST_SCHEMA && validSlug(slug) && planRevision !== null
    && reportFinalizedAt !== null && sealedAt !== null && laterThan(sealedAt, reportFinalizedAt)
    && Boolean(artifacts) && Object.keys(artifacts ?? {}).length === MANIFEST_ARTIFACTS.length
    && MANIFEST_ARTIFACTS.every((name) => digest(name, name === 'profile'))
    && /^hmac-sha256:[a-f0-9]{64}$/.test(data?.signature ?? '');
  return {
    type: 'delivery-manifest', slug, planRevision, reportFinalizedAt, sealedAt,
    artifacts: artifacts ?? {}, reportDigest: artifacts?.report ?? '',
    signature: data?.signature ?? '', valid,
  };
}

export function parseRecovery(text) {
  const slug = slugValue(text);
  const matches = [...text.matchAll(/^## (Incident|Resolution) at\s+(.+)$/gm)];
  const events = matches.map((match, index) => {
    const kind = match[1].toLowerCase();
    const at = exactTimestamp(match[2]);
    const end = matches[index + 1]?.index ?? text.length;
    const block = text.slice(match.index, end);
    if (kind === 'incident') {
      const missingGate = field(block, 'Missing gate').toLowerCase();
      const rows = block.split('\n').filter((line) => /^\|/.test(line))
        .map((line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()))
        .filter((row) => row[0] !== 'Prior action/output' && !row.every((cell) => /^[-:]+$/.test(cell)));
      const valid = at && ['brief approval', 'capability resolution', 'plan approval', 'execution authorization'].includes(missingGate)
        && rows.length > 0 && rows.every((row) => meaningful(row[0]) && embeddedTimestamp(row[1]) && meaningful(row[2]) && meaningful(row[3]));
      const workTimes = rows.map((row) => embeddedTimestamp(row[1]));
      const outputs = rows.map((row) => row[0]);
      return { kind, at, missingGate, outputs, workTimes, valid: valid && workTimes.every((workAt) => laterThan(at, workAt)) };
    }
    const decision = field(block, 'Decision').toLowerCase();
    const revisionField = field(block, 'Prospective plan revision');
    const prospectivePlanRevision = positiveInt(revisionField);
    const valid = at && ['discard and restart', 'adopt as untrusted input and revalidate', 'stop'].includes(decision)
      && (decision === 'stop' ? /^n\/a$/i.test(revisionField) : prospectivePlanRevision !== null)
      && meaningful(field(block, 'Consequences shown'));
    return { kind, at, decision, prospectivePlanRevision, valid };
  });
  let sequenceValid = events.length > 0 && events[0].kind === 'incident';
  for (let i = 1; i < events.length; i++) {
    if (events[i].kind === events[i - 1].kind || !laterThan(events[i].at, events[i - 1].at)) sequenceValid = false;
    if (events[i - 1].kind === 'resolution' && events[i - 1].decision === 'stop') sequenceValid = false;
  }
  const latest = events.at(-1);
  const coveredThrough = events.filter((event) => event.kind === 'incident')
    .map((event) => event.at).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const status = latest?.kind === 'resolution' ? 'resolved' : 'open';
  const allOutputs = [...new Set(events.filter((event) => event.kind === 'incident').flatMap((event) => event.outputs))];
  const valid = validSlug(slug) && sequenceValid && events.every((event) => event.valid) && noPlaceholders(text);
  return {
    type: 'recovery', slug, status, events, allOutputs, valid,
    detectedAt: events[0]?.at ?? null, coveredThrough,
    resolvedAt: status === 'resolved' ? latest.at : null,
    decision: status === 'resolved' ? latest.decision : null,
    prospectivePlanRevision: status === 'resolved' ? latest.prospectivePlanRevision : null,
  };
}

const laterThan = (later, earlier) => Boolean(later && earlier && Date.parse(later) >= Date.parse(earlier));
const terminal = (step) => step.status === 'completed' ? Boolean(step.verifiedAt)
  : step.status === 'skipped' ? Boolean(step.skipApprovedAt) : false;
// A step carried from an earlier revision was not started under this one; it is
// a result this revision inherited. Counting it as started would make the moment
// between revising a plan and reauthorizing it derive as recovery, which is the
// one moment the documented revision path has to pass through.
const hasStartedSteps = (plan) => plan?.steps?.some((step) => step.status !== 'pending'
  && !step.carriedFromRevision);
// Only `deliveryReady` may ask for the derivation without its final gate. A
// plain boolean would let any caller pass it in and be told a bundle with no
// manifest is delivered, which is the one answer that flag must never produce.
const MANIFEST_PENDING = Symbol('manifest-pending');

/** Apply the first matching state-model row. */
function deriveTaskState({
  brief = null, capabilities = null, plan = null, report = null, reportSeal = null, recovery = null,
  deliveryManifest = null, manifestPending = false, bundleDigests = null,
  manifestSignatureVerified = false,
  environment = null,
  hasWorkEvidence = false, firstWorkAt = null, workEvidenceAt = [], unauthorizedWorkAt = null,
  externalWorkAt = null, latestWorkAt = null,
  observedEvidence = null, profile = null,
  artifactCreatedAt = null, artifactRevisions = null, authorizationDetail = null,
  blockedInputs = null,
} = {}) {
  // A file that could not be read, or one that belongs to the other schema, is
  // not a missing input: it is a bundle whose two readers would disagree.
  if (blockedInputs?.length) return 'recovery-required';
  if (latestWorkAt && !exactTimestamp(latestWorkAt)) return 'recovery-required';
  if (recovery && (!recovery.valid || recovery.status !== 'resolved')) return 'recovery-required';
  const recoveryResolved = recovery?.valid && recovery.status === 'resolved';
  if (recoveryResolved && recovery.decision === 'stop') {
    const laterWork = [...workEvidenceAt, ...(firstWorkAt ? [firstWorkAt] : [])]
      .some((at) => laterThan(at, recovery.resolvedAt));
    return brief?.status === 'cancelled' && !hasWorkEvidence && !laterWork ? 'cancelled' : 'recovery-required';
  }
  if (['paused', 'cancelled'].includes(brief?.status)) {
    const evidence = [...workEvidenceAt, ...(firstWorkAt ? [firstWorkAt] : [])];
    if ((hasWorkEvidence && evidence.length === 0)
        || (evidence.length > 0 && (!plan?.valid
          || evidence.some((at) => !plan.authorizedAt || !laterThan(at, plan.authorizedAt))))) {
      return 'recovery-required';
    }
    return brief.status;
  }
  if (recoveryResolved && brief?.mode !== 'recovery') return 'recovery-required';
  if (!recovery && [brief?.mode, capabilities?.mode, plan?.mode].includes('recovery')) return 'recovery-required';

  const hasObservedWork = Boolean(hasWorkEvidence || firstWorkAt || workEvidenceAt.length > 0);
  // The seal and the manifest hold the same position in the order: they are the
  // external identity a finalized report cannot give itself. Which one a bundle
  // uses is a schema question, so everything that only asks "is there already a
  // delivery identity here" asks it once, of whichever one applies.
  const ledgerBundle = Boolean(brief?.ledgerBundle);
  const revisionBundle = Boolean(brief?.revisionBundle);
  const sealed = reportSeal ?? deliveryManifest;
  if (brief && (ledgerBundle ? Boolean(reportSeal) : Boolean(deliveryManifest))) return 'recovery-required';
  if (brief && plan && Boolean(plan.stepStateExternal) !== ledgerBundle) return 'recovery-required';
  if (brief && plan && Boolean(plan.stepIdentity) !== revisionBundle) return 'recovery-required';
  const anyLater = Boolean(profile || capabilities || plan || report || sealed || recovery || hasObservedWork);
  if (!brief) return anyLater ? 'recovery-required' : (environment?.current ? 'clarifying' : 'new');
  // These times come from outside the artifacts precisely so that they can order
  // them. A value that is not a real instant orders nothing.
  //
  // Schema 3 recorded one observation per file, which is why a task that already
  // had a plan could not leave recovery: the recovery plan must be written after
  // the resolution, and that single observation was older than it. Schema 4
  // observes the revision, so the artifact is ordered by the revision it now
  // carries rather than by the moment the file first appeared. The revision is
  // ordered by its first appearance; its latest snapshot is what says which
  // bytes it now stands for, because a file goes on changing within a revision.
  const revisionRow = (name) => {
    const revision = { brief: brief?.revision, capabilities: capabilities?.revision, plan: plan?.revision }[name];
    return artifactRevisions?.[name]?.find((row) => row.revision === revision) ?? null;
  };
  const revised = (name) => revisionBundle && REVISED_ARTIFACTS.includes(name);
  const observedAt = (name) => (revised(name)
    ? exactTimestamp(revisionRow(name)?.at) : exactTimestamp(artifactCreatedAt?.[name]));
  // A revision's first snapshot proves only that the file, or the revision,
  // appeared; it says nothing about which bytes it now holds, since a file
  // keeps changing within a revision. Capabilities can sit as a draft,
  // unresolved snapshot before the resolution that freezes them, and
  // surveyed_at names that later freeze, not the draft that preceded it -- so
  // checking surveyed_at against the revision's first snapshot rejects a
  // perfectly ordinary append-only walk from draft to resolved. Binding it to
  // the latest snapshot instead names the same freeze the frontmatter claims.
  const observedFreezeAt = (name) => (revised(name)
    ? exactTimestamp(revisionRow(name)?.latestAt) : exactTimestamp(artifactCreatedAt?.[name]));
  // A ledger bundle's recovery is events in the ledger, not a file of its own,
  // and its events already carry the times that order it.
  if (!observedAt('brief')
      || (profile && !observedAt('profile'))
      || (capabilities && !observedAt('capabilities'))
      || (plan && !observedAt('plan'))
      || (report && !observedAt('report'))
      || (reportSeal && !observedAt('reportSeal'))
      || (recovery && !ledgerBundle && !observedAt('recovery'))) return 'recovery-required';
  // An observation is only evidence about these bytes while it still describes
  // them. A reader with no digests cannot tell, so it says so rather than
  // believing a revision it never checked. The revision in force must also be
  // the latest one observed: a file that has gone back to an earlier revision
  // has an approval history the ledger says was superseded.
  if (revisionBundle) {
    if (!bundleDigests) return 'recovery-required';
    // The instant at which each artifact's bytes were frozen by the control
    // transition that consumed them. A snapshot is evidence about a transition
    // only when it was taken at that instant: one recorded earlier attests
    // bytes that did not exist yet, and one recorded later is an edit the
    // approval never covered. After a freeze, content changes need a new
    // revision, which is what invalidates everything downstream of it.
    const frozenAt = {
      brief: brief.status === 'approved' ? brief.approvedAt : null,
      capabilities: capabilities?.status === 'resolved' ? capabilities.surveyedAt : null,
      plan: plan?.execution === 'authorized' ? plan.authorizedAt
        : plan?.status === 'approved' ? plan.approvedAt : null,
    };
    for (const [name, present] of [['brief', brief], ['capabilities', capabilities], ['plan', plan]]) {
      if (!present) continue;
      const row = revisionRow(name);
      if (!row || row !== artifactRevisions?.[name]?.at(-1)
        || row.digest !== bundleDigests[name]) return 'recovery-required';
      const freeze = frozenAt[name];
      if (!freeze) continue;
      const last = row.snapshots?.at(-1) ?? null;
      if (!last || Date.parse(last.at) !== Date.parse(freeze)
        || last.digest !== bundleDigests[name]) return 'recovery-required';
    }
    // A plan is frozen twice under one revision, and the two freezes cover
    // different bytes: approval covers the plan as approved, authorization the
    // same plan carrying its authorization. The approved bytes therefore have a
    // snapshot of their own, immediately before the authorized one — the only
    // content change an approved revision may still make is that transition.
    if (plan?.execution === 'authorized') {
      const approved = revisionRow('plan')?.snapshots?.at(-2) ?? null;
      if (!approved || Date.parse(approved.at) !== Date.parse(plan.approvedAt)
        || approved.digest === bundleDigests.plan) return 'recovery-required';
    }
    // An authorization is evidence about the bytes it named. A plan whose file
    // moved on afterwards — even with the later snapshot honestly appended — is
    // not the plan anybody authorized, and preferring the file or the
    // authorization silently is how work gets done under an approval nobody
    // gave. Nothing legitimate edits a plan after authorization: its step state
    // lives in the ledger, so a revision is the only way to change it.
    if (plan?.execution === 'authorized'
      && authorizationDetail?.get(plan.revision)?.planDigest !== bundleDigests.plan) {
      return 'recovery-required';
    }
  }
  // The two schemas record first-observed time from opposite sides. Schema 2
  // wrote a filesystem time at the end and could only require the artifact's own
  // claim not to predate it. A ledger event is appended once the file exists, so
  // the file's own creation time is the earlier of the two; requiring it the
  // other way round would send every honestly written bundle into recovery.
  //
  // Brief and plan are ordered by the moment their revision was first drafted,
  // which is the revision's first snapshot. Capabilities are ordered by
  // surveyed_at, which names the resolution freeze rather than the draft that
  // may have preceded it in the same revision, so capabilities alone is
  // checked against the latest snapshot.
  const observedOrder = (embedded, name) => {
    const at = name === 'capabilities' ? observedFreezeAt(name) : observedAt(name);
    return ledgerBundle ? laterThan(at, embedded) : laterThan(embedded, at);
  };
  if (!['approved', 'awaiting-approval', 'mode-selected', 'draft'].includes(brief.status)) {
    return anyLater ? 'recovery-required' : 'clarifying';
  }
  const genericProfile = brief.profile === 'none - generic';
  const profileMatchesBrief = genericProfile ? !profile
    : Boolean(profile?.valid && profile.slug === brief.profile
      && profile.source === brief.profileSource && profile.digest === brief.profileDigest
      && brief.profileDimensions.length === profile.dimensions.length
      && profile.dimensions.every((name) => brief.profileDimensions.includes(name))
      && brief.profileCriteriaRows.length === profile.criterionIds.length
      && profile.criterionItems.every((item) => brief.profileCriteriaRows.some((row) => row[0] === item.id
        && (row[1] === 'declined' || row[2] === item.text))));
  // Deferring a dimension the profile marks non-deferrable is a defect in the
  // brief, not out-of-order work, and it has to be visible before the user is
  // asked to approve it. Checking it only on the approved path produced the one
  // outcome no gate should ever produce: approve, then immediately recover.
  const unsafeDeferred = (brief.closureRows ?? []).some(([dimension, disposition]) =>
    disposition === 'deferred-operational' && (!(profile?.deferrable ?? []).includes(dimension)
      || UNIVERSAL_DIMENSIONS.includes(dimension)));
  if (brief.status === 'draft') {
    if (!profileMatchesBrief) return (capabilities || plan || report || sealed || hasObservedWork)
      ? 'recovery-required' : 'clarifying';
    if (brief.valid && !/^none$/i.test(brief.pendingPrecedence)) return 'awaiting-clarification-answer';
    if (report || sealed || hasObservedWork || hasStartedSteps(plan)) return 'recovery-required';
    if (capabilities || plan) {
      if (brief.mode !== 'compact' || !brief.compactEligible || sealed) return 'recovery-required';
      if (capabilities && (capabilities.slug !== brief.slug || capabilities.mode !== 'compact'
          || capabilities.briefRevision !== brief.revision)) return 'recovery-required';
      if (plan && (!capabilities?.valid || !capabilities.resolved
          || plan.slug !== brief.slug || plan.mode !== 'compact'
          || plan.briefRevision !== brief.revision
          || plan.capabilitiesRevision !== capabilities.revision)) return 'recovery-required';
    }
    return 'clarifying';
  }
  if (brief.status === 'mode-selected') {
    if (!brief.sharedModeDecision || brief.modeSelection !== 'compact'
        || brief.mode !== 'compact' || !brief.valid || !profileMatchesBrief
        || unsafeDeferred || !/^none$/i.test(brief.pendingPrecedence)) {
      return (capabilities || plan || report || sealed || hasObservedWork)
        ? 'recovery-required' : 'clarifying';
    }
    if (report || sealed || hasObservedWork || hasStartedSteps(plan)) return 'recovery-required';
    if (capabilities && (capabilities.slug !== brief.slug || capabilities.mode !== 'compact'
        || capabilities.briefRevision !== brief.revision)) return 'recovery-required';
    if (plan && (!capabilities?.valid || !capabilities.resolved
        || plan.slug !== brief.slug || plan.mode !== 'compact'
        || plan.briefRevision !== brief.revision
        || plan.capabilitiesRevision !== capabilities.revision)) return 'recovery-required';
    if (capabilities?.valid && capabilities.resolved && capabilities.compactEligible
        && plan?.valid && plan.compactEligible && plan.status === 'awaiting-approval'
        && plan.execution === 'not-authorized'
        && compactArtifactsEligible(brief, capabilities, plan)) {
      return 'awaiting-compact-approval';
    }
    return 'assembling-compact';
  }
  if (brief.status === 'awaiting-approval') {
    if (!brief.valid) return (capabilities || plan || report || hasObservedWork) ? 'recovery-required' : 'clarifying';
    if (!profileMatchesBrief) return (capabilities || plan || report || sealed || hasObservedWork)
      ? 'recovery-required' : 'clarifying';
    if (unsafeDeferred) return (capabilities || plan || report || sealed || hasObservedWork)
      ? 'recovery-required' : 'clarifying';
    if (!/^none$/i.test(brief.pendingPrecedence)) return 'awaiting-clarification-answer';
    if (brief.sharedModeDecision && brief.modeSelection === 'pending') {
      return (capabilities || plan || report || sealed || hasObservedWork)
        ? 'recovery-required' : 'awaiting-mode-selection';
    }
    if (brief.sharedModeDecision && brief.modeSelection === 'compact'
        && brief.mode === 'full' && meaningful(brief.modeUpgradeReason)
        && !/^n\/a$/i.test(brief.modeUpgradeReason)) {
      const safeCompactProposal = (!capabilities || (capabilities.valid
          && capabilities.slug === brief.slug && capabilities.mode === 'compact'
          && capabilities.briefRevision === brief.revision))
        && (!plan || (capabilities && plan.valid && plan.slug === brief.slug
          && plan.mode === 'compact' && plan.briefRevision === brief.revision
          && plan.capabilitiesRevision === capabilities.revision
          && plan.execution === 'not-authorized'));
      return safeCompactProposal && !report && !sealed && !hasObservedWork
        && !hasStartedSteps(plan) ? 'awaiting-brief-approval' : 'recovery-required';
    }
    if (brief.mode === 'compact' && brief.compactEligible
        && capabilities?.valid && capabilities.resolved && capabilities.compactEligible
        && capabilities.slug === brief.slug && capabilities.mode === 'compact'
        && capabilities.briefRevision === brief.revision
        && plan?.valid && plan.compactEligible && plan.mode === 'compact' && plan.status === 'awaiting-approval'
        && plan.slug === brief.slug
        && plan.execution === 'not-authorized' && plan.briefRevision === brief.revision
        && plan.capabilitiesRevision === capabilities.revision
        && compactArtifactsEligible(brief, capabilities, plan) && !hasStartedSteps(plan)
        && !report && !hasObservedWork) return 'awaiting-compact-approval';
    return (capabilities || plan || report || sealed || hasObservedWork) ? 'recovery-required' : 'awaiting-brief-approval';
  }
  if (!brief.valid) return anyLater ? 'recovery-required' : 'clarifying';
  if (!/^none$/i.test(brief.pendingPrecedence)) return 'awaiting-clarification-answer';
  if (!profileMatchesBrief) return 'recovery-required';
  const profileDimensions = profile?.dimensions ?? [];
  if (brief.profileDimensions.length !== profileDimensions.length
      || !profileDimensions.every((name) => brief.profileDimensions.includes(name))) return 'recovery-required';
  if (unsafeDeferred) return 'recovery-required';
  if (!laterThan(brief.approvedAt, brief.createdAt)) return 'recovery-required';
  if (!observedOrder(brief.createdAt, 'brief')
      || (!genericProfile && !laterThan(brief.approvedAt, observedAt('profile')))) {
    return 'recovery-required';
  }

  const upgradedFromCompact = brief.sharedModeDecision && brief.modeSelection === 'compact'
    && brief.mode === 'full' && meaningful(brief.modeUpgradeReason)
    && !/^n\/a$/i.test(brief.modeUpgradeReason);
  if (upgradedFromCompact && capabilities?.mode === 'compact') {
    const staleProposalValid = capabilities.valid && capabilities.slug === brief.slug
      && capabilities.briefRevision === brief.revision
      && (!plan || (plan.valid && plan.slug === brief.slug && plan.mode === 'compact'
        && plan.briefRevision === brief.revision
        && plan.capabilitiesRevision === capabilities.revision
        && plan.execution === 'not-authorized'));
    return staleProposalValid && !report && !sealed && !hasObservedWork
      && !hasStartedSteps(plan) ? 'surveying' : 'recovery-required';
  }
  if (capabilities && !observedOrder(capabilities.surveyedAt, 'capabilities')) {
    return 'recovery-required';
  }
  if (upgradedFromCompact && plan?.mode === 'compact') {
    const stalePlanValid = capabilities.valid && capabilities.resolved
      && capabilities.slug === brief.slug
      && capabilities.briefRevision === brief.revision
      && capabilities.mode === 'full'
      && laterThan(capabilities.surveyedAt, brief.approvedAt)
      && plan.valid && plan.slug === brief.slug
      && plan.briefRevision === brief.revision
      && plan.execution === 'not-authorized';
    return stalePlanValid && !report && !sealed && !hasObservedWork
      && !hasStartedSteps(plan) ? 'planning' : 'recovery-required';
  }
  if (plan && !observedOrder(plan.createdAt, 'plan')) return 'recovery-required';

  if (!capabilities) return (plan || report || sealed || hasObservedWork) ? 'recovery-required' : 'surveying';
  if (capabilities.status !== 'resolved') {
    return (plan || report || sealed || hasObservedWork) ? 'recovery-required' : 'surveying';
  }
  if (!capabilities.valid || capabilities.slug !== brief.slug
      || capabilities.briefRevision !== brief.revision
      || capabilities.mode !== brief.mode) return 'recovery-required';
  if (!capabilities.resolved) return 'recovery-required';
  const surveyBaseline = brief.mode === 'compact' ? brief.createdAt : brief.approvedAt;
  if (!laterThan(capabilities.surveyedAt, surveyBaseline)) return 'recovery-required';

  if (!plan) return (report || sealed || hasObservedWork || brief.mode === 'compact') ? 'recovery-required' : 'planning';
  // Work recorded under an earlier revision, each event at or after that
  // revision's own authorization, is honest history rather than evidence that
  // this revision ran early. Without this a plan could never be revised after
  // any work at all: the moment it is rewritten and before it is reauthorized
  // would derive as recovery, which is exactly the path the pack documents.
  const priorRevisionWork = revisionBundle && plan.revision > 1
    && Array.isArray(unauthorizedWorkAt) && unauthorizedWorkAt.length === 0
    // Only the ledger knows which authorization was in force for an event.
    // Work somebody else observed carries no revision, so it explains nothing.
    && !hasWorkEvidence && !firstWorkAt && (externalWorkAt?.length ?? 0) === 0;
  const unexplainedWork = hasObservedWork && !priorRevisionWork;
  if (plan.valid && (plan.slug !== brief.slug || plan.briefRevision !== brief.revision
      || plan.capabilitiesRevision !== capabilities.revision || plan.mode !== brief.mode
      || !laterThan(plan.createdAt, capabilities.surveyedAt))) return 'recovery-required';
  const expectedProfileApplied = genericProfile ? 'n/a' : `${profile.slug}@${profile.digest}`;
  const expectedCoverage = profile ? [...profile.stepIds, ...profile.pitfallIds] : [];
  if (plan.profileApplied !== expectedProfileApplied
      || plan.profileCoverageRows.length !== expectedCoverage.length
      || !expectedCoverage.every((id) => plan.profileCoverageRows.some((row) => row[0] === id))) {
    return 'recovery-required';
  }
  if (profile && plan.profileCoverageRows.some((row) => row[1] !== (profile.stepIds.includes(row[0]) ? 'skeleton' : 'pitfall'))) {
    return 'recovery-required';
  }
  if (plan.status === 'draft') {
    if (report || sealed || unexplainedWork || hasStartedSteps(plan) || brief.mode === 'compact') return 'recovery-required';
    return 'planning';
  }
  if (plan.status === 'awaiting-approval') {
    if (!plan.valid || plan.briefRevision !== brief.revision
        || plan.capabilitiesRevision !== capabilities.revision || plan.mode !== brief.mode) return 'planning';
    const proposalMismatch = plan.steps.filter((step) => step.status !== 'skipped').some((step) => {
      const binding = capabilities.bindings?.get?.(step.capability);
      return !binding || binding.readiness === 'resolved-drop'
        || binding.provider !== step.provider || binding.fallback !== step.fallback;
    });
    if (proposalMismatch) return 'recovery-required';
    if (brief.mode === 'compact') return 'recovery-required';
    return (report || sealed || unexplainedWork || hasStartedSteps(plan)) ? 'recovery-required' : 'awaiting-plan-approval';
  }
  if (plan.status !== 'approved' || !plan.valid || plan.briefRevision !== brief.revision
      || plan.capabilitiesRevision !== capabilities.revision || plan.mode !== brief.mode
      || !laterThan(plan.approvedAt, capabilities.surveyedAt)
      || !laterThan(plan.approvedAt, brief.approvedAt)
      || !laterThan(plan.approvedAt, plan.createdAt)) return 'recovery-required';

  if (brief.mode === 'compact' && (!brief.compactApprovalId
      || brief.compactApprovalId !== plan.compactApprovalId
      || brief.compactApprovalAt !== plan.compactApprovalAt
      || brief.approvedAt !== plan.approvedAt
      || brief.approvedAt !== brief.compactApprovalAt)) return 'recovery-required';

  if (plan.slug !== brief.slug) return 'recovery-required';

  const gapDecisionTimes = capabilities.rows.filter((row) => row[2].startsWith('resolved-'))
    .map((row) => capabilities.decisionByCapability?.get?.(row[0])?.approvedAt);
  if (gapDecisionTimes.some((at) => !at || !laterThan(capabilities.surveyedAt, at))) return 'recovery-required';

  const activeSteps = plan.steps.filter((step) => step.status !== 'skipped');
  if (activeSteps.some((step) => {
    const binding = capabilities.bindings?.get?.(step.capability);
    return !binding || binding.readiness === 'resolved-drop'
      || binding.provider !== step.provider || binding.fallback !== step.fallback;
  })) return 'recovery-required';

  if (brief.mode === 'compact' && !compactArtifactsEligible(brief, capabilities, plan)) return 'recovery-required';

  if (recovery) {
    if (!recovery.valid || recovery.slug !== brief.slug || recovery.status !== 'resolved'
        || recovery.decision === 'stop') return 'recovery-required';
    if (plan.mode !== 'recovery' || plan.revision !== recovery.prospectivePlanRevision
        || !laterThan(plan.createdAt, recovery.resolvedAt)) return 'recovery-required';
    // Reissued has to be observable, not asserted. Each of the three records a
    // new revision after the resolution, which is also what lets a task that
    // already had a plan leave recovery at all.
    if (revisionBundle && ['brief', 'capabilities', 'plan']
      .some((name) => !laterThan(observedAt(name), recovery.resolvedAt))) return 'recovery-required';
    if (recovery.decision === 'discard and restart'
        && (plan.recoveryHandling !== 'discard-and-restart'
          || plan.steps.some((step) => step.origin !== 'new-work'))) return 'recovery-required';
    if (recovery.decision === 'adopt as untrusted input and revalidate'
        && (plan.recoveryHandling !== 'revalidate-untrusted-output'
          || !recovery.allOutputs.every((output) => plan.steps.some((step) =>
            step.origin === 'revalidation' && step.revalidates === output)))) return 'recovery-required';
  } else if (plan.mode === 'recovery' || plan.recoveryHandling !== 'none') return 'recovery-required';

  if (plan.execution !== 'authorized') {
    return (report || sealed || unexplainedWork || hasStartedSteps(plan)) ? 'recovery-required' : 'ready-to-run';
  }
  if (!laterThan(plan.authorizedAt, plan.approvedAt)) return 'recovery-required';
  if (hasWorkEvidence || firstWorkAt || workEvidenceAt.length > 0) {
    const evidence = [...workEvidenceAt, ...(firstWorkAt ? [firstWorkAt] : [])];
    if (evidence.length === 0 || evidence.some((at) => !exactTimestamp(at))) return 'recovery-required';
    // A ledger knows which authorization was in force for each event, because
    // each one names its plan revision. Evidence that did not come from the
    // ledger carries no revision, so it is judged against the current
    // authorization �?which is all a schema 2 bundle ever recorded.
    const outside = externalWorkAt
      ? [...externalWorkAt, ...(firstWorkAt ? [firstWorkAt] : [])] : evidence;
    const unauthorized = unauthorizedWorkAt
      ? [...unauthorizedWorkAt, ...outside.filter((at) => !laterThan(at, plan.authorizedAt))]
      : evidence.filter((at) => !laterThan(at, plan.authorizedAt));
    for (const at of unauthorized) {
      if (!recoveryResolved || !recovery.coveredThrough
          || Date.parse(at) > Date.parse(recovery.coveredThrough)) return 'recovery-required';
    }
  }

  for (const step of plan.steps) {
    // A result carried from an earlier revision was authorized by that
    // revision's authorization, which the ledger already judged it against.
    // Measuring it against this revision's would demand that finished work be
    // done again for no reason but the revision.
    const gate = step.carriedFromRevision ? null : plan.authorizedAt;
    if (step.status === 'completed'
      && (!step.verifiedAt || (gate && !laterThan(step.verifiedAt, gate)))) return 'recovery-required';
    if (step.status === 'skipped'
      && (!step.skipApprovedAt || (gate && !laterThan(step.skipApprovedAt, gate)))) return 'recovery-required';
  }

  const outstanding = plan.steps.filter((step) => !terminal(step));
  if (outstanding.length > 0) {
    if (report || sealed) return 'recovery-required';
    const step = outstanding.find((candidate) => candidate.dependsOn === null
      || terminal(plan.steps.find((prior) => prior.n === candidate.dependsOn))) ?? outstanding[0];
    if (step.capability === 'ask-user' && step.status === 'running') return 'awaiting-user';
    if (['failed', 'blocked'].includes(step.status)) return 'blocked';
    return 'executing';
  }

  if (sealed && (!report || !['complete', 'partial'].includes(report.status))) return 'recovery-required';
  if (!report) return 'verifying';
  if (!report.valid || report.slug !== brief.slug || report.planRevision !== plan.revision) return 'recovery-required';
  if (report.criteriaRows.length !== brief.successCriteria.length
      || !brief.successCriteria.every((criterion) => report.criteriaRows.some((row) => row[0] === criterion))) {
    return 'recovery-required';
  }
  if (!['complete', 'partial'].includes(report.status)) return 'verifying';
  if (!observedOrder(report.createdAt, 'report')
      || !laterThan(report.finalizedAt, report.createdAt)) return 'recovery-required';
  // Work after the report was finalized is work the report does not describe.
  // The latest action is the latest one anybody saw, which on a bundle with no
  // ledger is whatever the caller observed.
  const latestActionAt = [latestWorkAt, firstWorkAt, ...workEvidenceAt]
    .filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  if (latestActionAt && Date.parse(latestActionAt) > Date.parse(report.finalizedAt)) return 'recovery-required';
  const lastTerminalAt = plan.steps.map((step) => step.verifiedAt ?? step.skipApprovedAt)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  if (!laterThan(report.finalizedAt, lastTerminalAt)) return 'recovery-required';
  const hasSkipped = plan.steps.some((step) => step.status === 'skipped');
  const partialRequired = hasSkipped || report.hasShortfall;
  if ((partialRequired && report.status !== 'partial') || (!partialRequired && report.status !== 'complete')) return 'recovery-required';
  if (!ledgerBundle) {
    if (!reportSeal) return 'verifying';
    if (!reportSeal.valid || reportSeal.slug !== report.slug
        || reportSeal.planRevision !== report.planRevision
        || reportSeal.reportFinalizedAt !== report.finalizedAt
        || reportSeal.reportDigest !== report.digest
        || !laterThan(reportSeal.sealedAt, report.finalizedAt)
        || !laterThan(reportSeal.sealedAt, artifactCreatedAt.reportSeal)) return 'recovery-required';
  }
  if (recovery) {
    const incidentSource = ledgerBundle ? /ledger\.jsonl/i : /recovery\.md/i;
    if (!incidentSource.test(report.recoveryIncident)) return 'recovery-required';
    if (recovery.decision === 'discard and restart') {
      if (report.recoveryDisposition !== 'discarded') return 'recovery-required';
      const reportText = [...report.deliveryRows, ...report.evidenceRows, ...report.criteriaRows].flat().join(' ');
      if (recovery.allOutputs.some((output) => reportText.includes(output))) return 'recovery-required';
    }
    if (recovery.decision === 'adopt as untrusted input and revalidate') {
      if (report.recoveryDisposition !== 'revalidated' || !meaningful(report.revalidationEvidence)) return 'recovery-required';
      if (!recovery.allOutputs.every((output) => plan.steps.some((step) =>
        step.origin === 'revalidation' && step.revalidates === output && step.status === 'completed'))) {
        return 'recovery-required';
      }
    }
  } else if (!/^none$/i.test(report.recoveryIncident)) return 'recovery-required';
  if (!observedEvidence || typeof observedEvidence !== 'object') return 'verifying';
  const observations = observedEvidence.observations ?? [];
  const observed = (kind, ref, expectedDigest = null, expectedAt = null,
    revisions = [plan.revision]) => observations.some((item) => item.kind === kind
    && item.ref === ref && item.taskSlug === brief.slug && revisions.includes(item.planRevision)
    && laterThan(item.observedAt, item.contentUpdatedAt)
    && laterThan(report.finalizedAt, item.observedAt)
    && meaningful(item.contentDigest) && (!expectedDigest || item.contentDigest === expectedDigest)
    && (!expectedAt || item.observedAt === expectedAt));
  if (!report.deliveryRows.every((row) => observed('artifact', row[1], row[4], row[3]))) return 'verifying';
  if (!report.evidenceRows.every((row) => observed('claim', row[1], row[3], row[2]))) return 'verifying';
  // A carried step may be verified under either revision. The verifier stands in
  // the current one, so that is the revision it naturally names; the revision
  // that ran the step is equally honest when the verification happened then.
  // Requiring only the earlier one is a livelock: an agent verifying now would
  // append an observation of the current revision, the check would keep asking
  // for one it can no longer produce, and the task would verify forever. Either
  // way the observation still falls after the authorization of the revision it
  // names, which the ledger checks, and still carries the content digest of
  // what was actually opened.
  if (!plan.steps.filter((step) => step.status === 'completed')
    .every((step) => observed('verification', step.verify, null, null,
      step.carriedFromRevision ? [plan.revision, step.carriedFromRevision] : [plan.revision]))) return 'verifying';
  if (!report.criteriaRows.every((row) => observed('criterion', row[2], row[4], row[3]))) return 'verifying';
  // Last, because the manifest signs the bundle that everything above just
  // accepted. The writer runs this same derivation with `manifestPending` to ask
  // whether the bundle is ready to be signed; nothing else may set it, or a
  // bundle would derive as delivered without the identity that proves it.
  if (ledgerBundle && manifestPending !== MANIFEST_PENDING) {
    if (!deliveryManifest) return 'verifying';
    if (!deliveryManifest.valid || deliveryManifest.slug !== report.slug
        || deliveryManifest.planRevision !== report.planRevision
        || deliveryManifest.reportFinalizedAt !== report.finalizedAt
        || deliveryManifest.reportDigest !== report.digest) return 'recovery-required';
    // A manifest is only evidence if it still describes these bytes and was
    // signed by this project. A reader that checked neither would accept the
    // digests of files that have since changed �?which is the whole thing the
    // manifest exists to prevent.
    if (!manifestSignatureVerified || !bundleDigests) return 'recovery-required';
    if (MANIFEST_ARTIFACTS.some((name) => (bundleDigests[name] ?? 'none')
      !== deliveryManifest.artifacts[name])) return 'recovery-required';
  }
  return 'delivered';
}

/**
 * Adapt one ledger to the inputs the derivation reads. The ledger is the only
 * artifact that carries four kinds of evidence, so this is where it is split
 * back into them �?and where a step's status is put back on the plan it belongs
 * to, so that everything downstream keeps reading a step the way it always did.
 *
 * Caller-supplied evidence is added to, never replaced by, the ledger's: work
 * somebody else observed does not stop being work because this file has no line
 * for it.
 */
function withLedger(input) {
  const { ledger } = input;
  if (!ledger) return input;
  if (!ledger.valid) return { ...input, ledgerInvalid: true };
  const reconciled = input.plan ? reconcileLedger(input.plan, ledger) : { ok: true, states: new Map() };
  if (!reconciled.ok) return { ...input, ledgerInvalid: true };
  const plan = input.plan
    ? {
      ...input.plan,
      steps: input.plan.steps.map((step) => ({
        ...step,
        ...(reconciled.states.get(input.plan.stepIdentity ? step.id : step.n) ?? {}),
      })),
    }
    : input.plan;
  return {
    ...input,
    plan,
    recovery: ledger.recovery,
    artifactCreatedAt: ledger.artifactCreatedAt,
    artifactRevisions: ledger.artifactRevisions,
    authorizationDetail: ledger.authorizationDetail,
    observedEvidence: { observations: ledger.observations },
    workEvidenceAt: [...(input.workEvidenceAt ?? []), ...ledger.workEvidenceAt],
    externalWorkAt: input.workEvidenceAt ?? [],
    unauthorizedWorkAt: ledger.unauthorizedWorkAt,
    // The latest action is the latest one anybody saw, not the latest one this
    // file happens to record; taking only the ledger's would let work the caller
    // observed after finalization disappear.
    latestWorkAt: [ledger.latestWorkAt, input.latestWorkAt, input.firstWorkAt,
      ...(input.workEvidenceAt ?? [])]
      .filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
  };
}

/** The plan as the ledger says it actually stands, for callers that act on it. */
export function effectivePlan(input = {}) {
  return withLedger(input).plan ?? input.plan ?? null;
}

export function deriveState(input = {}) {
  // Validated before anything merges them: a folded maximum silently drops a
  // value that is not an instant, and a dropped value is one nobody judged.
  if ([input.latestWorkAt, input.firstWorkAt, ...(input.workEvidenceAt ?? [])]
    .some((at) => at != null && !exactTimestamp(at))) return 'recovery-required';
  const resolved = withLedger(input);
  if (resolved.ledgerInvalid || (input.ledger && input.ledger.slug !== input.brief?.slug)) {
    return 'recovery-required';
  }
  // A schema-3 brief without its ledger has lost the record that ordered it; a
  // ledger beside an earlier brief is a bundle two readers would disagree about.
  if (input.brief && Boolean(input.brief.ledgerBundle) !== Boolean(input.ledger)) return 'recovery-required';
  // The brief's schema and the ledger's grammar are one declaration made twice.
  // A revision-aware brief beside `task-ledger/1` has no revision chronology and no
  // step identity; the reverse has both and no artifact that admits to using
  // them.
  if (input.brief && input.ledger
    && Boolean(input.brief.revisionBundle)
      !== (input.ledger.schema === LEDGER_REVISION_SCHEMA)) return 'recovery-required';
  const state = deriveTaskState(resolved);
  if (!input.environment?.current
      && !['new', 'recovery-required', 'cancelled', 'delivered'].includes(state)) {
    return 'preflight-required';
  }
  return state;
}

/** True when every check except the delivery manifest itself already passes. */
export function deliveryReady(input = {}) {
  return deriveState({ ...input, manifestPending: MANIFEST_PENDING }) === 'delivered';
}

export function resumeAction(state, plan = null, ledger = null) {
  switch (state) {
    case 'new': return 'preflight';
    case 'preflight-required': return 'preflight';
    case 'clarifying': return 'finish-brief';
    case 'awaiting-clarification-answer': return 'ask-precedence';
    case 'awaiting-brief-approval': return 'get-brief-approval';
    case 'awaiting-mode-selection': return 'get-mode-selection';
    case 'assembling-compact': return 'assemble-compact-bundle';
    case 'awaiting-compact-approval': return 'get-compact-approval';
    case 'surveying': return 'resolve-capabilities';
    case 'planning': return 'finish-plan';
    case 'awaiting-plan-approval': return 'get-plan-approval';
    case 'ready-to-run': return 'get-execution-authorization';
    case 'paused':
    case 'cancelled': return 'ask-whether-to-reopen';
    case 'recovery-required': return 'stop-and-recover';
    case 'awaiting-user': return 'await-answer';
    case 'blocked': return 'resolve-with-user';
    case 'verifying': return 'verify';
    case 'delivered': return 'done';
    case 'executing': break;
    default: throw new Error(`unknown state: ${state}`);
  }

  // The plan file says pending for every step; only the ledger knows which one
  // is already running. Reading the file alone is how an interrupted
  // irreversible step gets started a second time.
  const current = ledger ? effectivePlan({ plan, ledger }) : plan;
  const step = current.steps.find((candidate) => !terminal(candidate)
    && (candidate.dependsOn === null || terminal(current.steps.find((prior) => prior.n === candidate.dependsOn))));
  if (!step) return 'resolve-dependencies';
  if (step.status === 'running') return step.retrySafe ? 'reconcile-then-redo' : 'reconcile-then-ask';
  return 'start-step';
}

/** Never let an unrelated open task hijack a new request. */
export function selectTask(tasks, { requestedSlug = null, resumeRequested = false } = {}) {
  if (requestedSlug) {
    const exact = tasks.find((task) => task.slug === requestedSlug);
    if (exact) return ['cancelled', 'paused'].includes(exact.state)
      ? { action: 'ask-whether-to-reopen', task: exact }
      : { action: 'resume', task: exact };
  }
  const open = tasks.filter((task) => !['delivered', 'cancelled'].includes(task.state));
  if (open.length === 0) return { action: 'start-new' };
  if (resumeRequested && open.length === 1) return { action: 'resume', task: open[0] };
  return { action: 'ask-which', candidates: open, allowStartNew: true };
}
