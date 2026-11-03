import fs from "node:fs";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

/**
 * Minimal streaming ZIP reader (no dependency).
 *
 * The SEC 13F data sets are ~100 MB ZIPs with a 400 MB INFOTABLE member, so we
 * never load the archive into memory. Only the central directory (a few KB) is
 * read up front; the chosen member is streamed from its local-header offset
 * through `inflateRaw`. ZIP64 sizes/offsets are honoured.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const EOCD_MAX_COMMENT = 0xffff;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export async function listZipEntries(zipPath: string): Promise<ZipEntry[]> {
  const handle = await fs.promises.open(zipPath, "r");
  try {
    const { size } = await handle.stat();
    const eocdOffset = await findEndOfCentralDirectory(handle, size);
    const eocd = Buffer.alloc(EOCD_MIN_SIZE);
    await handle.read(eocd, 0, EOCD_MIN_SIZE, eocdOffset);
    const totalEntries = eocd.readUInt16LE(10);
    const centralSize = eocd.readUInt32LE(12);
    const centralOffset = eocd.readUInt32LE(16);
    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, centralSize, centralOffset);

    const entries: ZipEntry[] = [];
    let cursor = 0;
    for (let index = 0; index < totalEntries; index += 1) {
      if (cursor + 46 > central.length) break;
      if (central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;
      const method = central.readUInt16LE(cursor + 10);
      let compressedSize = central.readUInt32LE(cursor + 20);
      let uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      let localHeaderOffset = central.readUInt32LE(cursor + 42);
      const name = central
        .subarray(cursor + 46, cursor + 46 + nameLength)
        .toString("utf8");
      const extraStart = cursor + 46 + nameLength;
      const extra = central.subarray(extraStart, extraStart + extraLength);
      if (
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff
      ) {
        const zip64 = readZip64Extra(extra, {
          uncompressed: uncompressedSize === 0xffffffff,
          compressed: compressedSize === 0xffffffff,
          localOffset: localHeaderOffset === 0xffffffff,
        });
        uncompressedSize = zip64.uncompressedSize ?? uncompressedSize;
        compressedSize = zip64.compressedSize ?? compressedSize;
        localHeaderOffset = zip64.localHeaderOffset ?? localHeaderOffset;
      }
      entries.push({
        name,
        method,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      cursor = extraStart + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/** Open one member as a readable stream (inflating DEFLATE members). */
export async function openZipEntry(
  zipPath: string,
  entryName: string,
): Promise<Readable> {
  const entries = await listZipEntries(zipPath);
  const entry = entries.find((candidate) => candidate.name === entryName);
  if (!entry) {
    throw new Error(
      `zip entry ${entryName} not found in ${zipPath}; available: ${entries
        .map((candidate) => candidate.name)
        .join(", ")}`,
    );
  }
  const handle = await fs.promises.open(zipPath, "r");
  let dataOffset: number;
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.localHeaderOffset);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new Error(`invalid local header for ${entryName}`);
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  } finally {
    await handle.close();
  }

  const raw = fs.createReadStream(zipPath, {
    start: dataOffset,
    end: dataOffset + entry.compressedSize - 1,
  });
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    const inflate = createInflateRaw();
    raw.on("error", (error) => inflate.destroy(error));
    return raw.pipe(inflate);
  }
  raw.destroy();
  throw new Error(
    `unsupported zip compression method ${entry.method} for ${entryName}`,
  );
}

/** Read a small member fully (SUBMISSION/COVERPAGE are a few MB at most). */
export async function readZipText(
  zipPath: string,
  entryName: string,
): Promise<string> {
  const stream = await openZipEntry(zipPath, entryName);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "");
}

async function findEndOfCentralDirectory(
  handle: fs.promises.FileHandle,
  size: number,
): Promise<number> {
  const readSize = Math.min(size, EOCD_MIN_SIZE + EOCD_MAX_COMMENT);
  const tail = Buffer.alloc(readSize);
  await handle.read(tail, 0, readSize, size - readSize);
  for (let offset = tail.length - EOCD_MIN_SIZE; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return size - readSize + offset;
    }
  }
  throw new Error("zip end-of-central-directory record not found");
}

function readZip64Extra(
  extra: Buffer,
  needs: { uncompressed: boolean; compressed: boolean; localOffset: boolean },
): {
  uncompressedSize?: number;
  compressedSize?: number;
  localHeaderOffset?: number;
} {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const body = extra.subarray(cursor + 4, cursor + 4 + size);
    if (id === 0x0001) {
      let position = 0;
      const next = (): number | undefined => {
        if (position + 8 > body.length) return undefined;
        const value = Number(body.readBigUInt64LE(position));
        position += 8;
        return value;
      };
      // The extra field only carries the values that were 0xffffffff in the
      // fixed header, in this fixed order.
      const uncompressedSize = needs.uncompressed ? next() : undefined;
      const compressedSize = needs.compressed ? next() : undefined;
      const localHeaderOffset = needs.localOffset ? next() : undefined;
      return { uncompressedSize, compressedSize, localHeaderOffset };
    }
    cursor += 4 + size;
  }
  return {};
}
