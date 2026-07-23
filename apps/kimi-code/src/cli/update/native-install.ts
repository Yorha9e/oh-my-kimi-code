/**
 * Self-update installer for the community single-file native executable.
 *
 * Flow: pick the release asset for this platform (`omkc-<target>.zip`),
 * resolve its expected SHA-256 from the release's `manifest.json` (falling
 * back to the per-asset `.sha256` file), download and verify the archive,
 * extract the executable, and rename it over the running binary. The rename
 * works while the current process is executing on POSIX (the running image
 * stays mapped to the old inode); replacing a running `.exe` is not possible
 * on Windows, so the updater never calls in here on win32 — those users get
 * the manual download instructions instead (see `canAutoInstall`).
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { getUpdateDownloadsDir } from '#/utils/paths';

import {
  NATIVE_MANIFEST_ASSET_NAME,
  nativeAssetFileName,
  nativeChecksumAssetFileName,
  nativeExecutableName,
  nativeTargetTriple,
} from './native-target';
import type { ReleaseAsset } from './types';
import { readZipEntries } from './zip';

export const NATIVE_DOWNLOAD_TIMEOUT_MS = 120_000;
const NATIVE_METADATA_TIMEOUT_MS = 10_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Shape of the aggregated `manifest.json` release asset (produce-manifest.mjs). */
const NativeReleaseManifestSchema = z.object({
  version: z.string().min(1).optional(),
  tag: z.string().min(1).optional(),
  platforms: z.record(
    z.string(),
    z.object({
      filename: z.string().min(1),
      checksum: z.string().regex(SHA256_PATTERN),
    }),
  ),
});

function findAsset(assets: readonly ReleaseAsset[], name: string): ReleaseAsset | null {
  return assets.find((asset) => asset.name === name) ?? null;
}

async function fetchTextWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

/** First whitespace-separated token of a `<hex>  <filename>` checksum file. */
export function parseSha256ChecksumFile(text: string): string | null {
  const token = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return SHA256_PATTERN.test(token) ? token : null;
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function checksumFromManifestAsset(
  fetchImpl: typeof fetch,
  asset: ReleaseAsset,
  target: string,
  version: string,
): Promise<string | null> {
  const parsed = NativeReleaseManifestSchema.safeParse(
    JSON.parse(await fetchTextWithTimeout(fetchImpl, asset.url, NATIVE_METADATA_TIMEOUT_MS)),
  );
  if (!parsed.success) {
    throw new Error(`release manifest.json failed validation: ${parsed.error.message}`);
  }
  const manifest = parsed.data;
  if (manifest.version !== undefined && manifest.version !== version) {
    throw new Error(
      `release manifest.json lists version ${manifest.version} but the release is ${version}`,
    );
  }
  return manifest.platforms[target]?.checksum ?? null;
}

/**
 * Expected SHA-256 of `omkc-<target>.zip`, preferring the aggregated
 * `manifest.json` asset and falling back to the per-asset `.sha256` file.
 * Throws when the release carries neither — an unverifiable archive is never
 * installed.
 */
export async function resolveExpectedChecksum(
  assets: readonly ReleaseAsset[],
  target: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const manifestAsset = findAsset(assets, NATIVE_MANIFEST_ASSET_NAME);
  if (manifestAsset !== null) {
    const checksum = await checksumFromManifestAsset(fetchImpl, manifestAsset, target, version);
    if (checksum !== null) return checksum;
  }

  const checksumAsset = findAsset(assets, nativeChecksumAssetFileName(target));
  if (checksumAsset !== null) {
    const checksum = parseSha256ChecksumFile(
      await fetchTextWithTimeout(fetchImpl, checksumAsset.url, NATIVE_METADATA_TIMEOUT_MS),
    );
    if (checksum !== null) return checksum;
    throw new Error(`release checksum file ${checksumAsset.name} does not contain a valid sha256`);
  }

  throw new Error(`release carries neither ${NATIVE_MANIFEST_ASSET_NAME} nor a .sha256 for ${target}`);
}

async function fetchBufferWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export interface InstallNativeUpdateParams {
  readonly version: string;
  readonly assets: readonly ReleaseAsset[];
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
  /** Executable to replace; defaults to the running binary (`process.execPath`). */
  readonly executablePath?: string;
  /** Where the archive is downloaded and verified; defaults to `<dataDir>/updates/downloads`. */
  readonly downloadDir?: string;
  readonly downloadTimeoutMs?: number;
}

/**
 * Download, verify, and install the community release for this platform over
 * `executablePath`. Throws on any failure (missing asset, checksum mismatch,
 * archive corruption, replace failure) — callers record the failure and fall
 * back to prompting the user.
 */
export async function installNativeUpdate(params: InstallNativeUpdateParams): Promise<void> {
  const platform = params.platform ?? process.platform;
  const arch = params.arch ?? process.arch;
  const env = params.env ?? process.env;
  const fetchImpl = params.fetchImpl ?? fetch;
  const executablePath = params.executablePath ?? process.execPath;
  const target = nativeTargetTriple(platform, arch, env);
  const assetName = nativeAssetFileName(target);

  const asset = findAsset(params.assets, assetName);
  if (asset === null) {
    const available = params.assets.map((entry) => entry.name).join(', ') || '(none)';
    throw new Error(
      `release has no ${assetName} asset for this platform (target ${target}); available: ${available}`,
    );
  }

  const expectedChecksum = await resolveExpectedChecksum(
    params.assets,
    target,
    params.version,
    fetchImpl,
  );

  const archive = await fetchBufferWithTimeout(
    fetchImpl,
    asset.url,
    params.downloadTimeoutMs ?? NATIVE_DOWNLOAD_TIMEOUT_MS,
  );

  // The archive only exists on disk between download and verification; every
  // exit path (success or failure) removes it again.
  const downloadDir = params.downloadDir ?? getUpdateDownloadsDir();
  await mkdir(downloadDir, { recursive: true });
  const archivePath = join(downloadDir, assetName);
  await writeFile(archivePath, archive);

  try {
    const actualChecksum = sha256Hex(archive);
    if (actualChecksum !== expectedChecksum) {
      throw new Error(
        `sha256 mismatch for ${assetName}: expected ${expectedChecksum}, got ${actualChecksum}`,
      );
    }

    const entryName = nativeExecutableName(platform);
    const entry = readZipEntries(archive).find((candidate) => candidate.name === entryName);
    if (entry === undefined) {
      throw new Error(`${assetName} does not contain a ${entryName} entry`);
    }

    // Stage next to the target so the final rename never crosses filesystems.
    const stagedPath = join(
      dirname(executablePath),
      `.${entryName}.update-${params.version}-${process.pid}.tmp`,
    );
    try {
      await writeFile(stagedPath, entry.data);
      await chmod(stagedPath, 0o755);
      await rename(stagedPath, executablePath);
    } catch (error) {
      await unlink(stagedPath).catch(() => {});
      const detail = error instanceof Error ? error.message : String(error);
      if (platform === 'win32') {
        throw new Error(
          `cannot replace the running executable on Windows (${detail}); ` +
            'download the new release from GitHub Releases manually',
          { cause: error },
        );
      }
      throw new Error(`failed to replace ${executablePath}: ${detail}`, { cause: error });
    }

    await unlink(archivePath).catch(() => {});
  } catch (error) {
    await unlink(archivePath).catch(() => {});
    throw error;
  }
}
