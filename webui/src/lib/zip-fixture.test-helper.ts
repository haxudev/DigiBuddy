/**
 * Zip fixture builder shared by the bundle tests.
 *
 * Archives are written stored (uncompressed) but with real CRCs, because
 * `readEntry` verifies them: a fixture that lied about its checksum would fail
 * for reasons unrelated to what the test is about.
 */

import { crc32 } from "./zip.ts";

const REGULAR = 0o100644;
const EXECUTABLE = 0o100755;
const SYMLINK = 0o120777;

export type ZipFixtureOptions = {
  /** Entries to mark as symlinks, which a bundle may never contain. */
  symlink?: string | string[];
  /** Entries to give the owner execute bit. */
  executable?: string[];
};

function has(value: string | string[] | undefined, name: string): boolean {
  if (value === undefined) return false;
  return Array.isArray(value) ? value.includes(name) : value === name;
}

export function zip(
  entries: Record<string, string>,
  options: ZipFixtureOptions = {},
): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const [name, body] of Object.entries(entries)) {
    const rawName = Buffer.from(name, "utf-8");
    const data = Buffer.from(body, "utf-8");
    const crc = crc32(data);
    const mode = has(options.symlink, name)
      ? SYMLINK
      : has(options.executable, name)
        ? EXECUTABLE
        : REGULAR;

    const local = Buffer.alloc(30 + rawName.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(rawName.length, 26);
    rawName.copy(local, 30);
    data.copy(local, 30 + rawName.length);
    locals.push(local);

    const header = Buffer.alloc(46 + rawName.length);
    header.writeUInt32LE(0x02014b50, 0);
    // "Made by" Unix (3), so the mode in the external attributes is honoured.
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(rawName.length, 28);
    header.writeUInt32LE((mode << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    rawName.copy(header, 46);
    directory.push(header);

    offset += local.length;
  }

  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(directory.length, 8);
  end.writeUInt16LE(directory.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
