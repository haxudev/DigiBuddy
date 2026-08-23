#!/usr/bin/env node

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  deriveState, parseBrief, parseCapabilities, parsePlan, parseProfile, parseRecovery,
  parseReport, parseReportSeal,
} from './lifecycle.mjs';

/**
 * The manifest is closed: one digest for every input the delivered derivation
 * read. An input that is derived from but left out of the manifest can change
 * afterwards without invalidating the proof, which is the same as not proving
 * it at all. Absent optional inputs are signed as `none` so that adding one
 * later invalidates the proof exactly as removing one does.
 */
const PROOF_SCHEMA = 'delivery-proof/1';

const [workspaceArg = process.cwd(), taskSlug] = process.argv.slice(2);
if (!taskSlug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(taskSlug)) {
  console.error('usage: delivery-proof.mjs <workspace> <task-slug>'); process.exit(1);
}
const workspace = realpathSync(resolve(workspaceArg));
const task = join(workspace, '.superclarity', taskSlug);
const read = (name) => readFileSync(join(task, name), 'utf8');
const present = (name) => existsSync(join(task, name));
const digest = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
// Two skills build this manifest and neither may import the other, so key order
// must not be part of the agreement between them.
const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value));
const jsonDigest = (text) => digest(JSON.stringify(JSON.parse(text)));

const briefText = read('brief.md');
// The proof belongs to a bundle that predates the ledger; a schema 3 bundle
// seals with delivery-manifest.mjs and has no seal file for this to cover.
if (Number(briefText.match(/^schema_version:\s*(\d+)\s*$/m)?.[1] ?? '1') >= 3) {
  throw new Error('this bundle uses the task ledger; seal it with delivery-manifest.mjs');
}
const capabilitiesText = read('capabilities.md');
const planText = read('plan.md');
const reportText = read('report.md');
const sealText = read('report.seal.md');
const observationsText = read('observations.json');
const artifactTimesText = read('artifact-times.json');
const brief = parseBrief(briefText);
const capabilities = parseCapabilities(capabilitiesText);
const plan = parsePlan(planText);
const report = parseReport(reportText);
const reportSeal = parseReportSeal(sealText);
const profile = present('profile.md')
  ? parseProfile(read('profile.md'), brief.profile, brief.profileSource) : null;
const recovery = present('recovery.md') ? parseRecovery(read('recovery.md')) : null;
const observedEvidence = JSON.parse(observationsText);
const artifactCreatedAt = JSON.parse(artifactTimesText);
const state = deriveState({ environment: { current: true }, brief, profile, capabilities, plan, report,
  reportSeal, recovery, observedEvidence, artifactCreatedAt });
if (state !== 'delivered') throw new Error(`task bundle derives as ${state}, not delivered`);

const artifacts = {
  profile: profile ? digest(read('profile.md')) : 'none',
  brief: digest(briefText),
  capabilities: digest(capabilitiesText),
  plan: digest(planText),
  report: digest(reportText),
  seal: digest(sealText),
  recovery: recovery ? digest(read('recovery.md')) : 'none',
  observations: jsonDigest(observationsText),
  artifact_times: jsonDigest(artifactTimesText),
};
const payload = {
  schema: PROOF_SCHEMA,
  task_slug: taskSlug,
  plan_revision: plan.revision,
  report_finalized_at: report.finalizedAt,
  artifacts,
};
const learning = join(workspace, '.superclarity', 'learning');
const keyFile = join(learning, '.source-verification-key');
mkdirSync(learning, { recursive: true, mode: 0o700 });
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'),
  { encoding: 'utf8', flag: 'wx', flush: true, mode: 0o600 });
payload.signature = `hmac-sha256:${createHmac('sha256', readFileSync(keyFile, 'utf8').trim())
  .update(canonical(payload)).digest('hex')}`;
writeFileSync(join(task, 'delivery-proof.json'), JSON.stringify(payload, null, 2),
  { encoding: 'utf8', flag: 'wx', flush: true });
process.stdout.write(`${JSON.stringify(payload)}\n`);
