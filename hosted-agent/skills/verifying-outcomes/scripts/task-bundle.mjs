import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  deriveState, deliveryReady, effectivePlan, parseBrief, parseCapabilities, parseDeliveryManifest,
  parseLedger, parsePlan, parseProfile, parseRecovery, parseReport, parseReportSeal,
  MANIFEST_ARTIFACTS,
} from './lifecycle.mjs';

/**
 * Read one task bundle from disk and derive its state from the bytes that are
 * there now.
 *
 * The derivation works on parsed objects, which is what makes it testable �?and
 * also what let a manifest be believed without anyone checking that it still
 * describes these files. Digests and the keyed signature can only be computed
 * where the files and the project key are, so they are computed here, once, and
 * handed to the derivation as inputs it refuses to proceed without.
 */

export const CANONICAL = (value) => (Array.isArray(value) ? `[${value.map(CANONICAL).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${CANONICAL(value[key])}`).join(',')}}`
    : JSON.stringify(value));

const digestOf = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** A task directory may not be a link out of the workspace it claims to be in. */
export function taskDirectory(workspace, taskSlug) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(taskSlug ?? '')) throw new Error('invalid task slug');
  const root = realpathSync(resolve(workspace));
  const task = join(root, '.superclarity', taskSlug);
  if (!existsSync(task)) throw new Error(`no task bundle at ${task}`);
  const real = realpathSync(task);
  if (real !== task) throw new Error('task directory is a link; refusing to read outside the workspace');
  // Every file the manifest signs, plus the manifest itself: a shared inode is a
  // file two bundles can change, and sealing one would speak for both.
  for (const name of ['profile.md', 'brief.md', 'capabilities.md', 'plan.md', 'ledger.jsonl',
    'report.md', 'delivery-manifest.json']) {
    const file = join(task, name);
    if (existsSync(file) && (statSync(file, { throwIfNoEntry: false })?.nlink ?? 1) > 1) {
      throw new Error(`${name} is a hard link; refusing to seal a shared file`);
    }
  }
  return { root, task };
}

export function projectKey(root) {
  const file = join(root, '.superclarity', 'learning', '.source-verification-key');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
}

/**
 * Recompute the manifest exactly as the writer built it. The signature covers
 * every field except itself, so a manifest whose recomputation differs in any
 * byte �?including the task slug it was sealed under �?fails here.
 */
export function manifestSignatureMatches(manifest, digests, secret) {
  if (!manifest?.valid || !secret) return false;
  const payload = {
    schema: 'delivery-manifest/1',
    task_slug: manifest.slug,
    plan_revision: manifest.planRevision,
    report_finalized_at: manifest.reportFinalizedAt,
    sealed_at: manifest.sealedAt,
    artifacts: Object.fromEntries(MANIFEST_ARTIFACTS.map((name) => [name, manifest.artifacts[name]])),
  };
  const expected = createHmac('sha256', secret).update(CANONICAL(payload)).digest('hex');
  if (manifest.signature !== `hmac-sha256:${expected}`) return false;
  return MANIFEST_ARTIFACTS.every((name) => (digests[name] ?? 'none') === manifest.artifacts[name]);
}

export function loadTaskBundle(workspace, taskSlug) {
  const { root, task } = taskDirectory(workspace, taskSlug);
  const read = (name) => readFileSync(join(task, name), 'utf8');
  const present = (name) => existsSync(join(task, name));
  const optional = (name) => (present(name) ? read(name) : null);

  const briefText = optional('brief.md');
  const brief = briefText === null ? null : parseBrief(briefText);
  const profileText = optional('profile.md');
  const capabilitiesText = optional('capabilities.md');
  const planText = optional('plan.md');
  const reportText = optional('report.md');
  const ledgerText = optional('ledger.jsonl');
  const manifestText = optional('delivery-manifest.json');

  const digests = Object.fromEntries(MANIFEST_ARTIFACTS.map((name) => [name, ({
    profile: profileText, brief: briefText, capabilities: capabilitiesText,
    plan: planText, ledger: ledgerText, report: reportText,
  })[name] === null ? 'none' : digestOf(({
    profile: profileText, brief: briefText, capabilities: capabilitiesText,
    plan: planText, ledger: ledgerText, report: reportText,
  })[name])]));

  const deliveryManifest = manifestText === null ? null : parseDeliveryManifest(manifestText);
  // Schema 2 kept chronology and observations in their own files. A bundle that
  // started under that schema finishes under it, so they are still read - but a
  // file that cannot be read, or one belonging to the schema this bundle is not,
  // is recorded rather than quietly ignored. This is the reader the router uses
  // to decide what to do next, so it reports a state instead of throwing.
  const blockedInputs = [];
  const json = (name) => {
    if (!present(name)) return null;
    try { return JSON.parse(read(name)); } catch { blockedInputs.push(name); return null; }
  };
  if (ledgerText !== null) {
    for (const name of ['journal.md', 'recovery.md', 'observations.json', 'artifact-times.json',
      'report.seal.md', 'delivery-proof.json']) if (present(name)) blockedInputs.push(name);
  }
  const artifactCreatedAt = ledgerText === null ? json('artifact-times.json') : null;
  const observedEvidence = ledgerText === null ? json('observations.json') : null;
  if (ledgerText === null && present('observations.json')
      && !Array.isArray(observedEvidence?.observations)) blockedInputs.push('observations.json');
  const bundle = {
    environment: { current: true },
    brief,
    profile: profileText === null ? null
      : (brief ? parseProfile(profileText, brief.profile, brief.profileSource)
        : { type: 'profile', slug: '', source: '', digest: '', dimensions: [], valid: false }),
    capabilities: capabilitiesText === null ? null : parseCapabilities(capabilitiesText),
    plan: planText === null ? null : parsePlan(planText),
    report: reportText === null ? null : parseReport(reportText),
    ledger: ledgerText === null ? null : parseLedger(ledgerText),
    reportSeal: present('report.seal.md') && ledgerText === null
      ? parseReportSeal(read('report.seal.md')) : null,
    recovery: present('recovery.md') && ledgerText === null ? parseRecovery(read('recovery.md')) : null,
    artifactCreatedAt,
    observedEvidence,
    blockedInputs,
    deliveryManifest,
    bundleDigests: digests,
    manifestSignatureVerified: deliveryManifest
      ? manifestSignatureMatches(deliveryManifest, digests, projectKey(root)) : false,
  };
  return {
    root, task, digests, bundle,
    state: deriveState(bundle),
    ready: deliveryReady(bundle),
    plan: effectivePlan(bundle),
  };
}
