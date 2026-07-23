import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ZipFile } from 'yazl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installNativeUpdate,
  parseSha256ChecksumFile,
  resolveExpectedChecksum,
  sha256Hex,
} from '#/cli/update/native-install';
import type { ReleaseAsset } from '#/cli/update/types';

type Route = { readonly status?: number; readonly body?: Buffer | string } | Error;

function routeResponse(route: Exclude<Route, Error>): Response {
  const status = route.status ?? 200;
  const body = route.body ?? '';
  const bytes = new Uint8Array(Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8'));
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => Buffer.from(bytes).toString('utf-8'),
    arrayBuffer: async () => bytes.slice().buffer,
  } as unknown as Response;
}

function routedFetch(routes: Record<string, Route>): typeof fetch {
  return vi.fn(async (input: string | URL) => {
    const route = routes[String(input)];
    if (route === undefined) {
      return routeResponse({ status: 404 });
    }
    if (route instanceof Error) throw route;
    return routeResponse(route);
  }) as unknown as typeof fetch;
}

function buildZipBuffer(data: Buffer, entryName = 'omkc'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    zip.addBuffer(data, entryName, { mode: 0o100755 });
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

const ZIP_URL = 'https://dl.example.test/omkc-linux-x64.zip';
const CHECKSUM_URL = 'https://dl.example.test/omkc-linux-x64.zip.sha256';
const MANIFEST_URL = 'https://dl.example.test/manifest.json';

const ASSETS: readonly ReleaseAsset[] = [
  { name: 'omkc-linux-x64.zip', url: ZIP_URL },
  { name: 'omkc-linux-x64.zip.sha256', url: CHECKSUM_URL },
  { name: 'manifest.json', url: MANIFEST_URL },
];

let dir: string;
let downloadDir: string;
let executablePath: string;
let newBinary: Buffer;
let archive: Buffer;
let checksum: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'omkc-native-install-'));
  downloadDir = join(dir, 'downloads');
  executablePath = join(dir, 'omkc');
  writeFileSync(executablePath, Buffer.from('old binary'));
  newBinary = randomBytes(64 * 1024);
  archive = await buildZipBuffer(newBinary);
  checksum = createHash('sha256').update(archive).digest('hex');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function manifestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '0.6.0-omkc.1',
    tag: 'oh-my-kimi-code@0.6.0-omkc.1',
    platforms: {
      'linux-x64': { filename: 'omkc-linux-x64.zip', checksum },
    },
    ...overrides,
  });
}

function installParams(fetchImpl: typeof fetch) {
  return {
    version: '0.6.0-omkc.1',
    assets: ASSETS,
    platform: 'linux' as NodeJS.Platform,
    arch: 'x64',
    env: {},
    fetchImpl,
    executablePath,
    downloadDir,
  };
}

describe('installNativeUpdate', () => {
  it('downloads, verifies via manifest.json, and replaces the executable', async () => {
    const fetchImpl = routedFetch({
      [MANIFEST_URL]: { body: manifestBody() },
      [ZIP_URL]: { body: archive },
    });

    await installNativeUpdate(installParams(fetchImpl));

    expect(Buffer.compare(readFileSync(executablePath), newBinary)).toBe(0);
    // The archive is removed once the replacement has landed.
    expect(readdirSync(downloadDir)).toEqual([]);
    // No staged temp binary is left next to the executable.
    expect(readdirSync(dir).filter((name) => name.includes('.update-'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'installs the executable with mode 0755',
    async () => {
      const fetchImpl = routedFetch({
        [MANIFEST_URL]: { body: manifestBody() },
        [ZIP_URL]: { body: archive },
      });

      await installNativeUpdate(installParams(fetchImpl));

      expect(statSync(executablePath).mode & 0o777).toBe(0o755);
    },
  );

  it('falls back to the per-asset .sha256 file when the release has no manifest', async () => {
    const assets = ASSETS.filter((asset) => asset.name !== 'manifest.json');
    const fetchImpl = routedFetch({
      [CHECKSUM_URL]: { body: `${checksum.toUpperCase()}  omkc-linux-x64.zip\n` },
      [ZIP_URL]: { body: archive },
    });

    await installNativeUpdate({ ...installParams(fetchImpl), assets });

    expect(Buffer.compare(readFileSync(executablePath), newBinary)).toBe(0);
  });

  it('prefers the manifest checksum over the .sha256 asset', async () => {
    const fetchImpl = routedFetch({
      [MANIFEST_URL]: { body: manifestBody() },
      // A stale per-asset checksum that disagrees with the manifest must be
      // ignored — the aggregated manifest is authoritative.
      [CHECKSUM_URL]: { body: `${'0'.repeat(64)}  omkc-linux-x64.zip\n` },
      [ZIP_URL]: { body: archive },
    });

    await installNativeUpdate(installParams(fetchImpl));

    const fetchedUrls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => String(url));
    expect(fetchedUrls).toContain(MANIFEST_URL);
    expect(fetchedUrls).not.toContain(CHECKSUM_URL);
  });

  it('refuses to install when the release carries no checksum source', async () => {
    const assets = ASSETS.filter((asset) => asset.name === 'omkc-linux-x64.zip');
    const fetchImpl = routedFetch({ [ZIP_URL]: { body: archive } });

    await expect(installNativeUpdate({ ...installParams(fetchImpl), assets })).rejects.toThrow(
      /neither manifest\.json nor a \.sha256/,
    );
    expect(readFileSync(executablePath, 'utf-8')).toBe('old binary');
  });

  it('rejects an archive whose sha256 does not match', async () => {
    const fetchImpl = routedFetch({
      [MANIFEST_URL]: {
        body: manifestBody({
          platforms: { 'linux-x64': { filename: 'omkc-linux-x64.zip', checksum: 'f'.repeat(64) } },
        }),
      },
      [ZIP_URL]: { body: archive },
    });

    await expect(installNativeUpdate(installParams(fetchImpl))).rejects.toThrow(/sha256 mismatch/);
    expect(readFileSync(executablePath, 'utf-8')).toBe('old binary');
    expect(readdirSync(downloadDir)).toEqual([]);
  });

  it('rejects a manifest whose version disagrees with the release', async () => {
    const fetchImpl = routedFetch({
      [MANIFEST_URL]: { body: manifestBody({ version: '0.9.9' }) },
      [ZIP_URL]: { body: archive },
    });

    await expect(installNativeUpdate(installParams(fetchImpl))).rejects.toThrow(
      /lists version 0\.9\.9/,
    );
  });

  it('throws when the release has no asset for this platform target', async () => {
    const fetchImpl = routedFetch({});
    const params = { ...installParams(fetchImpl), arch: 'arm64' };

    await expect(installNativeUpdate(params)).rejects.toThrow(
      /no omkc-linux-arm64\.zip asset for this platform/,
    );
  });

  it('throws when the archive does not contain the platform executable', async () => {
    const wrongZip = await buildZipBuffer(newBinary, 'not-the-binary');
    const wrongChecksum = createHash('sha256').update(wrongZip).digest('hex');
    const fetchImpl = routedFetch({
      [MANIFEST_URL]: {
        body: manifestBody({
          platforms: { 'linux-x64': { filename: 'omkc-linux-x64.zip', checksum: wrongChecksum } },
        }),
      },
      [ZIP_URL]: { body: wrongZip },
    });

    await expect(installNativeUpdate(installParams(fetchImpl))).rejects.toThrow(
      /does not contain a omkc entry/,
    );
  });

  it('honors the KIMI_CODE_BUILD_TARGET override for target selection', async () => {
    const fetchImpl = routedFetch({
      [MANIFEST_URL]: { body: manifestBody() },
      [ZIP_URL]: { body: archive },
    });

    await expect(
      installNativeUpdate({ ...installParams(fetchImpl), env: { KIMI_CODE_BUILD_TARGET: 'win32-x64' } }),
    ).rejects.toThrow(/no omkc-win32-x64\.zip asset/);
  });
});

describe('resolveExpectedChecksum', () => {
  it('reads the checksum from manifest.json', async () => {
    const fetchImpl = routedFetch({ [MANIFEST_URL]: { body: manifestBody() } });
    await expect(resolveExpectedChecksum(ASSETS, 'linux-x64', '0.6.0-omkc.1', fetchImpl)).resolves.toBe(
      checksum,
    );
  });

  it('reads the checksum from the .sha256 asset as a fallback', async () => {
    const assets = ASSETS.filter((asset) => asset.name !== 'manifest.json');
    const fetchImpl = routedFetch({ [CHECKSUM_URL]: { body: `${checksum}  omkc-linux-x64.zip\n` } });
    await expect(resolveExpectedChecksum(assets, 'linux-x64', '0.6.0-omkc.1', fetchImpl)).resolves.toBe(
      checksum,
    );
  });

  it('rejects a manifest that has no entry for this target and no .sha256 fallback', async () => {
    const assets = ASSETS.filter((asset) => asset.name !== 'omkc-linux-x64.zip.sha256');
    const fetchImpl = routedFetch({
      [MANIFEST_URL]: { body: manifestBody({ platforms: {} }) },
    });
    await expect(resolveExpectedChecksum(assets, 'linux-x64', '0.6.0-omkc.1', fetchImpl)).rejects.toThrow(
      /neither manifest\.json nor a \.sha256/,
    );
  });

  it('propagates a failed download of the listed .sha256 asset', async () => {
    const assets = ASSETS.filter((asset) => asset.name !== 'manifest.json');
    const fetchImpl = routedFetch({ [CHECKSUM_URL]: { status: 404 } });
    await expect(resolveExpectedChecksum(assets, 'linux-x64', '0.6.0-omkc.1', fetchImpl)).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

describe('parseSha256ChecksumFile', () => {
  it('extracts the first token of a sha256sum-style line', () => {
    expect(parseSha256ChecksumFile(`${'a'.repeat(64)}  omkc-linux-x64.zip\n`)).toBe('a'.repeat(64));
  });

  it('lowercases uppercase digests', () => {
    expect(parseSha256ChecksumFile(`${'A'.repeat(64)}\n`)).toBe('a'.repeat(64));
  });

  it('returns null for missing or malformed digests', () => {
    expect(parseSha256ChecksumFile('')).toBeNull();
    expect(parseSha256ChecksumFile('nothex  file\n')).toBeNull();
    expect(parseSha256ChecksumFile(`${'a'.repeat(63)}  file\n`)).toBeNull();
  });
});

describe('sha256Hex', () => {
  it('matches node:crypto', () => {
    const data = randomBytes(128);
    expect(sha256Hex(data)).toBe(createHash('sha256').update(data).digest('hex'));
  });
});
