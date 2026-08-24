/**
 * Skill bundle inspection and explosion.
 *
 * The simple case is one skill in one zip: `SKILL.md` plus whatever references
 * and scripts it needs. We hash those bytes so the runtime can prove it received
 * what an administrator approved, and the runtime repeats every check when it
 * extracts, because the store is the real trust boundary.
 *
 * The interesting case is a complex source -- a repository archive holding
 * several skills, a shared Python package and scaffolding. Rather than teach the
 * runtime about that shape, the console *explodes* such an archive here into one
 * normalised, self-contained single-skill bundle per skill. Shared libraries are
 * copied into each skill and entrypoint shims are generated, so what reaches the
 * store is always the simple case and the runtime stays unchanged.
 */

import { createHash } from "node:crypto";

import {
  ZipError,
  readDirectory,
  readEntry,
  writeZip,
  type WritableEntry,
  type ZipEntry,
} from "./zip.ts";

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Mirrors the ceilings in `hosted-agent/codex_adapter/skills.py`. */
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 128 * 1024 * 1024;
export const MAX_ENTRIES = 2000;

/** A single skill may not be larger than a bundle, since it becomes one. */
const MAX_SKILL_BYTES = MAX_EXTRACTED_BYTES;
/** `SKILL.md` is prose; anything huge is not frontmatter we should parse. */
const MAX_SKILL_MD_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SKILLS_PER_BUNDLE = 64;

/** Declares how to explode a complex archive. Optional; discovery is the default. */
export const BUNDLE_MANIFEST = "digibuddy-skills.json";

export class SkillBundleError extends Error {}

export type InspectedBundle = {
  /** The skill's directory name, taken from the bundle or the file name. */
  name: string;
  sha256: string;
  size: number;
  entries: string[];
};

export type ExplodedSkill = InspectedBundle & {
  /** A normalised zip holding exactly this skill, rooted at `<name>/`. */
  payload: Buffer;
  /** Taken from the SKILL.md frontmatter when it has one. */
  description: string;
};

/**
 * What a pack may declare.
 *
 * A skill is markdown the model reads. A tool is a module it may run. An MCP
 * server is a command the runtime executes at Codex start, whether or not the
 * model asks for it -- which is why the last one is the trust escalation the
 * approval gate exists for.
 */
export type CapabilityKind = "skill" | "tool" | "mcp_server";

/** How an MCP server declared in a pack is started. Never a free-form command. */
export type McpDeclaration = {
  runtime: "python" | "node";
  /** Relative to the artifact's own root, so it cannot name a host path. */
  entrypoint: string;
  env: Record<string, string>;
};

/** How a tool declared in a pack is invoked. */
export type ToolDeclaration = { module: string; call: string };

export type ExplodedCapability = ExplodedSkill & {
  kind: CapabilityKind;
  mcp?: McpDeclaration;
  tool?: ToolDeclaration;
};

export type ExplodedBundle = {
  /** Skill artifacts only, kept for callers that predate typed capabilities. */
  skills: ExplodedSkill[];
  /** Every artifact this archive yields, whatever its kind. */
  capabilities: ExplodedCapability[];
  /** How the capabilities were found, so the console can explain what it did. */
  layout: "single" | "manifest" | "discovered";
  /** Non-fatal observations worth showing before an administrator deploys. */
  notes: string[];
};

/** The manifest shapes this build understands. */
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * Environment names a pack may not set.
 *
 * Reaching one of these would let a declaration redirect the interpreter or the
 * module path rather than configure a server, so the pack would be choosing
 * what runs instead of what the runtime runs.
 */
const RESERVED_ENV = new Set([
  "PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "HOME",
  "CODEX_HOME",
  "DIGIBUDDY_CONFIG_URI",
  "DIGIBUDDY_CONFIG_DIR",
  "DIGIBUDDY_MODEL_API_KEY",
  "OPENAI_API_KEY",
]);

/**
 * A value that looks like a credential rather than a setting.
 *
 * A pack manifest is readable by anyone who can read the archive, so a secret
 * written into one is already disclosed. Profiles bind credentials; packs
 * declare which slot they need.
 */
const SECRET_SHAPED = /^(?:sk-|ghp_|gho_|xox[baprs]-|AKIA|eyJ[A-Za-z0-9_-]{10,})/;

function fail(error: unknown): never {
  if (error instanceof ZipError) throw new SkillBundleError(error.message);
  throw error;
}

function directory(payload: Buffer): ZipEntry[] {
  let entries: ZipEntry[];
  try {
    entries = readDirectory(payload, MAX_ENTRIES);
  } catch (error) {
    fail(error);
  }

  let extracted = 0;
  for (const entry of entries) {
    if ((entry.mode & 0xf000) === 0xa000) {
      throw new SkillBundleError(`The bundle contains a symlink: ${entry.name}`);
    }
    assertSafe(entry.name);
    extracted += entry.size;
    if (extracted > MAX_EXTRACTED_BYTES) {
      throw new SkillBundleError("The bundle expands beyond the size limit.");
    }
  }
  if (entries.length === 0) throw new SkillBundleError("The bundle is empty.");
  return entries;
}

function assertSafe(name: string): void {
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").some((part) => !part || part === ".." || part === ".")
  ) {
    throw new SkillBundleError(`The bundle contains an unsafe path: ${name}`);
  }
}

function assertSkillName(name: string): string {
  if (!SKILL_NAME.test(name)) {
    throw new SkillBundleError(
      `Skill names may only contain lowercase letters, digits and dashes: ${name}`,
    );
  }
  return name;
}

/**
 * Derive the skill's name. A bundle rooted at a single directory names itself;
 * a flat bundle takes the name from the uploaded file.
 */
function bundleName(names: string[], fallback: string): string {
  const roots = new Set(names.map((name) => name.split("/")[0]));
  const name =
    roots.size === 1 && names.every((entry) => entry.includes("/"))
      ? [...roots][0]
      : fallback;
  return assertSkillName(name);
}

/** Strip the archive extension so `seo-optimizer.skill` names `seo-optimizer`. */
export function nameFromFile(fileName: string): string {
  return (fileName.split("/").pop() ?? "")
    .replace(/\.(zip|skill|tar\.gz|tgz)$/i, "")
    .trim()
    .toLowerCase();
}

export function inspectBundle(payload: Buffer, fileName: string): InspectedBundle {
  if (payload.length === 0) throw new SkillBundleError("The bundle is empty.");
  if (payload.length > MAX_BUNDLE_BYTES) {
    throw new SkillBundleError(
      `A bundle may be at most ${MAX_BUNDLE_BYTES / (1024 * 1024)} MB.`,
    );
  }

  const names = directory(payload).map((entry) => entry.name);
  const name = bundleName(names, nameFromFile(fileName));

  const prefix = names.every((entry) => entry.startsWith(`${name}/`)) ? `${name}/` : "";
  const relative = names.map((entry) => entry.slice(prefix.length));
  if (!relative.includes("SKILL.md")) {
    throw new SkillBundleError("The bundle has no SKILL.md at its root.");
  }

  return {
    name,
    sha256: createHash("sha256").update(payload).digest("hex"),
    size: payload.length,
    entries: relative.sort(),
  };
}

export function bundlePath(name: string, sha256: string): string {
  return `bundles/${name}/${sha256}.zip`;
}

// --- Frontmatter -----------------------------------------------------------

export type Frontmatter = { name: string; description: string };

/**
 * Read the `name` and `description` out of a SKILL.md YAML frontmatter block.
 *
 * Deliberately not a YAML parser: a skill's frontmatter is a handful of scalar
 * keys, and the two we care about are the ones every runtime agrees on. Anything
 * we cannot read is simply absent, never an error -- a skill without frontmatter
 * is still a valid skill.
 */
export function parseFrontmatter(markdown: string): Frontmatter {
  const empty = { name: "", description: "" };
  const text = markdown.replace(/^\uFEFF/, "");
  if (!/^---\r?\n/.test(text)) return empty;
  const end = text.search(/\r?\n---\s*(\r?\n|$)/);
  if (end < 0) return empty;

  const block = text.slice(text.indexOf("\n") + 1, end);
  const values: Record<string, string> = {};
  let key = "";
  for (const line of block.split(/\r?\n/)) {
    // Fold YAML block scalars and plain continuation lines into the open key.
    if (key && /^\s+\S/.test(line)) {
      values[key] = `${values[key]} ${line.trim()}`.trim();
      continue;
    }
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      key = "";
      continue;
    }
    key = match[1].toLowerCase();
    values[key] = match[2].trim().replace(/^["']|["']$/g, "");
    if (values[key] === "|" || values[key] === ">") values[key] = "";
  }

  return {
    name: (values.name ?? "").trim(),
    description: (values.description ?? "").trim().replace(/\s+/g, " "),
  };
}

// --- Manifest --------------------------------------------------------------

type ManifestSkill = { name: string; path: string; description: string };
type ManifestShared = { path: string; as: string; skills: string[] };
type ManifestEntrypoint = { path: string; module: string; call: string; skills: string[] };
type ManifestTool = {
  name: string;
  path: string;
  description: string;
  module: string;
  call: string;
};
type ManifestMcp = {
  name: string;
  path: string;
  description: string;
  runtime: "python" | "node";
  entrypoint: string;
  env: Record<string, string>;
};
type Manifest = {
  skills: ManifestSkill[];
  tools: ManifestTool[];
  mcpServers: ManifestMcp[];
  shared: ManifestShared[];
  entrypoints: ManifestEntrypoint[];
};

/** A tool's directory name is a Python identifier, not a kebab-case skill name. */
const TOOL_NAME = /^[a-z_][a-z0-9_]*$/;
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertToolName(name: string): string {
  if (!TOOL_NAME.test(name)) {
    throw new SkillBundleError(
      `Tool names must be lowercase Python identifiers: ${name}`,
    );
  }
  return name;
}

function assertMcpName(name: string): string {
  if (!MCP_NAME.test(name)) {
    throw new SkillBundleError(
      `MCP server names may only contain letters, digits, dot, dash and underscore: ${name}`,
    );
  }
  return name;
}

/**
 * An entrypoint is a path inside the artifact, never a command.
 *
 * Allowing a command would let a pack run `/bin/sh -c` at Codex start, which is
 * the whole trust escalation the approval gate is trying to make visible.
 */
function assertEntrypoint(value: unknown, name: string): string {
  const path = asString(value) || "main.py";
  if (path.startsWith("/") || path.includes("\\")) {
    throw new SkillBundleError(
      `The MCP server ${name} must name a path inside its own files, not ${path}.`,
    );
  }
  assertSafe(path);
  return path;
}

function assertRuntime(value: unknown, name: string): "python" | "node" {
  const runtime = asString(value) || "python";
  if (runtime !== "python" && runtime !== "node") {
    throw new SkillBundleError(
      `The MCP server ${name} must run under python or node, not ${runtime}.`,
    );
  }
  return runtime;
}

function assertDeclaredEnv(
  value: unknown,
  name: string,
): Record<string, string> {
  const raw = asRecord(value);
  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(raw)) {
    const variable = key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
      throw new SkillBundleError(
        `The MCP server ${name} declares an unusable environment name: ${key}`,
      );
    }
    if (RESERVED_ENV.has(variable)) {
      throw new SkillBundleError(
        `The MCP server ${name} may not set ${variable}; it decides what runs, not how it authenticates.`,
      );
    }
    const text = asString(entry);
    if (SECRET_SHAPED.test(text)) {
      throw new SkillBundleError(
        `The MCP server ${name} appears to embed a credential in ${variable}. Bind it to the profile instead.`,
      );
    }
    environment[variable] = text;
  }
  return environment;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A relative path inside the archive, with no trailing slash. */
function manifestPath(value: unknown, field: string): string {
  const path = asString(value).replace(/\/+$/, "");
  if (!path) throw new SkillBundleError(`The manifest ${field} is missing a path.`);
  assertSafe(path);
  return path;
}

/** Selectors are literal skill names or a single trailing `*` prefix match. */
function selects(patterns: string[], name: string): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) =>
    pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name,
  );
}

function parseManifest(raw: unknown): Manifest {
  const document = asRecord(raw);

  const version = document.schema_version;
  if (version !== undefined && version !== null) {
    if (typeof version !== "number" || !Number.isInteger(version)) {
      throw new SkillBundleError(`${BUNDLE_MANIFEST} has an unreadable schema_version.`);
    }
    if (version > MANIFEST_SCHEMA_VERSION) {
      throw new SkillBundleError(
        `${BUNDLE_MANIFEST} declares schema_version ${version}; this build reads up to ${MANIFEST_SCHEMA_VERSION}.`,
      );
    }
  }

  const skills = asList(document.skills).map((item) => {
    const entry = asRecord(item);
    const path = manifestPath(entry.path, "skill");
    const name = assertSkillName(asString(entry.name) || (path.split("/").pop() ?? ""));
    return { name, path, description: asString(entry.description) };
  });

  const tools = asList(document.tools).map((item) => {
    const entry = asRecord(item);
    const path = manifestPath(entry.path, "tool");
    const name = assertToolName(asString(entry.name) || (path.split("/").pop() ?? ""));
    const moduleName = asString(entry.module) || name;
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(moduleName)) {
      throw new SkillBundleError(`The tool ${name} has no valid module.`);
    }
    const call = asString(entry.call) || "main";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(call)) {
      throw new SkillBundleError(`The tool ${name} has no valid call.`);
    }
    return { name, path, description: asString(entry.description), module: moduleName, call };
  });

  const mcpServers = asList(document.mcp_servers).map((item) => {
    const entry = asRecord(item);
    const path = manifestPath(entry.path, "MCP server");
    const name = assertMcpName(asString(entry.name) || (path.split("/").pop() ?? ""));
    return {
      name,
      path,
      description: asString(entry.description),
      runtime: assertRuntime(entry.runtime, name),
      entrypoint: assertEntrypoint(entry.entrypoint, name),
      env: assertDeclaredEnv(entry.env, name),
    };
  });

  if (skills.length + tools.length + mcpServers.length === 0) {
    throw new SkillBundleError(`${BUNDLE_MANIFEST} declares no capabilities.`);
  }

  const shared = asList(document.shared).map((item) => {
    const entry = asRecord(item);
    const path = manifestPath(entry.path, "shared library");
    const target = asString(entry.as) || `_lib/${path.split("/").pop()}`;
    assertSafe(target);
    return { path, as: target, skills: asList(entry.skills).map(asString).filter(Boolean) };
  });

  const entrypoints = asList(document.entrypoints).map((item) => {
    const entry = asRecord(item);
    const path = manifestPath(entry.path, "entrypoint");
    const moduleName = asString(entry.module);
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(moduleName)) {
      throw new SkillBundleError(`The manifest entrypoint ${path} has no valid module.`);
    }
    const call = asString(entry.call) || "main";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(call)) {
      throw new SkillBundleError(`The manifest entrypoint ${path} has no valid call.`);
    }
    return {
      path,
      module: moduleName,
      call,
      skills: asList(entry.skills).map(asString).filter(Boolean),
    };
  });

  return { skills, tools, mcpServers, shared, entrypoints };
}

/**
 * A shim that puts the skill's vendored `_lib` on `sys.path` before importing.
 *
 * This is what makes an exploded skill self-contained: the shared package
 * travels with the skill, so the script works without PYTHONPATH, an installed
 * distribution or an MCP server behind it.
 */
function entrypointShim(entry: ManifestEntrypoint, depth: number): string {
  const parents = depth === 1 ? "parent" : `parents[${depth}]`;
  return [
    '"""Generated by the DigiBuddy skill importer. Do not edit."""',
    "",
    "from pathlib import Path",
    "import sys",
    "",
    `sys.path.insert(0, str(Path(__file__).resolve().${parents} / "_lib"))`,
    "",
    `from ${entry.module} import ${entry.call}`,
    "",
    'if __name__ == "__main__":',
    `    raise SystemExit(${entry.call}())`,
    "",
  ].join("\n");
}

// --- Explosion -------------------------------------------------------------

type Archive = { payload: Buffer; entries: Map<string, ZipEntry> };

function read(archive: Archive, path: string, limit: number): Buffer {
  const entry = archive.entries.get(path);
  if (!entry) throw new SkillBundleError(`The bundle has no ${path}.`);
  if (entry.size > limit) {
    throw new SkillBundleError(`${path} is too large to read.`);
  }
  try {
    return readEntry(archive.payload, entry);
  } catch (error) {
    fail(error);
  }
}

/** Files under `root/`, keyed by their path relative to it. */
function subtree(archive: Archive, root: string): Map<string, ZipEntry> {
  const prefix = root ? `${root}/` : "";
  const found = new Map<string, ZipEntry>();
  for (const [path, entry] of archive.entries) {
    if (path.startsWith(prefix)) found.set(path.slice(prefix.length), entry);
  }
  return found;
}

/**
 * Repository archives from GitHub wrap everything in a `<repo>-<ref>/`
 * directory, and so does an ordinary bundle rooted at its own skill directory.
 * Strip that wrapper so both shapes are examined from the same place; which of
 * the two it was is decided by whether a `SKILL.md` sits directly inside.
 */
function stripArchiveRoot(entries: Map<string, ZipEntry>): string {
  const roots = new Set<string>();
  for (const path of entries.keys()) {
    const slash = path.indexOf("/");
    if (slash < 0) return "";
    roots.add(path.slice(0, slash));
  }
  return roots.size === 1 ? [...roots][0] : "";
}

/** Every directory that directly holds a SKILL.md, relative to `root`. */
function discoverSkills(archive: Archive, root: string): string[] {
  const found: string[] = [];
  for (const path of subtree(archive, root).keys()) {
    if (!path.endsWith("/SKILL.md")) continue;
    const directoryPath = path.slice(0, -"/SKILL.md".length);
    if (directoryPath.includes("/")) {
      // Only `skills/<name>/SKILL.md` nests; deeper matches are examples or
      // fixtures inside a skill, not skills in their own right.
      if (!directoryPath.startsWith("skills/") || directoryPath.split("/").length !== 2) {
        continue;
      }
    }
    found.push(directoryPath);
  }
  return found.sort();
}

function buildSkill(
  archive: Archive,
  root: string,
  declared: ManifestSkill,
  manifest: Manifest,
  notes: string[],
): ExplodedSkill {
  const base = root ? `${root}/${declared.path}` : declared.path;
  const files = subtree(archive, base);
  if (files.size === 0) {
    throw new SkillBundleError(`The bundle has nothing at ${declared.path}.`);
  }
  if (!files.has("SKILL.md")) {
    throw new SkillBundleError(`${declared.path} has no SKILL.md at its root.`);
  }

  const markdown = read(archive, `${base}/SKILL.md`, MAX_SKILL_MD_BYTES);
  const front = parseFrontmatter(markdown.toString("utf-8"));
  if (front.name && front.name !== declared.name) {
    // A mismatch means the skill will be discovered under a name its own
    // instructions never mention, which reads as a missing skill at runtime.
    throw new SkillBundleError(
      `${declared.path}/SKILL.md declares the name "${front.name}" but sits in "${declared.name}".`,
    );
  }
  const name = declared.name;

  const writable: WritableEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  const add = (relative: string, body: Buffer, mode: number): void => {
    assertSafe(relative);
    if (seen.has(relative)) return;
    seen.add(relative);
    total += body.length;
    if (total > MAX_SKILL_BYTES) {
      throw new SkillBundleError(`The skill ${name} expands beyond the size limit.`);
    }
    writable.push({ name: `${name}/${relative}`, body, mode });
  };

  for (const relative of [...files.keys()].sort()) {
    const entry = files.get(relative)!;
    add(relative, read(archive, `${base}/${relative}`, MAX_SKILL_BYTES), fileMode(entry));
  }

  for (const shared of manifest.shared) {
    if (!selects(shared.skills, name)) continue;
    const sharedBase = root ? `${root}/${shared.path}` : shared.path;
    const sharedFiles = subtree(archive, sharedBase);
    if (sharedFiles.size === 0) {
      throw new SkillBundleError(`The bundle has no shared library at ${shared.path}.`);
    }
    for (const relative of [...sharedFiles.keys()].sort()) {
      const entry = sharedFiles.get(relative)!;
      add(
        `${shared.as}/${relative}`,
        read(archive, `${sharedBase}/${relative}`, MAX_SKILL_BYTES),
        fileMode(entry),
      );
    }
  }

  for (const entrypoint of manifest.entrypoints) {
    if (!selects(entrypoint.skills, name)) continue;
    const depth = entrypoint.path.split("/").length - 1;
    if (depth < 1) {
      throw new SkillBundleError(
        `The manifest entrypoint ${entrypoint.path} must sit in a subdirectory.`,
      );
    }
    if (seen.has(entrypoint.path)) {
      notes.push(`${name}: kept its own ${entrypoint.path} instead of a generated shim.`);
      continue;
    }
    add(entrypoint.path, Buffer.from(entrypointShim(entrypoint, depth), "utf-8"), 0o755);
  }

  const payload = writeZip(writable);
  if (payload.length > MAX_BUNDLE_BYTES) {
    throw new SkillBundleError(`The skill ${name} is larger than the bundle size limit.`);
  }

  return {
    name,
    description: declared.description || front.description,
    payload,
    sha256: createHash("sha256").update(payload).digest("hex"),
    size: payload.length,
    entries: writable.map((entry) => entry.name.slice(name.length + 1)).sort(),
  };
}

/**
 * Carry the owner's execute bit and normalise everything else. The archive is
 * untrusted, so it must not be able to publish a setuid or world-writable file,
 * but a helper script that silently loses `+x` fails only once the agent runs it.
 */
function fileMode(entry: ZipEntry): number {
  return entry.mode & 0o100 ? 0o755 : 0o644;
}

/**
 * Package one declared directory as its own content-addressed artifact.
 *
 * Same shape as a skill bundle -- rooted at the capability's name, digested
 * over the bytes -- so the store, the registry and the runtime installer stay
 * one mechanism rather than three.
 */
function buildCapability(
  archive: Archive,
  root: string,
  kind: CapabilityKind,
  declared: { name: string; path: string; description: string },
  required: string | null,
): ExplodedCapability {
  const base = root ? `${root}/${declared.path}` : declared.path;
  const files = subtree(archive, base);
  if (files.size === 0) {
    throw new SkillBundleError(`The bundle has nothing at ${declared.path}.`);
  }
  if (required && !files.has(required)) {
    throw new SkillBundleError(
      `${declared.path} does not contain ${required}, which it declares as its entry point.`,
    );
  }

  const writable: WritableEntry[] = [];
  let total = 0;
  for (const relative of [...files.keys()].sort()) {
    const entry = files.get(relative)!;
    const body = read(archive, `${base}/${relative}`, MAX_SKILL_BYTES);
    total += body.length;
    if (total > MAX_SKILL_BYTES) {
      throw new SkillBundleError(
        `The capability ${declared.name} expands beyond the size limit.`,
      );
    }
    writable.push({
      name: `${declared.name}/${relative}`,
      body,
      mode: fileMode(entry),
    });
  }

  const payload = writeZip(writable);
  if (payload.length > MAX_BUNDLE_BYTES) {
    throw new SkillBundleError(
      `The capability ${declared.name} is larger than the bundle size limit.`,
    );
  }
  return {
    kind,
    name: declared.name,
    description: declared.description,
    payload,
    sha256: createHash("sha256").update(payload).digest("hex"),
    size: payload.length,
    entries: writable
      .map((entry) => entry.name.slice(declared.name.length + 1))
      .sort(),
  };
}

/**
 * Split an uploaded archive into deployable single-skill bundles.
 *
 * A plain single-skill zip passes through untouched, so its digest stays the
 * digest of the bytes the administrator uploaded.
 */
export function explodeBundle(payload: Buffer, fileName: string): ExplodedBundle {
  if (payload.length === 0) throw new SkillBundleError("The bundle is empty.");
  if (payload.length > MAX_BUNDLE_BYTES) {
    throw new SkillBundleError(
      `A bundle may be at most ${MAX_BUNDLE_BYTES / (1024 * 1024)} MB.`,
    );
  }

  const entries = new Map(directory(payload).map((entry) => [entry.name, entry]));
  const archive: Archive = { payload, entries };
  const root = stripArchiveRoot(entries);
  const relative = subtree(archive, root);
  const notes: string[] = [];

  // The simple case: one skill, already a bundle. Leave the bytes alone.
  if (relative.has("SKILL.md")) {
    const inspected = inspectBundle(payload, fileName);
    const markdown = read(
      archive,
      root ? `${root}/SKILL.md` : "SKILL.md",
      MAX_SKILL_MD_BYTES,
    );
    const front = parseFrontmatter(markdown.toString("utf-8"));
    if (front.name && front.name !== inspected.name) {
      throw new SkillBundleError(
        `SKILL.md declares the name "${front.name}" but the bundle is "${inspected.name}".`,
      );
    }
    const only = { ...inspected, payload, description: front.description };
    return {
      layout: "single",
      notes,
      skills: [only],
      capabilities: [{ ...only, kind: "skill" as const }],
    };
  }

  let manifest: Manifest;
  let layout: ExplodedBundle["layout"];
  if (relative.has(BUNDLE_MANIFEST)) {
    const raw = read(
      archive,
      root ? `${root}/${BUNDLE_MANIFEST}` : BUNDLE_MANIFEST,
      MAX_MANIFEST_BYTES,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf-8"));
    } catch {
      throw new SkillBundleError(`${BUNDLE_MANIFEST} is not valid JSON.`);
    }
    manifest = parseManifest(parsed);
    layout = "manifest";
  } else {
    const discovered = discoverSkills(archive, root);
    if (discovered.length === 0) {
      throw new SkillBundleError(
        `The archive holds no SKILL.md. Add one, or a ${BUNDLE_MANIFEST} describing where the skills are.`,
      );
    }
    manifest = {
      skills: discovered.map((path) => ({
        name: assertSkillName(path.split("/").pop() ?? ""),
        path,
        description: "",
      })),
      tools: [],
      mcpServers: [],
      shared: [],
      entrypoints: [],
    };
    layout = "discovered";
    notes.push(
      `No ${BUNDLE_MANIFEST}; found ${discovered.length} skills by looking for SKILL.md.`,
    );
  }

  const declaredCount =
    manifest.skills.length + manifest.tools.length + manifest.mcpServers.length;
  if (declaredCount > MAX_SKILLS_PER_BUNDLE) {
    throw new SkillBundleError(
      `An archive may yield at most ${MAX_SKILLS_PER_BUNDLE} capabilities.`,
    );
  }

  const capabilities: ExplodedCapability[] = [];
  // One namespace across kinds. Two capabilities sharing a name would install
  // over each other, and which one survived would depend on ordering.
  const seen = new Set<string>();
  const claim = (name: string) => {
    if (seen.has(name)) {
      throw new SkillBundleError(`The archive yields two capabilities named ${name}.`);
    }
    seen.add(name);
  };

  for (const declared of manifest.skills) {
    claim(declared.name);
    capabilities.push({
      ...buildSkill(archive, root, declared, manifest, notes),
      kind: "skill" as const,
    });
  }
  for (const declared of manifest.tools) {
    claim(declared.name);
    capabilities.push({
      ...buildCapability(archive, root, "tool", declared, null),
      tool: { module: declared.module, call: declared.call },
    });
  }
  for (const declared of manifest.mcpServers) {
    claim(declared.name);
    capabilities.push({
      ...buildCapability(archive, root, "mcp_server", declared, declared.entrypoint),
      mcp: {
        runtime: declared.runtime,
        entrypoint: declared.entrypoint,
        env: declared.env,
      },
    });
  }

  // Codepoint order, not locale order: this becomes a registry that two
  // runtimes compare, and localeCompare treats `-` and `_` as ignorable, so the
  // same archive could sort differently on different hosts.
  capabilities.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  return {
    skills: capabilities.filter((entry) => entry.kind === "skill"),
    capabilities,
    layout,
    notes,
  };
}
