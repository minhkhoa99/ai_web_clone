// Minimal streaming ZIP writer (deflate, no zip64): local header + data per file, then the central
// directory. Files are read and compressed one at a time, so memory is bounded by the largest file.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;
const DOS_DATE_1980_01_01 = 0x21; // zip has no "no date"; a fixed date keeps output deterministic
const UTF8_FLAG = 0x0800;

export async function* zipDir(dir: string): AsyncGenerator<Uint8Array> {
  const names = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)).split(sep).join("/"))
    .sort();
  if (names.length > MAX_ENTRIES) throw new RangeError(`zip: ${names.length} files exceed ${MAX_ENTRIES}`);
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const data = await readFile(join(dir, name));
    const packed = deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    if (offset + 30 + nameBuf.length + packed.length > MAX_OFFSET) throw new RangeError("zip: output exceeds 4 GiB (no zip64)");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    yield local;
    yield nameBuf;
    yield packed;

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(UTF8_FLAG, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  yield dirBuf;
  yield end;
}
