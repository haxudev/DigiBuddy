import { createHash } from 'node:crypto';

export const PROFILE_SECTIONS = [
  'Dimensions to clarify', 'Step skeleton', 'Acceptance criteria', 'Known pitfalls',
];
export const PROFILE_FIELDS = ['Profile id', 'Base profile'];
export const PROFILE_LINE_BUDGET = 120;

const PLACEHOLDER = /<[^>]+>|\b(?:TBD|TODO|FIXME|to be decided|fill (?:this|it) in|placeholder)\b/i;
const slug = (value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const digest = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

function exactField(text, label, errors) {
  const matches = [...text.matchAll(new RegExp(`^-\\s+\\*\\*${label}:\\*\\*\\s*(.+)$`, 'gmi'))];
  if (matches.length !== 1) {
    errors.push(`${label} must occur exactly once`);
    return '';
  }
  return matches[0][1].trim();
}

function exactSection(text, name, errors) {
  const matches = [...text.matchAll(new RegExp(`^## ${name}\\s*$`, 'gm'))];
  if (matches.length !== 1) {
    errors.push(`section "${name}" must occur exactly once`);
    return '';
  }
  const rest = text.slice(matches[0].index).replace(/^##[^\n]*\n?/, '');
  return rest.split(/\n## /, 1)[0].trim();
}

export function parseProfileContract(text, id, source = 'built-in', { forbiddenSkillNames = [] } = {}) {
  const errors = [];
  if (!slug(id)) errors.push('file id must be lowercase hyphenated');
  if (!['built-in', 'user', 'project'].includes(source)) errors.push('invalid profile source');
  if (text.split('\n').length > PROFILE_LINE_BUDGET) errors.push('profile exceeds line budget');
  if (PLACEHOLDER.test(text)) errors.push('profile contains a placeholder');

  const fields = Object.fromEntries(PROFILE_FIELDS.map((label) => [label, exactField(text, label, errors)]));
  const sections = Object.fromEntries(PROFILE_SECTIONS.map((name) => [name, exactSection(text, name, errors)]));
  const preamble = text.split(/^## /m, 1)[0].split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of preamble) {
    const allowed = /^# Profile:\s+\S/.test(line)
      || PROFILE_FIELDS.some((label) => line.startsWith(`- **${label}:**`));
    if (!allowed) errors.push(`unconsumed profile preamble content: ${line}`);
  }
  const h2 = [...text.matchAll(/^## (.+?)\s*$/gm)].map((match) => match[1]);
  for (const name of h2.filter((name) => !PROFILE_SECTIONS.includes(name))) errors.push(`unknown profile section "${name}"`);
  if (fields['Profile id'] !== id) errors.push('Profile id does not match file id');
  if (fields['Base profile'] !== 'none'
      && !/^(?:built-in|user):[a-z0-9]+(?:-[a-z0-9]+)*@sha256:[a-f0-9]{64}$/.test(fields['Base profile'])) {
    errors.push('invalid Base profile lineage');
  }

  // The dimension table is the only record of what a profile asks about. A
  // separate list of the same ids would be one more thing to keep in step, and
  // the contract would then spend its effort proving the two copies agree.
  const dimensionRows = sections['Dimensions to clarify'].split('\n').filter((line) => /^\|/.test(line))
    .filter((line) => !/^\|\s*(?:Dimension|[-: ]+)\s*\|/.test(line));
  const dimensionEntries = dimensionRows.map((line) => {
    const cells = line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    return { id: cells[0]?.match(/^\*\*\[([a-z][a-z0-9-]*)\]\s*\S/)?.[1] ?? null, deferrable: cells[1], why: cells[2] ?? '' };
  });
  if (dimensionEntries.length === 0
      || dimensionEntries.some((row) => !row.id || !['yes', 'no'].includes(row.deferrable) || !row.why)) {
    errors.push('every dimension needs a stable-id name, a yes/no deferrable cell, and its consequence');
  }
  const dimensions = dimensionEntries.map((row) => row.id).filter(Boolean);
  const deferrable = dimensionEntries.filter((row) => row.deferrable === 'yes').map((row) => row.id).filter(Boolean);
  if (new Set(dimensions).size !== dimensions.length) errors.push('duplicate dimension');

  const collect = (section, pattern, textGroup = 2) => [...section.matchAll(pattern)].map((match) => ({
    id: match[1], text: match[textGroup]?.trim() ?? '',
  }));
  const stepItems = collect(sections['Step skeleton'], /^\d+\.\s+\*\*\[(step-[a-z0-9-]+)\][^*]+\*\*\s*(.+)$/gm);
  const criterionItems = collect(sections['Acceptance criteria'], /^-\s+\*\*\[(criterion-[a-z0-9-]+)\]\*\*\s*(.+)$/gm);
  const pitfallItems = collect(sections['Known pitfalls'], /^\*\*\[(pitfall-[a-z0-9-]+)\]\s*([^*]+)\*\*\s*(.+)$/gm, 3);
  const itemLines = (section, pattern) => section.split('\n').filter((line) => pattern.test(line));
  if (itemLines(sections['Step skeleton'], /^\d+\.\s+/).length !== stepItems.length) errors.push('malformed or id-less step item');
  if (itemLines(sections['Acceptance criteria'], /^-\s+/).length !== criterionItems.length) errors.push('malformed or id-less criterion item');
  if (itemLines(sections['Known pitfalls'], /^\*\*/).length !== pitfallItems.length) errors.push('malformed or id-less pitfall item');
  const stepIds = stepItems.map((item) => item.id);
  const criterionIds = criterionItems.map((item) => item.id);
  const pitfallIds = pitfallItems.map((item) => item.id);
  if (stepIds.length === 0) errors.push('profile has no valid step item');
  if (criterionIds.length === 0) errors.push('profile has no valid criterion item');
  if (pitfallIds.length === 0) errors.push('profile has no valid pitfall item');
  const itemIds = [...stepIds, ...criterionIds, ...pitfallIds];
  if (new Set(itemIds).size !== itemIds.length) errors.push('duplicate profile item id');
  for (const [name, section] of Object.entries(sections)) {
    for (const line of section.split('\n').map((value) => value.trim()).filter(Boolean)) {
      const structural = (name === 'Dimensions to clarify' && line.startsWith('|')) || line === '---'
        || (name === 'Step skeleton' && /^\d+\.\s+\*\*\[step-/.test(line))
        || (name === 'Acceptance criteria' && /^-\s+\*\*\[criterion-/.test(line))
        || (name === 'Known pitfalls' && /^\*\*\[pitfall-/.test(line));
      if (!structural) errors.push(`unconsumed profile content in ${name}: ${line}`);
    }
  }
  for (const skill of forbiddenSkillNames) {
    if (new RegExp(`(?<![.\\w-])${skill}\\b`).test(text)) {
      errors.push(`profile names workflow skill ${skill}`);
    }
  }

  return {
    type: 'profile', slug: id, source, digest: digest(text), baseProfile: fields['Base profile'],
    dimensions, deferrable, stepItems, criterionItems, pitfallItems,
    stepIds, criterionIds, pitfallIds, itemIds,
    valid: errors.length === 0, errors,
  };
}
