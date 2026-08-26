// Action gate payload schema and digest computation. See docs/vnext-spec.md
// §6.3. Path fields are validated for shape here; the CLI is responsible for
// resolving them safely on disk and expanding them to `{path, digest}` before
// the payload is canonicalized and hashed.

import { digest, isIsoTimestamp, parseStrictJson } from './markdown.mjs';

export const ACTION_TOP_LEVEL_KEYS = ['target', 'summary', 'cost', 'irreversibleImpact', 'alternatives', 'details'];

export const DETAIL_SCHEMA = {
  send: { accountChannel: 'string', recipients: 'string[]', body: 'string', attachments: 'path[]' },
  publish: { accountChannel: 'string', visibility: 'string', publishAt: 'publishAt', body: 'string', contentFiles: 'path[]' },
  payment: { payerContext: 'string', payee: 'string', amount: 'amount', currency: 'currency', feeCap: 'amount', duplicateCheck: 'string' },
  'infra-change': { accountProject: 'string', environment: 'string', resources: 'string[]', planFile: 'path', rollbackBackup: 'string' },
  destructive: { target: 'string', scope: 'string', backup: 'string', recovery: 'string' },
};

const AMOUNT_RE = /^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function sameSet(a, b) {
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.length === bs.length && as.every((x, i) => x === bs[i]);
}

const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/** Path fields carrying this shape after CLI expansion. */
export function isExpandedPath(v) {
  return v && typeof v === 'object' && Object.keys(v).sort().join(',') === 'digest,path' && isNonEmpty(v.path) && /^sha256:[a-f0-9]{64}$/.test(v.digest);
}

/**
 * Validate the raw (pre-expansion) action JSON against the closed schema for
 * `effect`. Returns { valid, errors }. Path fields are only checked for
 * being non-empty strings here; filesystem safety is the CLI's job.
 */
export function validateActionJsonShape(raw, effect) {
  const errors = [];
  const schema = DETAIL_SCHEMA[effect];
  if (!schema) { errors.push(`unknown effect ${effect}`); return { valid: false, errors }; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { errors.push('action JSON must be an object'); return { valid: false, errors }; }
  if (!sameSet(Object.keys(raw), ACTION_TOP_LEVEL_KEYS)) errors.push(`top-level keys must be exactly ${ACTION_TOP_LEVEL_KEYS.join(', ')}`);
  for (const key of ['target', 'summary', 'cost', 'irreversibleImpact', 'alternatives']) {
    if (!isNonEmpty(raw[key])) errors.push(`${key} must be a non-empty string`);
  }
  const details = raw.details;
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    errors.push('details must be an object');
  } else {
    if (!sameSet(Object.keys(details), Object.keys(schema))) errors.push(`details keys must be exactly ${Object.keys(schema).join(', ')}`);
    for (const [field, type] of Object.entries(schema)) {
      const value = details[field];
      if (type === 'string') { if (!isNonEmpty(value)) errors.push(`details.${field} must be a non-empty string`); }
      else if (type === 'string[]') {
        if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmpty) || new Set(value).size !== value.length) {
          errors.push(`details.${field} must be a non-empty array of unique non-empty strings`);
        }
      } else if (type === 'path') {
        if (!isNonEmpty(value)) errors.push(`details.${field} must be a non-empty path string`);
      } else if (type === 'path[]') {
        if (!Array.isArray(value) || (effect === 'publish' && field === 'contentFiles' && value.length === 0)
          || !value.every((v) => typeof v === 'string' && v.trim() !== '') || new Set(value).size !== value.length) {
          errors.push(`details.${field} must be ${effect === 'publish' && field === 'contentFiles' ? 'a non-empty' : 'an'} array of unique non-empty path strings`);
        }
      } else if (type === 'amount') {
        if (typeof value !== 'string' || !AMOUNT_RE.test(value)) errors.push(`details.${field} must be a decimal amount string`);
      } else if (type === 'currency') {
        if (typeof value !== 'string' || !CURRENCY_RE.test(value)) errors.push(`details.${field} must be a 3-letter uppercase currency code`);
      } else if (type === 'publishAt') {
        if (value !== 'now' && !isIsoTimestamp(value)) errors.push(`details.${field} must be an ISO timestamp or "now"`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function pathFields(effect) {
  return Object.entries(DETAIL_SCHEMA[effect]).filter(([, t]) => t === 'path' || t === 'path[]').map(([f, t]) => ({ field: f, array: t === 'path[]' }));
}

export function parseActionJsonText(text) {
  return parseStrictJson(text);
}

/** actionDigest = digest({revision, stepId, attempt, effect, binding, actionPayload, step, capability, reason}). */
export function computeActionDigest({ revision, stepId, attempt, effect, binding, actionPayload, step, capability, reason }) {
  return digest({ revision, stepId, attempt, effect, binding, actionPayload, step, capability, reason: reason ?? 'n/a' });
}
