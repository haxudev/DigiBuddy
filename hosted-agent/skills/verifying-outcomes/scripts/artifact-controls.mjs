import { createHash } from 'node:crypto';

/**
 * The control-field grammar shared by the task artifacts. It is deliberately
 * only the grammar: capability semantics, chronology, state derivation, and the
 * profile schema stay with the modules that own them.
 */

const CONTROL_FIELD = (label) => new RegExp(`^-\\s+\\*\\*${label}:\\*\\*\\s*(.+)$`, 'gmi');
const ISO_SHAPE = String.raw`(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))`;
const EXACT_ISO = new RegExp(`^${ISO_SHAPE}$`);
const ANY_ISO = new RegExp(ISO_SHAPE, 'g');

export const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
export const validSlug = (value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

/**
 * A duplicated control field is an ambiguity, not a typo: whichever copy the
 * reader happens to pick decides whether a gate opens. Return nothing rather
 * than choosing.
 */
export function field(text, label) {
  const matches = [...text.matchAll(CONTROL_FIELD(label))];
  return matches.length === 1 ? matches[0][1].trim() : '';
}

export const slugValue = (text) => control(frontmatter(text), 'task_slug');

/**
 * Control fields live in frontmatter; the body is what the user reads and
 * approves. A duplicated key is an ambiguity, not a typo — whichever copy the
 * reader happens to pick decides whether a gate opens — and so is a line that
 * is not a key at all, so either one invalidates the whole block rather than
 * being skipped.
 */
export function frontmatter(text) {
  if (typeof text !== 'string' || !text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return null;
  const fields = new Map();
  for (const line of text.slice(4, end + 1).split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-z][a-z0-9_]*):(?:[ \t]+(.*))?$/);
    if (!match || fields.has(match[1])) return null;
    fields.set(match[1], (match[2] ?? '').trim());
  }
  return fields.size > 0 ? fields : null;
}

export const control = (fields, key) => fields?.get(key) ?? '';

/** An enum whose paired timestamp is required by exactly the listed values. */
export function statusWithTime(fields, { key = 'status', timeKey, states, timed }) {
  const state = control(fields, key);
  const at = control(fields, timeKey);
  if (!states.includes(state)) return { state: 'invalid', at: null };
  if (timed.includes(state)) {
    const stamp = exactTimestamp(at);
    return stamp ? { state, at: stamp } : { state: 'invalid', at: null };
  }
  return /^n\/a$/i.test(at) ? { state, at: null } : { state: 'invalid', at: null };
}

const daysInMonth = (year, month) => [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28,
  31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

/**
 * Date.parse rolls impossible dates forward: 2026-09-31 becomes 1 October and
 * 2026-02-30 becomes 2 March, silently recording evidence for a day that never
 * happened. It also accepts a local-time string with no offset, which cannot
 * order anything across machines. Validate the fields instead, and do not
 * round-trip through Date, which normalises +08:00 into Z and would reject a
 * perfectly good offset.
 */
function validIsoParts(match) {
  const [, year, month, day, hour, minute, second = '00', zone, offsetHour, offsetMinute] = match;
  const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return false;
  if (h > 23 || mi > 59 || s > 59) return false;
  if (zone !== 'Z' && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
  return !Number.isNaN(Date.parse(match[0]));
}

/** For a field whose whole value is the timestamp. Trailing prose is a defect. */
export function exactTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(EXACT_ISO);
  return match && validIsoParts(match) ? match[0] : null;
}

/**
 * For a value that carries a timestamp inside prose, such as "approved by user
 * at <t>" or an evidence cell. Two timestamps in one value are as ambiguous as
 * two copies of one control field.
 */
export function embeddedTimestamp(value) {
  if (typeof value !== 'string') return null;
  const matches = [...value.matchAll(ANY_ISO)];
  return matches.length === 1 && validIsoParts(matches[0]) ? matches[0][0] : null;
}
