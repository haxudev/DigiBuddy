/**
 * Admin-managed runtime configuration.
 *
 * The hosted agent is stateless and its payload is read-only, so anything an
 * administrator changes at runtime lives in a shared store that both sides
 * read. This module owns the schema for those documents and mirrors the
 * Python implementation in `hosted-agent/codex_adapter/config_store.py`.
 */

import { SKILL_NAME, bundlePath } from "./skill-bundle.ts";

export const MODELS_DOCUMENT = "models.json";
export const MCP_DOCUMENT = "mcp.json";
export const PROFILES_DOCUMENT = "profiles.json";
export const CATALOGUE_DOCUMENT = "catalogue.json";
export const SKILLS_DOCUMENT = "skills.json";

export const DOCUMENTS = [
  MODELS_DOCUMENT,
  MCP_DOCUMENT,
  PROFILES_DOCUMENT,
  CATALOGUE_DOCUMENT,
  SKILLS_DOCUMENT,
] as const;

export type DocumentName = (typeof DOCUMENTS)[number];

/** Documents an administrator may write. The catalogue is published by the runtime. */
export const WRITABLE_DOCUMENTS: DocumentName[] = [
  MODELS_DOCUMENT,
  MCP_DOCUMENT,
  PROFILES_DOCUMENT,
  // skills.json is written atomically by /api/admin/skills.
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
};

export type McpServer = {
  url: string;
  enabled: boolean;
  bearer_token_env_var: string;
  description: string;
};

export type McpDocument = { servers: Record<string, McpServer> };

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

export type ProfilesDocument = { profiles: ProfileDocument[] };

export type DeployedSkill = {
  name: string;
  version: string;
  description: string;
  /** `bundles/<name>/<sha256>.zip` — content-addressed, so it never collides. */
  bundle: string;
  sha256: string;
  size: number;
  enabled: boolean;
  uploaded_at: string;
  uploaded_by: string;
  /** Where the archive came from, when it was imported from a URL. */
  source: string;
};

export type SkillsDocument = { skills: DeployedSkill[] };

export type Catalogue = {
  skills: string[];
  tools: string[];
  mcp_servers: string[];
};

export class ConfigValidationError extends Error {}

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
  return document;
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
    if (!url) {
      throw new ConfigValidationError(`MCP server ${key} needs a URL.`);
    }
    assertHttps(url, `MCP server ${key} URL`);
    normalised[key] = {
      url,
      enabled: server.enabled !== false,
      bearer_token_env_var: text(server.bearer_token_env_var),
      description: text(server.description),
    };
  }
  return { servers: normalised };
}

export function normaliseProfiles(input: unknown): ProfilesDocument {
  const entries = record(input).profiles;
  if (!Array.isArray(entries)) return { profiles: [] };

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
  return { profiles };
}

export function normaliseSkills(input: unknown): SkillsDocument {
  const entries = record(input).skills;
  if (!Array.isArray(entries)) return { skills: [] };

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
    skills.push({
      name,
      version: text(raw.version) || "1",
      description: text(raw.description),
      // Always derived, never taken from the request, so a crafted registry
      // cannot point the runtime at another blob in the container.
      bundle: bundlePath(name, sha256),
      sha256,
      size: typeof raw.size === "number" && raw.size > 0 ? raw.size : 0,
      enabled: raw.enabled !== false,
      uploaded_at: text(raw.uploaded_at),
      uploaded_by: text(raw.uploaded_by),
      source: text(raw.source),
    });
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return { skills };
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
  write(name: DocumentName, document: JsonDocument): Promise<void>;
  /** Skill bundles share the container with the documents, under `bundles/`. */
  writeBundle(path: string, payload: Buffer): Promise<void>;
  deleteBundle(path: string): Promise<void>;
  /** Generated deliverables are immutable blobs below the reserved prefix. */
  readArtifact(id: string, filename: string): Promise<Buffer | null>;
}

const BUNDLE_PATH = /^bundles\/[a-z0-9]+(?:-[a-z0-9]+)*\/[0-9a-f]{64}\.zip$/;
const ARTIFACT_ID = /^[0-9a-f]{32}$/;
const UNSAFE_ARTIFACT_NAME = /[\u0000-\u001f\u007f<>:"/\\|?*]/u;

/** Only content-addressed bundle paths may be written; nothing else. */
function assertBundlePath(path: string): string {
  if (!BUNDLE_PATH.test(path)) {
    throw new ConfigValidationError(`Not a skill bundle path: ${path}`);
  }
  return path;
}

export function artifactStoragePath(id: string, filename: string): string {
  if (!ARTIFACT_ID.test(id)) {
    throw new ConfigValidationError("Invalid artifact id.");
  }
  if (
    !filename ||
    filename.length > 180 ||
    filename !== filename.replace(/^[ .]+|[ .]+$/gu, "") ||
    UNSAFE_ARTIFACT_NAME.test(filename)
  ) {
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
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
      const raw = await readFile(join(this.directory, assertDocumentName(name)), "utf-8");
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as JsonDocument)
        : null;
    } catch {
      return null;
    }
  }

  async write(name: DocumentName, document: JsonDocument): Promise<void> {
    const { mkdir, writeFile, rename } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, assertDocumentName(name));
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(document, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await rename(temporary, target);
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
    const blob = (await this.container()).getBlockBlobClient(
      assertDocumentName(name),
    );
    try {
      const buffer = await blob.downloadToBuffer();
      const parsed: unknown = JSON.parse(buffer.toString("utf-8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as JsonDocument)
        : null;
    } catch {
      return null;
    }
  }

  async write(name: DocumentName, document: JsonDocument): Promise<void> {
    const container = await this.container();
    await container.createIfNotExists();
    const body = JSON.stringify(document, null, 2);
    await container
      .getBlockBlobClient(assertDocumentName(name))
      .upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: { blobContentType: "application/json" },
      });
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
