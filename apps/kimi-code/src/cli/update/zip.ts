/**
 * Minimal ZIP reader for community release archives.
 *
 * The native release pipeline (`scripts/native/package.mjs`, yazl) uploads a
 * single-executable archive per platform. Rather than add an unzip
 * dependency, this module reads exactly what that pipeline writes: a
 * single-disk ZIP with STORED or DEFLATE entries and sizes recorded in the
 * central directory. Anything outside that envelope (multi-disk archives,
 * ZIP64, encryption, spanning) is rejected instead of half-parsed.
 */

import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  /** Unix permission bits from the central directory (0 when not recorded). */
  readonly mode: number;
  readonly data: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
// ZIP comments cap at 64 KiB, so the EOCD record must live within this window.
const EOCD_MAX_SCAN_BYTES = 65_536 + EOCD_MIN_SIZE;
const MAX_ENTRIES = 4_096;
const MAX_UNCOMPRESSED_SIZE = 2 * 1024 * 1024 * 1024;
const ZIP64_MARKER = 0xffff_ffff;

function fail(message: string): never {
  throw new Error(`invalid zip archive: ${message}`);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - EOCD_MAX_SCAN_BYTES);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= start; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  return fail('end-of-central-directory record not found');
}

interface CentralDirectoryEntry {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly mode: number;
  readonly localHeaderOffset: number;
}

function readCentralDirectory(buffer: Buffer): readonly CentralDirectoryEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) {
    fail('multi-disk archives are not supported');
  }
  if (totalEntries === 0xffff || directoryOffset === ZIP64_MARKER || directorySize === ZIP64_MARKER) {
    fail('zip64 archives are not supported');
  }
  if (totalEntries > MAX_ENTRIES) {
    fail(`too many entries (${totalEntries})`);
  }
  if (directoryOffset + directorySize > buffer.length) {
    fail('central directory extends past the end of the file');
  }

  const entries: CentralDirectoryEntry[] = [];
  let cursor = directoryOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > buffer.length) fail('truncated central directory entry');
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIR_SIGNATURE) {
      fail(`bad central directory signature at offset ${cursor}`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER || localHeaderOffset === ZIP64_MARKER) {
      fail('zip64 entries are not supported');
    }
    if (uncompressedSize > MAX_UNCOMPRESSED_SIZE) {
      fail(`entry too large (${uncompressedSize} bytes)`);
    }

    const nameStart = cursor + 46;
    if (nameStart + nameLength > buffer.length) fail('truncated entry name');
    const name = buffer.toString('utf-8', nameStart, nameStart + nameLength);

    entries.push({
      name,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      mode: externalAttributes >>> 16,
      localHeaderOffset,
    });

    cursor = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readEntryData(buffer: Buffer, entry: CentralDirectoryEntry): Buffer {
  const local = entry.localHeaderOffset;
  if (local + 30 > buffer.length) fail('truncated local file header');
  if (buffer.readUInt32LE(local) !== LOCAL_HEADER_SIGNATURE) {
    fail(`bad local header signature at offset ${local}`);
  }
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart > dataEnd || dataEnd > buffer.length) {
    fail(`entry data for ${JSON.stringify(entry.name)} extends past the end of the file`);
  }

  const compressed = buffer.subarray(dataStart, dataEnd);
  let data: Buffer;
  if (entry.method === 0) {
    data = Buffer.from(compressed);
  } else if (entry.method === 8) {
    try {
      data = inflateRawSync(compressed);
    } catch (error) {
      fail(`failed to inflate ${JSON.stringify(entry.name)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    fail(`unsupported compression method ${entry.method} for ${JSON.stringify(entry.name)}`);
  }

  if (data.length !== entry.uncompressedSize) {
    fail(`size mismatch for ${JSON.stringify(entry.name)}`);
  }
  if (crc32(data) !== entry.crc) {
    fail(`checksum mismatch for ${JSON.stringify(entry.name)}`);
  }
  return data;
}

/** Read every entry of a (non-ZIP64, single-disk) ZIP archive into memory. */
export function readZipEntries(buffer: Buffer): readonly ZipEntry[] {
  return readCentralDirectory(buffer).map((entry) => ({
    name: entry.name,
    mode: entry.mode,
    data: readEntryData(buffer, entry),
  }));
}
