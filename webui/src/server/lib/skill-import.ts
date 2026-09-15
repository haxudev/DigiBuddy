/**
 * Onboarding skills into the registry.
 *
 * Three doors lead here -- an upload, a URL import and a dry-run preview -- and
 * they must agree, so the work of turning bytes into registry entries lives in
 * one place. Fetching from a URL is only a way to obtain bytes: the registry
 * still stores the archive content-addressed, and the runtime still reads it
 * from the store and verifies the digest. The network is never in the trust path.
 */

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { AdminAuthError, type AdminPrincipal } from "./admin-auth.ts";
import {
  ConfigConflictError,
  ConfigValidationError,
  SKILLS_DOCUMENT,
  normaliseSkills,
  type ConfigStore,
  type DeployedSkill,
} from "./admin-config.ts";
import {
  MAX_BUNDLE_BYTES,
  SkillBundleError,
  bundlePath,
  explodeBundle,
  type ExplodedBundle,
  type ExplodedCapability,
} from "./skill-bundle.ts";

export function failure(error: unknown): Response {
  if (error instanceof AdminAuthError) {
    return Response.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof ConfigConflictError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof SkillBundleError || error instanceof ConfigValidationError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  console.error("admin skills request failed", error);
  return Response.json({ error: "The skill registry is unavailable." }, { status: 500 });
}

export function audit(principal: AdminPrincipal, action: string, skill: string): void {
  // Deploying a skill changes what every assembled agent can do, so who did
  // what must be recoverable from the logs.
  console.info(
    `admin skill ${action} name=${skill} by=${principal.id || principal.name}`,
  );
}

/** Pull the archive out of a multipart upload. */
export async function bundleFromForm(
  request: Request,
): Promise<{ payload: Buffer; fileName: string; form: FormData }> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ConfigValidationError("Upload the bundle as multipart/form-data.");
  }
  const file = form.get("bundle");
  if (!(file instanceof File)) {
    throw new ConfigValidationError("Attach the skill bundle as `bundle`.");
  }
  if (file.size > MAX_BUNDLE_BYTES) {
    throw new SkillBundleError(
      `A bundle may be at most ${MAX_BUNDLE_BYTES / (1024 * 1024)} MB.`,
    );
  }
  return { payload: Buffer.from(await file.arrayBuffer()), fileName: file.name, form };
}

export async function writeRegistry(
  store: ConfigStore,
  skills: DeployedSkill[],
  expectedRevision?: string,
): Promise<DeployedSkill[]> {
  const document = normaliseSkills({ skills });
  await store.write(SKILLS_DOCUMENT, document, expectedRevision);
  return document.skills;
}

/** Read the registry together with the revision a later write must expect. */
export async function readRegistryVersioned(
  store: ConfigStore,
): Promise<{ skills: DeployedSkill[]; revision: string }> {
  const { document, revision } = await store.readVersioned(SKILLS_DOCUMENT);
  return { skills: normaliseSkills(document).skills, revision };
}

/**
 * Hosts a skill archive may be fetched from. Empty means URL import is off:
 * an unrestricted fetcher inside the console is a server-side request forgery
 * primitive, so it has to be switched on deliberately.
 */
export function importAllowlist(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  return (environment.SKILL_IMPORT_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/** At most this many redirects, each re-checked against the allowlist. */
const MAX_REDIRECTS = 5;

const PRIVATE_IPV4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_IPV4.some((pattern) => pattern.test(address));
  if (family !== 6) return true;
  const normalised = address.toLowerCase();
  if (normalised === "::1" || normalised === "::") return true;
  if (/^f[cd]/.test(normalised) || normalised.startsWith("fe80")) return true;
  // IPv4-mapped addresses reach the same networks as their IPv4 form.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalised);
  return mapped ? isPrivateAddress(mapped[1]) : false;
}

async function assertPublicHost(url: URL, allowed: string[]): Promise<void> {
  if (url.protocol !== "https:") {
    throw new ConfigValidationError("Skill archives may only be imported over HTTPS.");
  }
  const host = url.hostname.toLowerCase();
  if (!allowed.includes(host)) {
    throw new ConfigValidationError(
      `${host} is not an allowed skill archive host. Allowed: ${allowed.join(", ")}`,
    );
  }
  // Resolve before fetching so a host that points at the cluster's own network
  // is refused rather than reached.
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => {
        throw new ConfigValidationError(`${host} could not be resolved.`);
      });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new ConfigValidationError(`${host} resolves to a non-public address.`);
  }
}

export type FetchedArchive = { payload: Buffer; fileName: string; url: string };

/** Download a skill archive, refusing anything off the allowlist at every hop. */
export async function fetchArchive(
  source: string,
  options: { allowed?: string[]; fetcher?: typeof fetch } = {},
): Promise<FetchedArchive> {
  const allowed = options.allowed ?? importAllowlist();
  if (allowed.length === 0) {
    throw new ConfigValidationError(
      "Importing from a URL is disabled. Set SKILL_IMPORT_ALLOWED_HOSTS to enable it.",
    );
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new ConfigValidationError("The archive URL is not a valid URL.");
  }

  const fetcher = options.fetcher ?? fetch;
  let response: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(url, allowed);
    const hopResponse = await fetcher(url, {
      redirect: "manual",
      headers: { accept: "application/zip, application/octet-stream" },
    }).catch(() => {
      throw new ConfigValidationError(`Could not reach ${url.hostname}.`);
    });

    const location = hopResponse.headers.get("location");
    if (hopResponse.status >= 300 && hopResponse.status < 400 && location) {
      try {
        url = new URL(location, url);
      } catch {
        throw new ConfigValidationError("The archive URL redirected somewhere invalid.");
      }
      continue;
    }
    response = hopResponse;
    break;
  }
  if (!response) {
    throw new ConfigValidationError("The archive URL redirected too many times.");
  }
  if (!response.ok) {
    throw new ConfigValidationError(
      `The archive URL returned HTTP ${response.status}.`,
    );
  }

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BUNDLE_BYTES) {
    throw new SkillBundleError(
      `A bundle may be at most ${MAX_BUNDLE_BYTES / (1024 * 1024)} MB.`,
    );
  }
  const payload = Buffer.from(await response.arrayBuffer());
  if (payload.length > MAX_BUNDLE_BYTES) {
    throw new SkillBundleError(
      `A bundle may be at most ${MAX_BUNDLE_BYTES / (1024 * 1024)} MB.`,
    );
  }

  // GitHub names its archives after the ref, which is a poor skill name, but it
  // is only a fallback for a flat archive that names itself no other way.
  const fileName = decodeURIComponent(url.pathname.split("/").pop() || "archive.zip");
  return { payload, fileName, url: url.toString() };
}

export type SkillPreview = {
  name: string;
  kind: ExplodedCapability["kind"];
  description: string;
  size: number;
  sha256: string;
  entries: string[];
  /** How an executable capability would be run, so it can be judged. */
  declaration: Record<string, unknown> | null;
};

export type BundlePreview = {
  layout: ExplodedBundle["layout"];
  notes: string[];
  /** The exact archive this listing describes. */
  archive_sha256: string;
  skills: SkillPreview[];
};

/**
 * What an administrator approved, as bytes rather than as a description.
 *
 * Preview and deployment are separate requests, and a URL import fetches the
 * archive twice, so without this an archive could change between the listing
 * someone read and the bytes that were installed. It matters more now that a
 * pack can carry code that runs at Codex start.
 */
export function archiveDigest(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

export function previewBundle(payload: Buffer, fileName: string): BundlePreview {
  const exploded = explodeBundle(payload, fileName);
  return {
    layout: exploded.layout,
    notes: exploded.notes,
    archive_sha256: archiveDigest(payload),
    skills: exploded.capabilities.map(
      ({ name, kind, description, size, sha256, entries, mcp, tool }) => ({
        name,
        kind,
        description,
        size,
        sha256,
        entries,
        declaration: mcp ?? tool ?? null,
      }),
    ),
  };
}

/** Refuse bytes that are not the ones the preview described. */
export function assertPreviewed(payload: Buffer, expected: string | undefined): void {
  if (!expected) return;
  const actual = archiveDigest(payload);
  if (actual !== expected) {
    throw new ConfigValidationError(
      "The archive changed since it was previewed. Preview it again before deploying.",
    );
  }
}

/** Bundles are content-addressed, so the version is only a human-readable label. */
function nextVersion(previous: string | undefined): string {
  const number = Number(previous);
  return Number.isFinite(number) && number > 0 ? String(number + 1) : "1";
}

export async function readRegistry(store: ConfigStore): Promise<DeployedSkill[]> {
  return normaliseSkills(await store.read(SKILLS_DOCUMENT)).skills;
}

export type DeployOptions = {
  /** Applied only when the archive yields exactly one skill. */
  description?: string;
  version?: string;
  by: string;
  source?: string;
  /** The digest a preview reported. Deployment refuses anything else. */
  previewed?: string;
};

export type DeployResult = {
  deployed: DeployedSkill[];
  skills: DeployedSkill[];
  layout: ExplodedBundle["layout"];
  notes: string[];
};

/**
 * Deploy every skill an archive yields, replacing earlier versions of each.
 *
 * Bundles are written before the registry names them, or the runtime would
 * briefly see an entry it cannot fetch.
 */
export async function deployBundle(
  store: ConfigStore,
  payload: Buffer,
  fileName: string,
  options: DeployOptions,
): Promise<DeployResult> {
  assertPreviewed(payload, options.previewed);
  const exploded = explodeBundle(payload, fileName);
  const { document: currentDocument, revision } = await store.readVersioned(
    SKILLS_DOCUMENT,
  );
  const current = normaliseSkills(currentDocument).skills;
  const single = exploded.skills.length === 1;

  const registry = new Map(current.map((skill) => [skill.name, skill]));
  const deployed: DeployedSkill[] = [];

  for (const skill of exploded.capabilities) {
    const previous = registry.get(skill.name);
    const executable = skill.kind !== "skill";
    const entry: DeployedSkill = {
      name: skill.name,
      kind: skill.kind,
      version: (single && options.version) || nextVersion(previous?.version),
      description:
        (single && options.description) ||
        skill.description ||
        previous?.description ||
        "",
      bundle: bundlePath(skill.name, skill.sha256),
      sha256: skill.sha256,
      size: skill.size,
      // Executable code deploys inactive whatever it replaces. Inheriting the
      // previous flag would let new bytes run under an approval given for
      // different ones.
      enabled: executable ? false : (previous?.enabled ?? true),
      approved_sha256: "",
      approved_at: "",
      approved_by: "",
      declaration: skill.mcp
        ? { ...skill.mcp }
        : skill.tool
          ? { ...skill.tool }
          : {},
      uploaded_at: new Date().toISOString(),
      uploaded_by: options.by,
      source: options.source ?? "",
    };
    await store.writeBundle(entry.bundle, skill.payload);
    registry.set(entry.name, entry);
    deployed.push(entry);
  }

  // The write is conditional, so a concurrent deploy or approval is reported
  // rather than silently overwritten.
  const document = normaliseSkills({ skills: [...registry.values()] });
  await store.write(SKILLS_DOCUMENT, document, revision);

  // A superseded bundle is deliberately *not* deleted here. It is the only copy
  // of the previous known-good bytes, and removing it inside the transaction
  // that replaces it leaves nothing to roll back to.

  return {
    deployed,
    skills: document.skills,
    layout: exploded.layout,
    notes: exploded.notes,
  };
}
