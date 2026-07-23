import { randomBytes } from 'node:crypto';

import { ZipFile } from 'yazl';
import { describe, expect, it } from 'vitest';

import { readZipEntries } from '#/cli/update/zip';

interface TestEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly mode?: number;
  readonly compress?: boolean;
}

/** Build a zip the same way scripts/native/package.mjs does (yazl). */
function buildZip(entries: readonly TestEntry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    for (const entry of entries) {
      zip.addBuffer(entry.data, entry.name, {
        mode: entry.mode ?? 0o100644,
        compress: entry.compress ?? true,
      });
    }
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    zip.outputStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    zip.outputStream.on('error', reject);
  });
}

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

describe('readZipEntries', () => {
  it('reads deflate-compressed entries produced by yazl', async () => {
    const data = Buffer.from('omkc sea binary payload '.repeat(200), 'utf-8');
    const archive = await buildZip([{ name: 'omkc', data, mode: 0o100755 }]);

    const entries = readZipEntries(archive);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('omkc');
    expect(Buffer.compare(entries[0]?.data ?? Buffer.alloc(0), data)).toBe(0);
    expect((entries[0]?.mode ?? 0) & 0o777).toBe(0o755);
  });

  it('reads stored (uncompressed) entries', async () => {
    const data = Buffer.from('stored payload', 'utf-8');
    const archive = await buildZip([{ name: 'omkc.exe', data, compress: false }]);

    const entries = readZipEntries(archive);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('omkc.exe');
    expect(Buffer.compare(entries[0]?.data ?? Buffer.alloc(0), data)).toBe(0);
  });

  it('reads every entry of a multi-entry archive', async () => {
    const archive = await buildZip([
      { name: 'omkc', data: randomBytes(4_096), mode: 0o100755 },
      { name: 'README.txt', data: Buffer.from('notes'), compress: false },
      { name: 'nested/blob.bin', data: randomBytes(1_024) },
    ]);

    const entries = readZipEntries(archive);
    expect(entries.map((entry) => entry.name)).toEqual(['omkc', 'README.txt', 'nested/blob.bin']);
  });

  it('rejects input without an end-of-central-directory record', () => {
    expect(() => readZipEntries(Buffer.from('not a zip at all'))).toThrow(
      /end-of-central-directory record not found/,
    );
  });

  it('rejects zip64 archives', async () => {
    const archive = await buildZip([{ name: 'omkc', data: Buffer.from('x') }]);
    const eocd = archive.lastIndexOf(EOCD_SIGNATURE);
    expect(eocd).toBeGreaterThan(0);
    // Total-entries field of the EOCD: 0xffff marks a zip64 archive.
    archive.writeUInt16LE(0xffff, eocd + 10);

    expect(() => readZipEntries(archive)).toThrow(/zip64/);
  });

  it('rejects an entry whose data was corrupted after packaging', async () => {
    const data = Buffer.from('verify me');
    const archive = await buildZip([{ name: 'omkc', data, compress: false }]);
    // Stored entry data starts right after the fixed 30-byte local header
    // and the entry name; flip one byte so the CRC-32 no longer matches.
    const dataOffset = 30 + 'omkc'.length;
    archive.writeUInt8(archive.readUInt8(dataOffset) ^ 0xff, dataOffset);

    expect(() => readZipEntries(archive)).toThrow(/checksum mismatch/);
  });

  it('rejects a truncated archive', async () => {
    const archive = await buildZip([{ name: 'omkc', data: randomBytes(8_192) }]);
    expect(() => readZipEntries(archive.subarray(0, Math.floor(archive.length / 2)))).toThrow(
      /invalid zip archive/,
    );
  });
});
