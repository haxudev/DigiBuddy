#!/usr/bin/env node

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DELIVERY_MANIFEST_SCHEMA, MANIFEST_ARTIFACTS } from './lifecycle.mjs';
import { CANONICAL, loadTaskBundle } from './task-bundle.mjs';

/**
 * One artifact replaces the report seal and the delivery proof. The seal was
 * external so that a report could not identify its own bytes; the proof was
 * closed so that every input the `delivered` derivation read was covered. Both
 * reasons are satisfied by a single manifest that lives outside every file it
 * names and carries one digest per input — and two artifacts that must agree
 * are two artifacts that can disagree.
 *
 * An absent optional input is signed as `none` rather than omitted, so adding
 * one later invalidates the manifest exactly as removing one does.
 */

const [workspaceArg = process.cwd(), taskSlug] = process.argv.slice(2);
if (!taskSlug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(taskSlug)) {
  console.error('usage: delivery-manifest.mjs <workspace> <task-slug>'); process.exit(1);
}

const { root, task, digests, bundle, ready } = loadTaskBundle(workspaceArg, taskSlug);
// A bundle that predates the ledger seals with report-seal.mjs and
// delivery-proof.mjs. Sealing it here would write a manifest it has no ledger to
// match, and the reseal guard below would then leave it unfixable.
if (!bundle.brief?.ledgerBundle) {
  throw new Error('this bundle predates the ledger; seal it with report-seal.mjs then delivery-proof.mjs');
}
if (!ready) throw new Error('task bundle is not ready for delivery; run the verification checks first');
// The directory name is not the bundle's identity. Sealing one task's files
// under another task's slug would produce a manifest that verifies against the
// slug it was asked for rather than the work it describes.
if (bundle.brief.slug !== taskSlug) {
  throw new Error(`bundle belongs to task "${bundle.brief.slug}", not "${taskSlug}"`);
}

const payload = {
  schema: DELIVERY_MANIFEST_SCHEMA,
  task_slug: taskSlug,
  plan_revision: bundle.plan.revision,
  report_finalized_at: bundle.report.finalizedAt,
  sealed_at: new Date(Math.max(Date.now(), Date.parse(bundle.report.finalizedAt))).toISOString(),
  artifacts: Object.fromEntries(MANIFEST_ARTIFACTS.map((name) => [name, digests[name]])),
};
const learning = join(root, '.superclarity', 'learning');
const keyFile = join(learning, '.source-verification-key');
mkdirSync(learning, { recursive: true, mode: 0o700 });
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'),
  { encoding: 'utf8', flag: 'wx', flush: true, mode: 0o600 });
payload.signature = `hmac-sha256:${createHmac('sha256', readFileSync(keyFile, 'utf8').trim())
  .update(CANONICAL(payload)).digest('hex')}`;

const target = join(task, 'delivery-manifest.json');
if (existsSync(target)) throw new Error('a delivery manifest already exists; a sealed bundle is not resealed');
// Written whole and then moved into place: an interrupted write leaves a
// scratch file, never a half-written manifest that can never be replaced.
const scratch = `${target}.${process.pid}.tmp`;
try {
  writeFileSync(scratch, `${JSON.stringify(payload, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', flush: true });
  renameSync(scratch, target);
} catch (error) { rmSync(scratch, { force: true }); throw error; }
process.stdout.write(`${JSON.stringify(payload)}\n`);
