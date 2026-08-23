/**
 * Skill bundle inspection.
 *
 * A skill is uploaded as a zip: `SKILL.md` plus whatever references and scripts
 * it needs. Before a bundle reaches the store we read its central directory to
 * confirm it is a well-formed, self-contained skill, and we hash it so the
 * runtime can prove it received the same bytes an administrator approved.
 *
 * Only the directory is parsed — entry names and sizes are enough to reject a
 * malicious archive, and not decompressing keeps the console cheap. The runtime
 * repeats every check when it extracts, because the store is the real trust
 * boundary.
 */

import { createHash } from "node:crypto";

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Mirrors the ceilings in `hosted-agent/codex_adapter/skills.py`. */
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 128 * 1024 * 1024;
export const MAX_ENTRIES = 2000;

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP64_MARKER = 0xffffffff;

export class SkillBundleError extends Error {}

export type InspectedBundle = {
  /** The skill's directory name, taken from the bundle or the file name. */
  name: string;
  sha256: string;
  size: number;
  entries: string[];
};

function endOfCentralDirectory(bytes: Buffer): number {
  // The record is variable-length because of its trailing comment, so scan back
  // from the end for the signature. The comment is capped at 64 KiB by the spec.
  const earliest = Math.max(0, bytes.length - 0xffff - 22);
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new SkillBundleError("The file is not a zip archive.");
}

function entryNames(bytes: Buffer): { names: string[]; extracted: number } {
  const eocd = endOfCentralDirectory(bytes);
  const count = bytes.readUInt16LE(eocd + 10);
  const directory = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || directory === ZIP64_MARKER) {
    throw new SkillBundleError("ZIP64 archives are not supported.");
  }
  if (count === 0) throw new SkillBundleError("The bundle is empty.");
  if (count > MAX_ENTRIES) {
    throw new SkillBundleError(`A bundle may hold at most ${MAX_ENTRIES} files.`);
  }

  const names: string[] = [];
  let extracted = 0;
  let offset = directory;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new SkillBundleError("The zip central directory is corrupt.");
    }
    const uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const name = bytes.toString("utf-8", offset + 46, offset + 46 + nameLength);

    if (((externalAttributes >>> 16) & 0xf000) === 0xa000) {
      throw new SkillBundleError(`The bundle contains a symlink: ${name}`);
    }
    if (!name.endsWith("/")) {
      extracted += uncompressed;
      names.push(name);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }

  if (extracted > MAX_EXTRACTED_BYTES) {
    throw new SkillBundleError("The bundle expands beyond the size limit.");
  }
  return { names, extracted };
}

function assertSafe(name: string): void {
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").some((part) => part === ".." || part === ".")
  ) {
    throw new SkillBundleError(`The bundle contains an unsafe path: ${name}`);
  }
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
  if (!SKILL_NAME.test(name)) {
    throw new SkillBundleError(
      `Skill names may only contain lowercase letters, digits and dashes: ${name}`,
    );
  }
  return name;
}

/** Strip the archive extension so `seo-optimizer.skill` names `seo-optimizer`. */
export function nameFromFile(fileName: string): string {
  return (fileName.split("/").pop() ?? "")
    .replace(/\.(zip|skill)$/i, "")
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

  const { names } = entryNames(payload);
  names.forEach(assertSafe);
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
