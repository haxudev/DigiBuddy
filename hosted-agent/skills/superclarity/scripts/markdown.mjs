// Markdown/frontmatter parsing, canonicalization, and digest helpers for the
// vNext contract and acceptance artifacts. See docs/vnext-spec.md §2-4, §9.
//
// This module intentionally accepts a constrained line-oriented subset of
// Markdown, not arbitrary CommonMark: headings must match the vocabulary this
// file expects, tables must have an exact header row, and step blocks use a
// fixed `### S<n> - <title>` grammar. Digests bind semantics, not layout.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- lexical

const PLACEHOLDER_RE = /^<[^<>]+>$/;
const PLACEHOLDER_WORDS = new Set(['tbd', 'todo', 'fixme']);

export function isPlaceholder(value) {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return true;
  if (PLACEHOLDER_WORDS.has(trimmed.toLowerCase())) return true;
  return PLACEHOLDER_RE.test(trimmed);
}

export function isVerificationPlaceholder(value) {
  const trimmed = (value ?? '').trim().toLowerCase();
  return isPlaceholder(value) || trimmed === 'done' || trimmed === 'looks good';
}

/** Fatal UTF-8 decode plus BOM rejection. Returns { text, errors }. */
export function decodeUtf8Strict(buffer) {
  const errors = [];
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    errors.push({ code: 'SC101', severity: 'error', location: null, detail: 'File starts with a UTF-8 BOM.' });
    return { text: null, errors };
  }
  let text = null;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    errors.push({ code: 'SC101', severity: 'error', location: null, detail: 'File is not valid UTF-8.' });
  }
  return { text, errors };
}

export function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n');
}

// ------------------------------------------------------------ frontmatter

const FRONTMATTER_LINE_RE = /^([a-z_]+):[ \t]*(.*?)[ \t]*$/;

/**
 * Parse a strict `key: value` frontmatter block. Not YAML: no quoting,
 * escaping, or type inference. Returns { fields: Map, bodyStart, errors }.
 * `bodyStart` is the character offset where the body begins (after the
 * closing `---` line and its newline).
 */
export function parseFrontmatter(text) {
  const errors = [];
  const fields = new Map();
  if (!text.startsWith('---\n')) {
    errors.push({ code: 'SC201', severity: 'error', location: null, detail: 'File does not start with frontmatter.' });
    return { fields, bodyStart: 0, errors };
  }
  const end = text.indexOf('\n---\n', 4);
  const endAtEof = text.endsWith('\n---') ? text.length - 4 : -1;
  const closeIdx = end !== -1 ? end : endAtEof;
  if (closeIdx === -1) {
    errors.push({ code: 'SC201', severity: 'error', location: null, detail: 'Frontmatter is never closed with ---.' });
    return { fields, bodyStart: 0, errors };
  }
  const body = text.slice(4, closeIdx);
  const bodyStart = end !== -1 ? end + 5 : text.length;
  const lines = body.length ? body.split('\n') : [];
  for (const raw of lines) {
    const m = raw.match(FRONTMATTER_LINE_RE);
    if (!m) {
      errors.push({ code: 'SC201', severity: 'error', location: null, detail: `Malformed frontmatter line: ${JSON.stringify(raw)}` });
      continue;
    }
    const [, key, value] = m;
    if (value === '') {
      errors.push({ code: 'SC201', severity: 'error', location: null, detail: `Frontmatter key "${key}" has an empty value.` });
      continue;
    }
    if (fields.has(key)) {
      errors.push({ code: 'SC201', severity: 'error', location: null, detail: `Duplicate frontmatter key "${key}".` });
      continue;
    }
    fields.set(key, value);
  }
  return { fields, bodyStart, errors };
}

// ------------------------------------------------------------- headings

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isIsoTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value)) return false;
  return new Date(value).toISOString() === value;
}

export function isPositiveInt(value) {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

/** Split into lines, tracking whether each line is inside a fenced code block. */
function classifyLines(body) {
  const lines = body.split('\n');
  const inFence = new Array(lines.length).fill(false);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(`{3,}|~{3,})/);
    if (fence) {
      inFence[i] = true;
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) { fence = m[1]; inFence[i] = true; continue; }
  }
  return { lines, inFence };
}

/** Extract the body of a `## Name` section (until the next `## ` heading). */
export function h2Section(body, name) {
  const { lines, inFence } = classifyLines(body);
  const heading = new RegExp(`^## ${name}$`);
  let start = -1;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    if (heading.test(lines[i])) { if (start === -1) start = i; count++; }
  }
  if (start === -1) return { body: null, count };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (inFence[i]) continue;
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return { body: lines.slice(start + 1, end).join('\n'), count };
}

/** Extract every `### Name` subsection body within a section body. */
export function h3Sections(body) {
  const { lines, inFence } = classifyLines(body);
  const out = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) { if (current) current.lines.push(lines[i]); continue; }
    const m = lines[i].match(/^### (.+)$/);
    if (m) {
      if (current) out.push(current);
      current = { heading: m[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(lines[i]);
  }
  if (current) out.push(current);
  return out.map((s) => ({ heading: s.heading, body: s.lines.join('\n') }));
}

export function h1Title(text, kind) {
  const lines = text.split('\n');
  const re = kind === 'contract' ? /^# Contract: (.+)$/ : /^# Acceptance record: (.+)$/;
  const matches = lines.filter((l) => re.test(l));
  if (matches.length !== 1) return null;
  const m = matches[0].match(re);
  const title = m[1].trim();
  return title === '' ? null : title;
}

// --------------------------------------------------------------- tables

function unescapeCell(cell) {
  return cell.trim().replace(/\\\|/g, '|');
}

/** Parse a Markdown table: header row, separator row, then data rows. */
export function parseTable(body) {
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const rows = lines.filter((l) => l.startsWith('|') && l.endsWith('|'));
  if (rows.length < 2) return null;
  const splitRow = (line) => line.slice(1, -1).split(/(?<!\\)\|/).map(unescapeCell);
  const header = splitRow(rows[0]);
  const sep = rows[1];
  if (!/^\|[\s:|-]+\|$/.test(sep)) return null;
  const dataRows = rows.slice(2).map(splitRow);
  return { header, rows: dataRows };
}

/** Parse a `- ` list, one item per line, no continuation/nesting. */
export function parseList(body) {
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const items = [];
  for (const line of lines) {
    const m = line.match(/^-\s+(.+)$/);
    if (!m) return null;
    items.push(m[1].trim());
  }
  return items;
}

// ------------------------------------------------------------- canonical

/**
 * Deterministic JSON serializer. Object keys sorted by Unicode scalar value;
 * arrays keep document order; strings use JSON short escapes for the
 * mandatory control characters and \u00xx for the rest of C0, `/` unescaped.
 */
export function canonicalStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error('canonicalStringify: only safe integers are allowed');
    }
    if (Object.is(value, -0)) throw new Error('canonicalStringify: -0 is not allowed');
    return String(value);
  }
  if (typeof value === 'string') return canonicalString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${canonicalString(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalStringify: unsupported value ${String(value)}`);
}

const SHORT_ESCAPES = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };

function canonicalString(str) {
  let out = '"';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff && ch.length === 1) {
      throw new Error('canonicalStringify: lone surrogate is not allowed');
    }
    if (SHORT_ESCAPES[ch]) { out += SHORT_ESCAPES[ch]; continue; }
    if (code < 0x20) { out += `\\u${code.toString(16).padStart(4, '0')}`; continue; }
    out += ch;
  }
  return `${out}"`;
}

export function sha256Hex(bytesOrString) {
  const h = createHash('sha256');
  h.update(typeof bytesOrString === 'string' ? Buffer.from(bytesOrString, 'utf8') : bytesOrString);
  return h.digest('hex');
}

/** digest(x) = sha256 over the canonical JSON serialization of x. */
export function digest(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

/** rawDigest(bytes) = sha256 over exact bytes, no canonicalization. */
export function rawDigest(bytesOrString) {
  return `sha256:${sha256Hex(bytesOrString)}`;
}

export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

// -------------------------------------------------------- strict JSON parse

/**
 * A JSON parser that rejects duplicate object keys, unlike JSON.parse (which
 * silently keeps the last value). Ledger batches and action payloads must
 * reject duplicates rather than silently accept one interpretation.
 */
export function parseStrictJson(text) {
  let i = 0;
  const n = text.length;
  const fail = (msg) => { throw new Error(`${msg} at position ${i}`); };
  const skipWs = () => { while (i < n && /[ \t\n\r]/.test(text[i])) i++; };
  const expect = (word) => {
    if (text.slice(i, i + word.length) !== word) fail(`expected ${word}`);
    i += word.length;
  };
  function parseValue() {
    skipWs();
    const c = text[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (c === 't') { expect('true'); return true; }
    if (c === 'f') { expect('false'); return false; }
    if (c === 'n') { expect('null'); return null; }
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    fail('unexpected token');
    return undefined;
  }
  function parseObject() {
    i++;
    const obj = {};
    skipWs();
    if (text[i] === '}') { i++; return obj; }
    for (;;) {
      skipWs();
      if (text[i] !== '"') fail('expected string key');
      const key = parseString();
      skipWs();
      if (text[i] !== ':') fail('expected colon');
      i++;
      const value = parseValue();
      if (Object.hasOwn(obj, key)) fail(`duplicate key "${key}"`);
      obj[key] = value;
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; break; }
      fail('expected , or }');
    }
    return obj;
  }
  function parseArray() {
    i++;
    const arr = [];
    skipWs();
    if (text[i] === ']') { i++; return arr; }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; break; }
      fail('expected , or ]');
    }
    return arr;
  }
  function parseString() {
    i++;
    let out = '';
    for (;;) {
      if (i >= n) fail('unterminated string');
      const c = text[i];
      if (c === '"') { i++; break; }
      if (c === '\\') {
        i++;
        const e = text[i];
        if (e === '"') out += '"';
        else if (e === '\\') out += '\\';
        else if (e === '/') out += '/';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === 'n') out += '\n';
        else if (e === 'r') out += '\r';
        else if (e === 't') out += '\t';
        else if (e === 'u') {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid unicode escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else fail('invalid escape');
        i++;
      } else if (c.charCodeAt(0) < 0x20) {
        fail('control character in string');
      } else {
        out += c; i++;
      }
    }
    return out;
  }
  function parseNumber() {
    const start = i;
    if (text[i] === '-') i++;
    while (i < n && text[i] >= '0' && text[i] <= '9') i++;
    if (text[i] === '.') { i++; while (i < n && text[i] >= '0' && text[i] <= '9') i++; }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      while (i < n && text[i] >= '0' && text[i] <= '9') i++;
    }
    return Number(text.slice(start, i));
  }
  const value = parseValue();
  skipWs();
  if (i !== n) fail('trailing content');
  return value;
}

