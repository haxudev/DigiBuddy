/**
 * Admin-managed runtime configuration.
 *
 * The hosted agent is stateless and its payload is read-only, so anything an
 * administrator changes at runtime lives in a shared store that both sides
 * read. This module owns the schema for those documents and mirrors the
 * Python implementation in `hosted-agent/codex_adapter/config_store.py`.
 */

import { SKILL_NAME, bundlePath } from "./skill-bundle.ts";
import {
  MANAGED_ARTIFACT_ID,
  isManagedArtifactName,
} from "./artifact-reference.ts";

export const MODELS_DOCUMENT = "models.json";
export const MCP_DOCUMENT = "mcp.json";
export const PROFILES_DOCUMENT = "profiles.json";
export const CATALOGUE_DOCUMENT = "catalogue.json";
export const SKILLS_DOCUMENT = "skills.json";
export const CREDENTIALS_DOCUMENT = "credentials.json";

export const DOCUMENTS = [
  MODELS_DOCUMENT,
  MCP_DOCUMENT,
  PROFILES_DOCUMENT,
  CATALOGUE_DOCUMENT,
  SKILLS_DOCUMENT,
  CREDENTIALS_DOCUMENT,
] as const;

export type DocumentName = (typeof DOCUMENTS)[number];

/**
 * The document shapes this build writes and understands.
 *
 * A document written by a newer console is refused rather than reinterpreted:
 * the fields an older build would silently drop are exactly the ones a newer
 * one added to restrict something.
 */
export const SCHEMA_VERSION = 1;
export const SCHEMA_FIELD = "schema_version";

/** Identifies the stored bytes, so a write can refuse to clobber a newer save. */
export type DocumentRevision = string;

/** No document is stored yet; only a create may use this as its expectation. */
export const ABSENT_REVISION: DocumentRevision = "absent";

/** Documents an administrator may write. The catalogue is published by the runtime. */
export const WRITABLE_DOCUMENTS: DocumentName[] = [
  MODELS_DOCUMENT,
  MCP_DOCUMENT,
  PROFILES_DOCUMENT,
  // skills.json is written atomically by /api/admin/skills.
  // credentials.json is write-only through /api/admin/credentials.
];

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;

export type JsonDocument = Record<string, unknown>;

type Environment = Record<string, string | undefined>;

export type ModelsDocument = {
  model: string;
  endpoint: string;
  provider: string;
  reasoning_effort: string;
  /** Present only when the administrator is rotating it; never read back out. */
  api_key?: string;
  schema_version?: number;
};

export type McpServer = {
  /** Set for a remote server. Mutually exclusive with `command`. */
  url: string;
  /**
   * Set for a local stdio server. The runtime has always supported these; the
   * console exposes them so an operator can register one without a rebuild.
   */
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  bearer_token_env_var: string;
  description: string;
};

export type McpDocument = { servers: Record<string, McpServer>; schema_version?: number };

export type ProfileDocument = {
  name: string;
  display_name: string;
  description: string;
  persona: string;
  /** `null` means "every packaged capability"; an array restricts to those entries. */
  skills: string[] | null;
  tools: string[] | null;
  mcp_servers: string[] | null;
  model: string;
  reasoning_effort: string;
};

export type ProfilesDocument = { profiles: ProfileDocument[]; schema_version?: number };

/**
 * A capability an administrator deployed.
 *
 * `kind` decides what the runtime does with the bytes. A skill is markdown the
 * model reads, so it is live as soon as it is enabled. A tool or an MCP server
 * is code, so it also needs `approved_sha256` to match its own digest before
 * the runtime will run it -- and any redeploy that changes the bytes drops that
 * approval.
 */
export type DeployedSkill = {
  name: string;
  kind: "skill" | "tool" | "mcp_server";
  version: string;
  description: string;
  /** `bundles/<name>/<sha256>.zip` — content-addressed, so it never collides. */
  bundle: string;
  sha256: string;
  size: number;
  enabled: boolean;
  /** The exact bytes an administrator approved to execute, if any. */
  approved_sha256: string;
  approved_at: string;
  approved_by: string;
  /** How to run it, for the kinds that run. Empty for a skill. */
  declaration: Record<string, unknown>;
  uploaded_at: string;
  uploaded_by: string;
  /** Where the archive came from, when it was imported from a URL. */
  source: string;
};

export const CAPABILITY_KINDS = ["skill", "tool", "mcp_server"] as const;

/** Executable kinds need a matching approval before the runtime will run them. */
export function isExecutable(entry: Pick<DeployedSkill, "kind">): boolean {
  return entry.kind === "tool" || entry.kind === "mcp_server";
}

/**
 * Whether the runtime should act on this entry.
 *
 * A skill needs only to be enabled. Executable code additionally needs an
 * approval that names the bytes now in the store, so replacing an approved
 * artifact with different bytes deactivates it rather than inheriting consent.
 */
export function isActive(entry: DeployedSkill): boolean {
  if (!entry.enabled) return false;
  if (!isExecutable(entry)) return true;
  return Boolean(entry.approved_sha256) && entry.approved_sha256 === entry.sha256;
}

export type SkillsDocument = { skills: DeployedSkill[]; schema_version?: number };

export type Catalogue = {
  skills: string[];
  tools: string[];
  mcp_servers: string[];
};

export class ConfigValidationError extends Error {}

/**
 * Another writer changed the document between this caller's read and its write.
 *
 * The profiles document and the capability registry are both read-modify-write
 * from two independent surfaces, so overwriting blindly would silently discard
 * whichever administrator saved second.
 */
export class ConfigConflictError extends Error {}

/** Refuse a document this build cannot read, rather than reinterpreting it. */
export function assertReadableSchema(document: unknown): void {
  const version = record(document)[SCHEMA_FIELD];
  if (version === undefined || version === null) return; // legacy, still readable
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new ConfigValidationError(
      `${SCHEMA_FIELD} must be an integer, got ${JSON.stringify(version)}.`,
    );
  }
  if (version > SCHEMA_VERSION) {
    throw new ConfigValidationError(
      `This build reads ${SCHEMA_FIELD} up to ${SCHEMA_VERSION}, but the stored document declares ${version}.`,
    );
  }
}

function versioned<T extends JsonDocument>(document: T): T {
  return { [SCHEMA_FIELD]: SCHEMA_VERSION, ...document };
}


function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `undefined` (absent) keeps everything; an array restricts to those entries. */
function names(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((item) => text(item))
    .filter((item, index, all) => item && all.indexOf(item) === index);
}

function reasoningEffort(value: unknown): string {
  const effort = text(value).toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(effort) ? effort : "";
}

export function assertDocumentName(name: string): DocumentName {
  if (!(DOCUMENTS as readonly string[]).includes(name)) {
    throw new ConfigValidationError(`Unknown configuration document: ${name}`);
  }
  return name as DocumentName;
}

export function assertWritableDocument(name: string): DocumentName {
  const document = assertDocumentName(name);
  if (!WRITABLE_DOCUMENTS.includes(document)) {
    throw new ConfigValidationError(`${document} is published by the runtime.`);
  }
  return document;
}

function assertHttps(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigValidationError(`${label} is not a valid URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new ConfigValidationError(`${label} must use HTTPS.`);
  }
}

export function normaliseModels(input: unknown): ModelsDocument {
  const raw = record(input);
  const endpoint = text(raw.endpoint).replace(/\/+$/, "");
  if (endpoint) assertHttps(endpoint, "Model endpoint");

  const document: ModelsDocument = {
    model: text(raw.model),
    endpoint,
    provider: text(raw.provider),
    reasoning_effort: reasoningEffort(raw.reasoning_effort),
  };
  const apiKey = text(raw.api_key);
  if (apiKey) document.api_key = apiKey;
  return versioned(document);
}

export function normaliseMcp(input: unknown): McpDocument {
  const servers = record(record(input).servers);
  const normalised: Record<string, McpServer> = {};
  for (const [name, value] of Object.entries(servers)) {
    const key = name.trim();
    if (!key || !/^[A-Za-z0-9._-]+$/.test(key)) {
      throw new ConfigValidationError(
        `MCP server names may only contain letters, digits, dot, dash and underscore: ${name}`,
      );
    }
    const server = record(value);
    const url = text(server.url);
    const command = text(server.command);
    if (!url && !command) {
      throw new ConfigValidationError(
        `MCP server ${key} needs either a URL or a command.`,
      );
    }
    if (url && command) {
      throw new ConfigValidationError(
        `MCP server ${key} must be either remote or local, not both.`,
      );
    }
    if (url) assertHttps(url, `MCP server ${key} URL`);
    if (command && (command.includes(" ") || command.includes("/"))) {
      // A path or a shell string here would let an operator register
      // `/bin/sh -c ...` as an MCP server. Arguments go in `args`.
      throw new ConfigValidationError(
        `MCP server ${key} command must be a bare executable name; put arguments in args.`,
      );
    }
    normalised[key] = {
      url,
      command,
      args: Array.isArray(server.args) ? server.args.map((item) => String(item)) : [],
      env:
        server.env && typeof server.env === "object" && !Array.isArray(server.env)
          ? Object.fromEntries(
              Object.entries(server.env as Record<string, unknown>).map(
                ([name, entry]) => [name, String(entry)],
              ),
            )
          : {},
      enabled: server.enabled !== false,
      bearer_token_env_var: text(server.bearer_token_env_var),
      description: text(server.description),
    };
  }
  return versioned({ servers: normalised });
}

export function normaliseProfiles(input: unknown): ProfilesDocument {
  const entries = record(input).profiles;
  if (!Array.isArray(entries)) return versioned({ profiles: [] });

  const profiles: ProfileDocument[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const raw = record(entry);
    const name = text(raw.name);
    if (!name) {
      throw new ConfigValidationError("Every profile needs a name.");
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new ConfigValidationError(
        `Profile names may only contain lowercase letters, digits and dashes: ${name}`,
      );
    }
    if (seen.has(name)) {
      throw new ConfigValidationError(`Duplicate profile name: ${name}`);
    }
    seen.add(name);
    profiles.push({
      name,
      display_name: text(raw.display_name) || name,
      description: text(raw.description),
      persona: text(raw.persona),
      skills: names(raw.skills),
      tools: names(raw.tools),
      mcp_servers: names(raw.mcp_servers),
      model: text(raw.model),
      reasoning_effort: reasoningEffort(raw.reasoning_effort),
    });
  }
  return versioned({ profiles });
}

export function normaliseSkills(input: unknown): SkillsDocument {
  const entries = record(input).skills;
  if (!Array.isArray(entries)) return versioned({ skills: [] });

  const skills: DeployedSkill[] = [];
  const seen = new Set<string>();
  for (const item of entries) {
    const raw = record(item);
    const name = text(raw.name);
    const sha256 = text(raw.sha256).toLowerCase();
    if (!SKILL_NAME.test(name)) {
      throw new ConfigValidationError(
        `Skill names may only contain lowercase letters, digits and dashes: ${name}`,
      );
    }
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new ConfigValidationError(`Skill ${name} has no content hash.`);
    }
    if (seen.has(name)) {
      throw new ConfigValidationError(`Duplicate skill name: ${name}`);
    }
    seen.add(name);
    const kindValue = text(raw.kind) || "skill";
    if (!(CAPABILITY_KINDS as readonly string[]).includes(kindValue)) {
      throw new ConfigValidationError(`Unknown capability kind for ${name}: ${kindValue}`);
    }
    const kind = kindValue as DeployedSkill["kind"];
    const approved = text(raw.approved_sha256).toLowerCase();
    skills.push({
      name,
      kind,
      version: text(raw.version) || "1",
      description: text(raw.description),
      // Always derived, never taken from the request, so a crafted registry
      // cannot point the runtime at another blob in the container.
      bundle: bundlePath(name, sha256),
      sha256,
      size: typeof raw.size === "number" && raw.size > 0 ? raw.size : 0,
      enabled: raw.enabled !== false,
      // An approval only means anything if it names bytes; one that does not
      // match the stored digest is stale and is dropped rather than carried.
      approved_sha256: /^[0-9a-f]{64}$/.test(approved) && approved === sha256 ? approved : "",
      approved_at: text(raw.approved_at),
      approved_by: text(raw.approved_by),
      declaration:
        raw.declaration && typeof raw.declaration === "object" && !Array.isArray(raw.declaration)
          ? (raw.declaration as Record<string, unknown>)
          : {},
      uploaded_at: text(raw.uploaded_at),
      uploaded_by: text(raw.uploaded_by),
      source: text(raw.source),
    });
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return versioned({ skills });
}

export function normaliseDocument(
  name: DocumentName,
  input: unknown,
): JsonDocument {
  if (name === MODELS_DOCUMENT) return normaliseModels(input);
  if (name === MCP_DOCUMENT) return normaliseMcp(input);
  if (name === PROFILES_DOCUMENT) return normaliseProfiles(input);
  if (name === SKILLS_DOCUMENT) return normaliseSkills(input);
  throw new ConfigValidationError(`${name} is published by the runtime.`);
}

/** Strip anything an administrator should not be able to read back out. */
export function redactDocument(
  name: DocumentName,
  document: JsonDocument | null,
): JsonDocument | null {
  if (!document || name !== MODELS_DOCUMENT) return document;
  const { api_key: apiKey, ...rest } = document as ModelsDocument;
  return { ...rest, api_key_set: Boolean(text(apiKey)) };
}

/**
 * Carry the stored key forward when the administrator leaves the field blank,
 * so changing the model name does not require re-entering the secret.
 */
export function preserveSecret(
  next: ModelsDocument,
  current: JsonDocument | null,
): ModelsDocument {
  if (next.api_key) return next;
  const existing = text(record(current).api_key);
  return existing ? { ...next, api_key: existing } : next;
}

export function normaliseCatalogue(input: unknown): Catalogue {
  const raw = record(input);
  return {
    skills: names(raw.skills) ?? [],
    tools: names(raw.tools) ?? [],
    mcp_servers: names(raw.mcp_servers) ?? [],
  };
}

export interface ConfigStore {
  read(name: DocumentName): Promise<JsonDocument | null>;
  /** The document plus the revision a later conditional write must expect. */
  readVersioned(
    name: DocumentName,
  ): Promise<{ document: JsonDocument | null; revision: DocumentRevision }>;
  /**
   * Write the document and return its new revision.
   *
   * Passing `expectedRevision` makes the write conditional: it throws
   * `ConfigConflictError` when the stored document has moved since it was read.
   * Omitting it is a deliberate last-writer-wins overwrite, which is only
   * correct for a document with exactly one writer.
   */
  write(
    name: DocumentName,
    document: JsonDocument,
    expectedRevision?: DocumentRevision,
  ): Promise<DocumentRevision>;
  /** Skill bundles share the container with the documents, under `bundles/`. */
  writeBundle(path: string, payload: Buffer): Promise<void>;
  deleteBundle(path: string): Promise<void>;
  /** Generated deliverables are immutable blobs below the reserved prefix. */
  readArtifact(id: string, filename: string): Promise<Buffer | null>;
}


const BUNDLE_PATH = /^bundles\/[a-z0-9]+(?:-[a-z0-9]+)*\/[0-9a-f]{64}\.zip$/;

/**
 * A file store has no ETag, so the stored bytes are their own revision. Two
 * saves that produce identical bytes are genuinely interchangeable, so
 * colliding on content is the correct behaviour rather than a weakness.
 */
async function fileRevision(body: string): Promise<DocumentRevision> {
  const { createHash } = await import("node:crypto");
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}


/** Only content-addressed bundle paths may be written; nothing else. */
function assertBundlePath(path: string): string {
  if (!BUNDLE_PATH.test(path)) {
    throw new ConfigValidationError(`Not a skill bundle path: ${path}`);
  }
  return path;
}

export function artifactStoragePath(id: string, filename: string): string {
  if (!MANAGED_ARTIFACT_ID.test(id)) {
    throw new ConfigValidationError("Invalid artifact id.");
  }
  if (!isManagedArtifactName(filename)) {
    throw new ConfigValidationError("Invalid artifact filename.");
  }
  return `artifacts/${id}/${filename}`;
}

class FileConfigStore implements ConfigStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async read(name: DocumentName): Promise<JsonDocument | null> {
    return (await this.readVersioned(name)).document;
  }

  async readVersioned(
    name: DocumentName,
  ): Promise<{ document: JsonDocument | null; revision: DocumentRevision }> {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    let raw: string;
    try {
      raw = await readFile(join(this.directory, assertDocumentName(name)), "utf-8");
    } catch {
      return { document: null, revision: ABSENT_REVISION };
    }
    const revision = await fileRevision(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { document: null, revision };
    }
    const document =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as JsonDocument)
        : null;
    if (document) assertReadableSchema(document);
    return { document, revision };
  }

  async write(
    name: DocumentName,
    document: JsonDocument,
    expectedRevision?: DocumentRevision,
  ): Promise<DocumentRevision> {
    const { mkdir, writeFile, rename } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, assertDocumentName(name));

    if (expectedRevision !== undefined) {
      const current = await this.readVersioned(name);
      if (current.revision !== expectedRevision) {
        throw new ConfigConflictError(
          `${name} changed since it was read; reload and try again.`,
        );
      }
    }

    const body = JSON.stringify(document, null, 2);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, body, { encoding: "utf-8", mode: 0o600 });
    await rename(temporary, target);
    return fileRevision(body);
  }

  async writeBundle(path: string, payload: Buffer): Promise<void> {
    const { mkdir, writeFile, rename } = await import("node:fs/promises");
    const { dirname, join } = await import("node:path");
    const target = join(this.directory, assertBundlePath(path));
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, payload, { mode: 0o600 });
    await rename(temporary, target);
  }

  async deleteBundle(path: string): Promise<void> {
    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await rm(join(this.directory, assertBundlePath(path)), { force: true });
  }

  async readArtifact(id: string, filename: string): Promise<Buffer | null> {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const path = join(this.directory, artifactStoragePath(id, filename));
    try {
      return await readFile(path);
    } catch {
      return null;
    }
  }
}

async function streamToBuffer(
  stream: NodeJS.ReadableStream | undefined,
): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

class BlobConfigStore implements ConfigStore {
  readonly containerUri: string;

  constructor(containerUri: string) {
    this.containerUri = containerUri;
  }

  private async container() {
    const { ContainerClient } = await import("@azure/storage-blob");
    const { DefaultAzureCredential } = await import("@azure/identity");
    return new ContainerClient(this.containerUri, new DefaultAzureCredential());
  }

  async read(name: DocumentName): Promise<JsonDocument | null> {
    return (await this.readVersioned(name)).document;
  }

  async readVersioned(
    name: DocumentName,
  ): Promise<{ document: JsonDocument | null; revision: DocumentRevision }> {
    const blob = (await this.container()).getBlockBlobClient(
      assertDocumentName(name),
    );
    let buffer: Buffer;
    let revision: DocumentRevision = ABSENT_REVISION;
    try {
      const response = await blob.download();
      revision = response.etag ?? ABSENT_REVISION;
      buffer = await streamToBuffer(response.readableStreamBody);
    } catch {
      return { document: null, revision: ABSENT_REVISION };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf-8"));
    } catch {
      return { document: null, revision };
    }
    const document =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as JsonDocument)
        : null;
    if (document) assertReadableSchema(document);
    return { document, revision };
  }

  async write(
    name: DocumentName,
    document: JsonDocument,
    expectedRevision?: DocumentRevision,
  ): Promise<DocumentRevision> {
    const container = await this.container();
    await container.createIfNotExists();
    const body = JSON.stringify(document, null, 2);
    // The ETag makes this a real compare-and-swap at the storage layer, so two
    // administrators saving at once cannot silently lose one of the saves.
    const conditions =
      expectedRevision === undefined
        ? undefined
        : expectedRevision === ABSENT_REVISION
          ? { ifNoneMatch: "*" }
          : { ifMatch: expectedRevision };
    try {
      const response = await container
        .getBlockBlobClient(assertDocumentName(name))
        .upload(body, Buffer.byteLength(body), {
          blobHTTPHeaders: { blobContentType: "application/json" },
          conditions,
        });
      return response.etag ?? ABSENT_REVISION;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 412 || status === 409) {
        throw new ConfigConflictError(
          `${name} changed since it was read; reload and try again.`,
        );
      }
      throw error;
    }
  }

  async writeBundle(path: string, payload: Buffer): Promise<void> {
    const container = await this.container();
    await container.createIfNotExists();
    await container
      .getBlockBlobClient(assertBundlePath(path))
      .upload(payload, payload.byteLength, {
        blobHTTPHeaders: { blobContentType: "application/zip" },
      });
  }

  async deleteBundle(path: string): Promise<void> {
    await (await this.container())
      .getBlockBlobClient(assertBundlePath(path))
      .deleteIfExists();
  }

  async readArtifact(id: string, filename: string): Promise<Buffer | null> {
    const blob = (await this.container()).getBlockBlobClient(
      artifactStoragePath(id, filename),
    );
    try {
      return await blob.downloadToBuffer();
    } catch {
      return null;
    }
  }
}

export function buildConfigStore(
  environment: Environment = process.env,
): ConfigStore {
  const containerUri = text(environment.DIGIBUDDY_CONFIG_URI);
  if (containerUri) {
    assertHttps(containerUri, "DIGIBUDDY_CONFIG_URI");
    return new BlobConfigStore(containerUri);
  }
  const directory = text(environment.DIGIBUDDY_CONFIG_DIR);
  if (directory) return new FileConfigStore(directory);
  throw new ConfigValidationError(
    "Set DIGIBUDDY_CONFIG_URI or DIGIBUDDY_CONFIG_DIR to enable the admin console.",
  );
}
