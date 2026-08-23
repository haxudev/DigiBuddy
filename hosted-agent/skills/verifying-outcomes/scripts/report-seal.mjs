#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { control, exactTimestamp, frontmatter, sha256, validSlug } from './artifact-controls.mjs';

const [command, reportArg, sealArg] = process.argv.slice(2);
if (!['seal', 'verify'].includes(command) || !reportArg) {
  console.error('usage: report-seal.mjs <seal|verify> <report.md> [report.seal.md]');
  process.exit(1);
}
const reportPath = resolve(reportArg);
const sealPath = resolve(sealArg ?? join(dirname(reportPath), 'report.seal.md'));
if (basename(reportPath) !== 'report.md' || basename(sealPath) !== 'report.seal.md'
    || dirname(reportPath) !== dirname(sealPath)) throw new Error('report and seal must be siblings with canonical names');
const report = readFileSync(reportPath, 'utf8');
// The seal belongs to a bundle that predates the ledger. Writing one beside a
// schema 3 report would add the artifact the manifest replaced, and the pair is
// exactly what the derivation refuses.
const briefPath = join(dirname(reportPath), 'brief.md');
if (existsSync(briefPath)
    && Number(readFileSync(briefPath, 'utf8').match(/^schema_version:\s*(\d+)\s*$/m)?.[1] ?? '1') >= 3) {
  throw new Error('this bundle uses the task ledger; seal it with delivery-manifest.mjs');
}
const reportFields = frontmatter(report);
const slug = control(reportFields, 'task_slug');
const revision = control(reportFields, 'plan_revision');
const finalizedAt = ['finalized-complete', 'finalized-partial'].includes(control(reportFields, 'status'))
  ? exactTimestamp(control(reportFields, 'finalized_at')) : null;
if (!validSlug(slug) || !/^\d+$/.test(revision) || Number(revision) < 1 || !finalizedAt) {
  throw new Error('report is not finalized with valid task and plan identity');
}
const digest = sha256(report);

if (command === 'seal') {
  const sealedAt = new Date(Math.max(Date.now(), Date.parse(finalizedAt))).toISOString();
  writeFileSync(sealPath, `---\ntask_slug: ${slug}\nplan_revision: ${revision}\nreport_finalized_at: ${finalizedAt}\nreport_sha256: ${digest}\nsealed_at: ${sealedAt}\n---\n\n# Report seal: ${slug}\n`,
    { encoding: 'utf8', flag: 'wx', flush: true });
  process.stdout.write(`${digest}\n`);
} else {
  const seal = frontmatter(readFileSync(sealPath, 'utf8'));
  // The seal time is part of what makes the seal evidence: a seal that claims to
  // predate the finalization it identifies was not produced by sealing it.
  const sealedAt = exactTimestamp(control(seal, 'sealed_at'));
  if (control(seal, 'task_slug') !== slug
      || control(seal, 'plan_revision') !== revision
      || control(seal, 'report_finalized_at') !== finalizedAt
      || control(seal, 'report_sha256') !== digest
      || !sealedAt || Date.parse(sealedAt) < Date.parse(finalizedAt)) {
    throw new Error('report seal does not match current report bytes');
  }
  process.stdout.write(`${digest}\n`);
}
