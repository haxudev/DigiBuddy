// Domain model for the vNext contract and acceptance artifacts: parsing,
// canonicalization, digest scopes, and the structural validation rules from
// docs/vnext-spec.md §3, §4, §9. Ledger-aware state derivation lives in
// state.mjs, which composes this module with ledger.mjs.

import {
  canonicalStringify, digest, h1Title, h2Section, h3Sections, isIsoTimestamp,
  isPlaceholder, isPositiveInt, isVerificationPlaceholder, normalizeNewlines,
  parseFrontmatter, parseList, parseTable, rawDigest,
} from './markdown.mjs';

export const CriterionIdRe = /^K[1-9][0-9]*$/;
export const AssumptionIdRe = /^A[1-9][0-9]*$/;
export const CapabilityIdRe = /^C[1-9][0-9]*$/;
export const StepIdRe = /^S[1-9][0-9]*$/;
export const DeliverableIdRe = /^D[1-9][0-9]*$/;
export const TaskSlugRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const READINESS_VALUES = ['ready', 'unverified', 'gap', 'resolved-manual', 'resolved-substitute', 'resolved-drop'];
export const RESOLVED_READINESS = new Set(['resolved-manual', 'resolved-substitute', 'resolved-drop']);
export const EXECUTABLE_READINESS = new Set(['ready', 'resolved-manual', 'resolved-substitute', 'resolved-drop']);

export const EFFECT_VALUES = ['none', 'read-external', 'send', 'publish', 'payment', 'infra-change', 'destructive'];
export const GATED_EFFECTS = new Set(['send', 'publish', 'payment', 'infra-change', 'destructive']);
export const COMPACT_ALLOWED_EFFECTS = new Set(['none', 'read-external']);

const CONSTRAINT_NAMES = ['Deadline', 'Effort or budget ceiling', 'Output format', 'Permitted sources', 'Access and exposure'];

const CONTRACT_SECTIONS = ['Objective', 'Scope', 'Constraints', 'Success criteria', 'Assumptions', 'Capability bindings', 'Execution plan'];
const ACCEPTANCE_SECTIONS = ['Outcome summary', 'Deliverables', 'Success criteria', 'Coverage and gaps', 'Deviations and recovery', 'Remaining actions'];

const err = (code, detail) => ({ code, severity: 'error', location: null, detail });
const warn = (code, detail) => ({ code, severity: 'warning', location: null, detail });

// ------------------------------------------------------------- contract.md

export function parseContract(rawText) {
  const errors = [];
  const text = normalizeNewlines(rawText);
  const fm = parseFrontmatter(text);
  errors.push(...fm.errors);

  const schema = fm.fields.get('schema') ?? null;
  const task = fm.fields.get('task') ?? null;
  const mode = fm.fields.get('mode') ?? null;
  const revisionRaw = fm.fields.get('revision') ?? null;
  const createdAt = fm.fields.get('created_at') ?? null;

  if (schema !== 'superclarity-contract/1') errors.push(err('SC201', 'schema must be superclarity-contract/1'));
  if (task === null || !TaskSlugRe.test(task)) errors.push(err('SC201', 'task must be a valid TaskSlug'));
  if (mode !== 'compact' && mode !== 'full') errors.push(err('SC201', 'mode must be compact or full'));
  if (!isPositiveInt(revisionRaw)) errors.push(err('SC201', 'revision must be a positive integer'));
  if (!isIsoTimestamp(createdAt)) errors.push(err('SC201', 'created_at must be an ISO timestamp'));

  const body = text.slice(fm.bodyStart);
  const title = h1Title(body, 'contract');
  if (!title) errors.push(err('SC201', 'missing or empty # Contract: <title> heading'));

  const sectionBodies = {};
  for (const name of CONTRACT_SECTIONS) {
    const { body: sectionText, count } = h2Section(body, name);
    if (count === 0) errors.push(err('SC202', `missing section: ${name}`));
    else if (count > 1) errors.push(err('SC202', `duplicate section: ${name}`));
    sectionBodies[name] = sectionText ?? '';
  }
  checkUnknownH2(body, errors);

  const terms = parseTerms(sectionBodies, errors);
  const plan = parsePlan(sectionBodies['Execution plan'], terms.capabilities, mode, errors);

  const header = {
    schema: schema ?? 'superclarity-contract/1',
    task: task ?? '',
    mode: mode ?? 'full',
    revision: isPositiveInt(revisionRaw) ? Number(revisionRaw) : 0,
    createdAt: createdAt ?? '',
    title: title ?? '',
  };

  const valid = errors.filter((e) => e.severity === 'error').length === 0;

  const termsObj = { problem: terms.problem, outcomeAudience: terms.outcomeAudience, scopeIn: terms.scopeIn,
    scopeOut: terms.scopeOut, constraints: terms.constraints, criteria: terms.criteria,
    assumptions: terms.assumptions, capabilities: terms.capabilities };
  const planObj = { pending: plan.pending, steps: plan.steps };

  const headerNoRevision = { schema: header.schema, task: header.task, mode: header.mode, createdAt: header.createdAt, title: header.title };
  const termsDigest = digest({ header, terms: termsObj });
  const termsContentDigest = digest({ header: headerNoRevision, terms: termsObj });
  const planDigest = digest(planObj);
  const contractDigest = digest({ header, terms: termsObj, plan: planObj });

  const capabilitiesById = new Map(terms.capabilities.map((c) => [c.id, c]));
  const stepsById = new Map(plan.steps.map((s) => [s.id, s]));

  return {
    type: 'contract', valid, errors, warnings: errors.filter((e) => e.severity === 'warning'),
    header, terms: termsObj, plan: planObj,
    capabilitiesById, stepsById,
    termsDigest, termsContentDigest, planDigest: plan.pending ? 'none' : planDigest, contractDigest,
    planCanonicalDigest: planDigest,
  };
}

function checkUnknownH2(body, errors) {
  const lines = body.split('\n');
  const known = new Set(CONTRACT_SECTIONS.map((n) => `## ${n}`));
  for (const line of lines) {
    if (/^## /.test(line) && !known.has(line)) errors.push(err('SC204', `unknown section heading: ${line}`));
  }
}

function parseTerms(sectionBodies, errors) {
  // Objective
  const objectiveSubs = h3Sections(sectionBodies.Objective);
  const problemSub = objectiveSubs.find((s) => s.heading === 'Problem and current state');
  const outcomeSub = objectiveSubs.find((s) => s.heading === 'Outcome and audience');
  if (!problemSub || !problemSub.body.trim()) errors.push(err('SC202', 'Objective/Problem and current state is missing or empty'));
  if (!outcomeSub || !outcomeSub.body.trim()) errors.push(err('SC202', 'Objective/Outcome and audience is missing or empty'));
  for (const s of objectiveSubs) {
    if (s.heading !== 'Problem and current state' && s.heading !== 'Outcome and audience') {
      errors.push(err('SC204', `unexpected Objective subsection: ${s.heading}`));
    }
  }
  const problem = (problemSub?.body ?? '').trim();
  const outcomeAudience = (outcomeSub?.body ?? '').trim();

  // Scope
  const scopeSubs = h3Sections(sectionBodies.Scope);
  const inSub = scopeSubs.find((s) => s.heading === 'In');
  const outSub = scopeSubs.find((s) => s.heading === 'Out');
  const scopeIn = inSub ? parseList(inSub.body) : null;
  const scopeOut = outSub ? parseList(outSub.body) : null;
  if (!scopeIn || scopeIn.length === 0) errors.push(err('SC202', 'Scope/In must have at least one item'));
  if (!scopeOut || scopeOut.length === 0) errors.push(err('SC202', 'Scope/Out must have at least one item'));
  if (scopeOut && scopeOut.length === 1 && /^none$/i.test(scopeOut[0])) {
    errors.push(err('SC202', 'Scope/Out "none" must explain why nothing is excluded'));
  }

  // Constraints
  const constraintsTable = parseTable(sectionBodies.Constraints);
  const constraints = [];
  if (!constraintsTable || constraintsTable.header.length !== 2) {
    errors.push(err('SC202', 'Constraints table is missing or malformed'));
  } else {
    const byName = new Map();
    for (const row of constraintsTable.rows) {
      const [name, value] = row;
      if (byName.has(name)) errors.push(err('SC202', `duplicate Constraint: ${name}`));
      byName.set(name, value);
      if (!value || value.trim() === '') errors.push(err('SC202', `Constraint ${name} has an empty value`));
    }
    for (const name of CONSTRAINT_NAMES) {
      if (!byName.has(name)) errors.push(err('SC202', `missing Constraint: ${name}`));
      else constraints.push({ name, value: byName.get(name) });
    }
    for (const name of byName.keys()) {
      if (!CONSTRAINT_NAMES.includes(name)) errors.push(err('SC202', `unknown Constraint: ${name}`));
    }
  }

  // Success criteria
  const criteriaTable = parseTable(sectionBodies['Success criteria']);
  const criteria = [];
  if (!criteriaTable || criteriaTable.rows.length === 0) {
    errors.push(err('SC205', 'Success criteria must have at least one row'));
  } else {
    const seen = new Set();
    criteriaTable.rows.forEach((row, i) => {
      const [id, criterion, verification] = row;
      if (!CriterionIdRe.test(id) || id !== `K${i + 1}`) errors.push(err('SC205', `Success criteria row ${i + 1} has invalid ID ${id}`));
      if (seen.has(id)) errors.push(err('SC205', `duplicate criterion ID ${id}`));
      seen.add(id);
      if (isPlaceholder(criterion)) errors.push(err('SC205', `criterion ${id} is empty or a placeholder`));
      if (isVerificationPlaceholder(verification)) errors.push(err('SC205', `verification for ${id} is empty or vague`));
      criteria.push({ id, criterion, verification });
    });
  }

  // Assumptions
  const assumptionsBody = sectionBodies.Assumptions.trim();
  const assumptions = [];
  const assumptionsTable = parseTable(sectionBodies.Assumptions);
  if (assumptionsTable) {
    const seen = new Set();
    assumptionsTable.rows.forEach((row, i) => {
      const [id, assumption, basis, ifWrong] = row;
      if (!AssumptionIdRe.test(id) || id !== `A${i + 1}`) errors.push(err('SC202', `Assumptions row ${i + 1} has invalid ID ${id}`));
      if (seen.has(id)) errors.push(err('SC202', `duplicate assumption ID ${id}`));
      seen.add(id);
      if (isPlaceholder(assumption) || isPlaceholder(basis) || isPlaceholder(ifWrong)) {
        errors.push(err('SC202', `Assumptions row ${id} has an empty field`));
      }
      assumptions.push({ id, assumption, basis, ifWrong });
    });
  } else if (!/^none$/i.test(assumptionsBody)) {
    errors.push(err('SC202', 'Assumptions must be a valid table or the literal "none"'));
  }

  // Capability bindings
  const capTable = parseTable(sectionBodies['Capability bindings']);
  const capabilities = [];
  if (!capTable || capTable.rows.length === 0) {
    errors.push(err('SC203', 'Capability bindings must have at least one row'));
  } else {
    const seen = new Set();
    capTable.rows.forEach((row, i) => {
      const [id, need, primary, readiness, evidence, fallback, fallbackWhen, consequence] = row;
      if (!CapabilityIdRe.test(id)) errors.push(err('SC203', `invalid capability ID ${id}`));
      if (seen.has(id)) errors.push(err('SC203', `duplicate capability ID ${id}`));
      seen.add(id);
      if (isPlaceholder(need) || isPlaceholder(primary) || isPlaceholder(evidence)) {
        errors.push(err('SC203', `capability ${id} has an empty Need/Primary/Evidence`));
      }
      if (!READINESS_VALUES.includes(readiness)) errors.push(err('SC203', `capability ${id} has invalid readiness ${readiness}`));
      validateCapabilityRow({ id, primary, readiness, fallback, fallbackWhen, consequence }, errors);
      capabilities.push({ id, need, primary, readiness, evidence, fallback, fallbackWhen, consequence });
    });
  }

  return { problem, outcomeAudience, scopeIn: scopeIn ?? [], scopeOut: scopeOut ?? [], constraints, criteria, assumptions, capabilities };
}

function validateCapabilityRow({ id, primary, readiness, fallback, fallbackWhen, consequence }, errors) {
  if (readiness === 'ready' && /^(none|gap)$/i.test(primary ?? '')) {
    errors.push(err('SC203', `capability ${id} is ready but Primary is none/gap`));
  }
  if (readiness === 'gap' && !/^none$/i.test(primary ?? '')) {
    errors.push(err('SC203', `capability ${id} is a gap but Primary is not none`));
  }
  if (fallback === undefined || fallback.trim() === '') { errors.push(err('SC203', `capability ${id} Fallback must not be empty`)); return; }
  const noFallback = /^none$/i.test(fallback);
  if (noFallback) {
    if (!/^n\/a$/i.test(fallbackWhen ?? '')) errors.push(err('SC203', `capability ${id} Use-fallback-when must be n/a when Fallback is none`));
  } else {
    if (isPlaceholder(fallbackWhen) || /^n\/a$/i.test(fallbackWhen ?? '')) {
      errors.push(err('SC203', `capability ${id} Fallback trigger is required when fallback is present`));
    }
  }
  const resolved = RESOLVED_READINESS.has(readiness);
  if (noFallback) {
    if (resolved) {
      if (isPlaceholder(consequence) || /^n\/a$/i.test(consequence ?? '')) errors.push(err('SC203', `capability ${id} Consequence must describe the resolution impact`));
    } else if (!/^n\/a$/i.test(consequence ?? '')) {
      errors.push(err('SC203', `capability ${id} Consequence must be n/a`));
    }
  } else if (isPlaceholder(consequence) || /^n\/a$/i.test(consequence ?? '')) {
    errors.push(err('SC203', `capability ${id} Consequence must describe the fallback (and resolution, if resolved) impact`));
  }
}

const PENDING_SENTINEL = 'Pending until terms approval.';

function parsePlan(body, capabilities, mode, errors) {
  const trimmed = (body ?? '').trim();
  if (trimmed === PENDING_SENTINEL) {
    return { pending: true, steps: [] };
  }
  const capabilityById = new Map(capabilities.map((c) => [c.id, c]));
  const blocks = h3Sections(body ?? '');
  if (blocks.length === 0) { errors.push(err('SC206', 'Execution plan must have at least one step or the pending sentinel')); return { pending: false, steps: [] }; }
  const steps = [];
  const idsSeen = new Set();
  blocks.forEach((block, i) => {
    const m = block.heading.match(/^(S[1-9][0-9]*) - (.+)$/);
    if (!m) { errors.push(err('SC206', `invalid step heading: ${block.heading}`)); return; }
    const [, id, title] = m;
    if (idsSeen.has(id)) errors.push(err('SC206', `duplicate step id ${id}`));
    idsSeen.add(id);
    const fields = {};
    const dup = new Set();
    for (const line of block.body.split('\n')) {
      if (line.trim() === '') continue;
      const fm = line.match(/^- ([a-z-]+):[ \t]*(.*)$/);
      if (!fm) { errors.push(err('SC206', `step ${id}: unrecognized line "${line}"`)); continue; }
      const [, key, value] = fm;
      if (Object.hasOwn(fields, key)) dup.add(key);
      fields[key] = value.trim();
    }
    if (dup.size) errors.push(err('SC206', `step ${id}: duplicate field(s) ${[...dup].join(', ')}`));
    if ('provider' in fields || 'fallback' in fields) errors.push(err('SC206', `step ${id}: provider/fallback must not appear in a step`));

    const capability = fields.capability;
    const action = fields.action;
    const verify = fields.verify;
    const effect = fields.effect;
    if (!CapabilityIdRe.test(capability ?? '') || !capabilityById.has(capability)) errors.push(err('SC206', `step ${id}: unknown capability ${capability}`));
    else if (capabilityById.get(capability).readiness === 'resolved-drop') errors.push(err('SC206', `step ${id}: capability ${capability} is resolved-drop`));
    if (isPlaceholder(action)) errors.push(err('SC206', `step ${id}: action is empty or a placeholder`));
    if (isVerificationPlaceholder(verify)) errors.push(err('SC206', `step ${id}: verify is empty or vague`));
    if (!EFFECT_VALUES.includes(effect)) errors.push(err('SC206', `step ${id}: invalid effect ${effect}`));

    const dependsOnRaw = fields['depends-on'] ?? 'none';
    let dependsOn = [];
    if (dependsOnRaw !== 'none') {
      const parts = dependsOnRaw.split(',').map((p) => p.trim());
      if (parts.some((p) => p === '') || new Set(parts).size !== parts.length) {
        errors.push(err('SC206', `step ${id}: depends-on has empty or duplicate entries`));
      }
      for (const dep of parts) {
        if (!idsSeen.has(dep) || dep === id) errors.push(err('SC206', `step ${id}: depends-on ${dep} is not an earlier step`));
      }
      dependsOn = parts;
    }

    const output = fields.output ?? verify;
    const reversibleRaw = fields.reversible ?? (effect === 'none' ? 'yes' : undefined);
    if (reversibleRaw === undefined) errors.push(err('SC206', `step ${id}: reversible is required for effect ${effect}`));
    if (reversibleRaw !== undefined && reversibleRaw !== 'yes' && reversibleRaw !== 'no') errors.push(err('SC206', `step ${id}: reversible must be yes/no`));
    if (effect === 'payment' && reversibleRaw !== 'no') errors.push(err('SC206', `step ${id}: payment must have reversible: no`));
    const retrySafeRaw = fields['retry-safe'] ?? 'no';
    if (retrySafeRaw !== 'yes' && retrySafeRaw !== 'no') errors.push(err('SC206', `step ${id}: retry-safe must be yes/no`));
    const gate = fields.gate ?? 'n/a';
    const needsGate = GATED_EFFECTS.has(effect);
    if (needsGate && (isPlaceholder(gate) || /^n\/a$/i.test(gate))) errors.push(err('SC206', `step ${id}: gate is required for effect ${effect}`));
    if (!needsGate && gate !== 'n/a' && gate.trim() !== '') { /* allowed but unusual; not an error per spec (only省略或n/a required) */ }

    if (mode === 'compact') {
      if (!COMPACT_ALLOWED_EFFECTS.has(effect)) errors.push(err('SC221', `step ${id}: effect ${effect} is not allowed in Compact`));
    }

    steps.push({
      id, title, capability, action, verify, effect,
      dependsOn, output, reversible: reversibleRaw === 'yes', retrySafe: retrySafeRaw === 'yes', gate,
    });
  });
  return { pending: false, steps };
}

// ---------------------------------------------------------- acceptance.md

/**
 * Parse `acceptance.md` — the acceptance record, not the deliverable.
 *
 * The distinction is load-bearing: this file records whether the work is
 * accepted and where each deliverable lives, which is why `Deliverables` has
 * a `Location` column. A parser that treated it as the delivery itself would
 * have no reason to demand that column at all.
 */
export function parseAcceptance(rawText) {
  const errors = [];
  const text = normalizeNewlines(rawText);
  const fm = parseFrontmatter(text);
  errors.push(...fm.errors);

  const schema = fm.fields.get('schema') ?? null;
  const task = fm.fields.get('task') ?? null;
  const contractRevisionRaw = fm.fields.get('contract_revision') ?? null;
  const createdAt = fm.fields.get('created_at') ?? null;

  if (schema !== 'superclarity-acceptance/1') errors.push(err('SC701', 'schema must be superclarity-acceptance/1'));
  if (task === null || !TaskSlugRe.test(task)) errors.push(err('SC701', 'task must be a valid TaskSlug'));
  if (!isPositiveInt(contractRevisionRaw)) errors.push(err('SC701', 'contract_revision must be a positive integer'));
  if (!isIsoTimestamp(createdAt)) errors.push(err('SC701', 'created_at must be an ISO timestamp'));

  const body = text.slice(fm.bodyStart);
  const title = h1Title(body, 'acceptance');
  if (!title) errors.push(err('SC701', 'missing or empty # Acceptance record: <title> heading'));

  const sectionBodies = {};
  for (const name of ACCEPTANCE_SECTIONS) {
    const { body: sectionText, count } = h2Section(body, name);
    if (count === 0) errors.push(err('SC701', `missing section: ${name}`));
    else if (count > 1) errors.push(err('SC701', `duplicate section: ${name}`));
    sectionBodies[name] = sectionText ?? '';
  }

  const outcomeSummary = sectionBodies['Outcome summary'].trim();
  if (outcomeSummary === '') errors.push(err('SC701', 'Outcome summary must not be empty'));

  const deliverablesTable = parseTable(sectionBodies.Deliverables);
  const deliverables = [];
  if (!deliverablesTable || deliverablesTable.rows.length === 0) {
    errors.push(err('SC701', 'Deliverables must have at least one row'));
  } else {
    deliverablesTable.rows.forEach((row, i) => {
      const [id, location, purpose, evidence] = row;
      if (!DeliverableIdRe.test(id)) errors.push(err('SC701', `invalid deliverable ID ${id}`));
      if (isPlaceholder(location) || isPlaceholder(purpose) || isPlaceholder(evidence)) {
        errors.push(err('SC701', `Deliverables row ${id} has an empty field`));
      }
      deliverables.push({ id, location, purpose, evidence: evidence.split(';').map((s) => s.trim()).filter(Boolean) });
    });
  }

  const criteriaTable = parseTable(sectionBodies['Success criteria']);
  const criteria = [];
  if (!criteriaTable || criteriaTable.rows.length === 0) {
    errors.push(err('SC702', 'Success criteria must have at least one row'));
  } else {
    const seen = new Set();
    criteriaTable.rows.forEach((row) => {
      const [id, resultValue, evidence, explanation] = row;
      if (seen.has(id)) errors.push(err('SC702', `duplicate criterion ${id}`));
      seen.add(id);
      if (!['yes', 'no', 'partial'].includes(resultValue)) errors.push(err('SC702', `criterion ${id} has invalid result ${resultValue}`));
      if (isPlaceholder(explanation)) errors.push(err('SC702', `criterion ${id} explanation is empty`));
      criteria.push({ id, result: resultValue, evidence: (evidence ?? '').split(';').map((s) => s.trim()).filter(Boolean), explanation });
    });
  }

  const gapsTable = parseTable(sectionBodies['Coverage and gaps']);
  const gaps = [];
  if (!gapsTable || gapsTable.rows.length === 0) {
    errors.push(err('SC701', 'Coverage and gaps must have at least one row'));
  } else if (gapsTable.rows.length === 1 && gapsTable.rows[0][0] === 'none') {
    if (gapsTable.rows[0][1] !== 'n/a' || gapsTable.rows[0][2] !== 'n/a') errors.push(err('SC701', 'the none gap row must use n/a for Cause and Effect'));
  } else {
    for (const row of gapsTable.rows) {
      if (row[0] === 'none') { errors.push(err('SC701', 'the "none" gap row cannot coexist with real gaps')); continue; }
      if (row.some((c) => isPlaceholder(c))) errors.push(err('SC701', 'Coverage and gaps row has an empty field'));
      gaps.push({ gap: row[0], cause: row[1], effect: row[2] });
    }
  }

  const deviations = sectionBodies['Deviations and recovery'].trim();
  const remaining = sectionBodies['Remaining actions'].trim();

  const header = { schema: schema ?? 'superclarity-acceptance/1', task: task ?? '', contractRevision: isPositiveInt(contractRevisionRaw) ? Number(contractRevisionRaw) : 0, createdAt: createdAt ?? '', title: title ?? '' };
  const valid = errors.filter((e) => e.severity === 'error').length === 0;

  return {
    type: 'acceptance', valid, errors,
    header, outcomeSummary, deliverables, criteria, gaps, deviations, remaining,
    hasGaps: gaps.length > 0,
  };
}

// ------------------------------------------------------------ step digest

export function capabilityDigest(capability) {
  return digest(capability);
}

export function stepDigest(step, capability) {
  return digest({ step, capability });
}

export function planPendingCanonical() {
  return { pending: true, steps: [] };
}

// ----------------------------------------------------------------- effect

export function effectRequiresGate(effect) {
  return GATED_EFFECTS.has(effect);
}

export function effectAllowsCompact(effect) {
  return COMPACT_ALLOWED_EFFECTS.has(effect);
}

// ------------------------------------------------------------- keyword warning

const KEYWORD_RE = /(?:^|[^a-z0-9_])(publish|post|send|pay|payment|transfer|deploy|apply|drop|delete|destroy)(?:[^a-z0-9_]|$)/;

export function keywordWarningApplies(step) {
  if (step.effect !== 'none') return false;
  const combined = `${step.action}\n${step.verify}`.toLowerCase();
  return KEYWORD_RE.test(combined);
}

export { canonicalStringify, digest, rawDigest };
