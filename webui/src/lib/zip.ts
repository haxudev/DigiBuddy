/**
 * Zip reading and writing for skill bundles.
 *
 * `skill-bundle.ts` only parses the central directory, which is enough to
 * validate a simple upload. Onboarding a complex source -- a repository archive
 * carrying several skills, a shared Python package and scaffolding -- needs
 * more: we have to read `SKILL.md` out of the archive and write one normalised
 * single-skill bundle per skill. That is what this module provides, with no
 * dependency beyond `node:zlib`.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_MARKER = 0xffffffff;

const STORED = 0;
const DEFLATED = 8;

/** DOS timestamp for 1980-01-01, so bundles are byte-for-byte reproducible. */
const DOS_EPOCH_TIME = 0;
const DOS_EPOCH_DATE = 33;

export class ZipError extends Error {}

export type ZipEntry = {
  name: string;
  /** Unix mode from the external attributes, or 0 when the archive has none. */
  mode: number;
  size: number;
  compression: number;
  compressedSize: number;
  crc32: number;
  localHeaderOffset: number;
};

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

export function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function endOfCentralDirectory(bytes: Buffer): number {
  // The record is variable-length because of its trailing comment, so scan back
  // from the end for the signature. The comment is capped at 64 KiB by the spec.
  const earliest = Math.max(0, bytes.length - 0xffff - 22);
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new ZipError("The file is not a zip archive.");
}

/** Parse the central directory. Directory entries are dropped. */
export function readDirectory(bytes: Buffer, maxEntries: number): ZipEntry[] {
  const eocd = endOfCentralDirectory(bytes);
  const diskCount = bytes.readUInt16LE(eocd + 8);
  const count = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directory = bytes.readUInt32LE(eocd + 16);
  if (
    diskCount === 0xffff ||
    count === 0xffff ||
    directorySize === ZIP64_MARKER ||
    directory === ZIP64_MARKER
  ) {
    throw new ZipError("ZIP64 archives are not supported.");
  }
  if (count === 0) throw new ZipError("The bundle is empty.");
  if (count > maxEntries) {
    throw new ZipError(`A bundle may hold at most ${maxEntries} files.`);
  }

  const entries: ZipEntry[] = [];
  let offset = directory;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new ZipError("The zip central directory is corrupt.");
    }
    const compression = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString("utf-8", offset + 46, offset + 46 + nameLength);

    if (!name.endsWith("/")) {
      entries.push({
        name,
        mode: (externalAttributes >>> 16) & 0xffff,
        size,
        compression,
        compressedSize,
        crc32: crc,
        localHeaderOffset,
      });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Decompress one entry. The central directory sizes are authoritative. */
export function readEntry(bytes: Buffer, entry: ZipEntry): Buffer {
  const header = entry.localHeaderOffset;
  if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== LOCAL_FILE_HEADER) {
    throw new ZipError(`The zip entry is corrupt: ${entry.name}`);
  }
  const nameLength = bytes.readUInt16LE(header + 26);
  const extraLength = bytes.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.length) {
    throw new ZipError(`The zip entry runs past the end of the file: ${entry.name}`);
  }

  const raw = bytes.subarray(start, end);
  let body: Buffer;
  if (entry.compression === STORED) {
    body = Buffer.from(raw);
  } else if (entry.compression === DEFLATED) {
    try {
      body = inflateRawSync(raw);
    } catch {
      throw new ZipError(`The zip entry could not be decompressed: ${entry.name}`);
    }
  } else {
    throw new ZipError(
      `The zip entry uses an unsupported compression method: ${entry.name}`,
    );
  }

  // A mismatch here means the central directory lied about the entry, which is
  // exactly the trick a crafted archive would use to smuggle content past the
  // size accounting we did while validating.
  if (body.length !== entry.size || crc32(body) !== entry.crc32) {
    throw new ZipError(`The zip entry does not match its checksum: ${entry.name}`);
  }
  return body;
}

export type WritableEntry = { name: string; body: Buffer; mode: number };

/**
 * Write a zip. Entries are stored in the given order and always deflated, and
 * timestamps are fixed, so the same inputs always hash to the same bundle.
 */
export function writeZip(entries: WritableEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const rawName = Buffer.from(entry.name, "utf-8");
    const crc = crc32(entry.body);
    const deflated = deflateRawSync(entry.body, { level: 9 });
    // Never let compression make an entry bigger than the raw bytes.
    const stored = deflated.length >= entry.body.length;
    const data = stored ? entry.body : deflated;
    const method = stored ? STORED : DEFLATED;

    const local = Buffer.alloc(30 + rawName.length);
    local.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_EPOCH_TIME, 10);
    local.writeUInt16LE(DOS_EPOCH_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(rawName.length, 26);
    rawName.copy(local, 30);
    locals.push(local, data);

    const header = Buffer.alloc(46 + rawName.length);
    header.writeUInt32LE(CENTRAL_FILE_HEADER, 0);
    // "Made by" Unix (3) so the mode in the external attributes is honoured.
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_EPOCH_TIME, 12);
    header.writeUInt16LE(DOS_EPOCH_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(entry.body.length, 24);
    header.writeUInt16LE(rawName.length, 28);
    header.writeUInt32LE((entry.mode & 0xffff) << 16, 38);
    header.writeUInt32LE(offset, 42);
    rawName.copy(header, 46);
    central.push(header);

    offset += local.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
