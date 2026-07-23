import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emptyUpdateInstallState,
  readUpdateInstallState,
  writeUpdateInstallState,
} from '#/cli/update/install-state';
import { readUpdateCache, writeUpdateCache } from '#/cli/update/cache';
import { emptyUpdateCache, type UpdateInstallState } from '#/cli/update/types';
import { getUpdateInstallStateFile, getUpdateStateFile } from '#/utils/paths';

const originalEnv = { ...process.env };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kimi-update-cache-'));
  process.env['KIMI_CODE_HOME'] = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe('update cache', () => {
  it('returns an empty cache when the file is missing', async () => {
    await expect(readUpdateCache()).resolves.toEqual(emptyUpdateCache());
  });

  it('falls back to an empty cache when the file is corrupt', async () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(getUpdateStateFile(), '{"broken"', 'utf-8');
    await expect(readUpdateCache()).resolves.toEqual(emptyUpdateCache());
  });

  it('falls back to an empty cache for a legacy CDN-channel cache file', async () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(
      getUpdateStateFile(),
      JSON.stringify({
        source: 'cdn',
        checkedAt: '2026-04-23T08:00:00.000Z',
        latest: '0.5.0',
        manifest: null,
      }),
      'utf-8',
    );
    await expect(readUpdateCache()).resolves.toEqual(emptyUpdateCache());
  });

  it('writes and reads back the cache from updates/latest.json', async () => {
    const cache = {
      source: 'github',
      checkedAt: '2026-04-23T08:00:00.000Z',
      latest: '0.29.0-omkc.2',
      tag: 'oh-my-kimi-code@0.29.0-omkc.2',
      releaseUrl:
        'https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@0.29.0-omkc.2',
      assets: [
        {
          name: 'omkc-linux-x64.zip',
          url: 'https://github.com/Yorha9e/oh-my-kimi-code/releases/download/oh-my-kimi-code@0.29.0-omkc.2/omkc-linux-x64.zip',
        },
      ],
    } as const;

    await writeUpdateCache(cache);

    expect(getUpdateStateFile()).toBe(join(dir, 'updates', 'latest.json'));
    await expect(readUpdateCache()).resolves.toEqual(cache);
  });

  it('keeps a known latest and drops malformed asset entries', async () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(
      getUpdateStateFile(),
      JSON.stringify({
        source: 'github',
        checkedAt: '2026-04-23T08:00:00.000Z',
        latest: '0.5.0',
        tag: 'oh-my-kimi-code@0.5.0',
        releaseUrl: 'https://example.test/releases/1',
        assets: [
          { name: 'omkc-linux-x64.zip', url: 'https://example.test/zip' },
          { name: '', url: 'https://example.test/bad-name' },
          { name: 'manifest.json' },
          'garbage',
        ],
      }),
      'utf-8',
    );

    await expect(readUpdateCache()).resolves.toEqual({
      source: 'github',
      checkedAt: '2026-04-23T08:00:00.000Z',
      latest: '0.5.0',
      tag: 'oh-my-kimi-code@0.5.0',
      releaseUrl: 'https://example.test/releases/1',
      assets: [{ name: 'omkc-linux-x64.zip', url: 'https://example.test/zip' }],
    });
  });

  it('treats a missing assets field as an empty asset list', async () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(
      getUpdateStateFile(),
      JSON.stringify({
        source: 'github',
        checkedAt: '2026-04-23T08:00:00.000Z',
        latest: '0.5.0',
        tag: 'oh-my-kimi-code@0.5.0',
        releaseUrl: 'https://example.test/releases/1',
      }),
      'utf-8',
    );

    await expect(readUpdateCache()).resolves.toMatchObject({
      latest: '0.5.0',
      assets: [],
    });
  });
});

describe('update install state', () => {
  it('returns an empty install state when the file is missing', async () => {
    await expect(readUpdateInstallState()).resolves.toEqual(emptyUpdateInstallState());
  });

  it('falls back to an empty install state when the file is corrupt', async () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(getUpdateInstallStateFile(), '{"broken"', 'utf-8');
    await expect(readUpdateInstallState()).resolves.toEqual(emptyUpdateInstallState());
  });

  it('writes and reads back the install state from updates/install.json', async () => {
    const state: UpdateInstallState = {
      active: {
        version: '0.5.0',
        source: 'native',
        startedAt: '2026-04-23T08:00:00.000Z',
      },
      lastFailure: {
        version: '0.4.0',
        failedAt: '2026-04-22T08:00:00.000Z',
        attempts: 1,
      },
      lastSuccess: {
        version: '0.3.0',
        installedAt: '2026-04-21T08:00:00.000Z',
        notifiedAt: null,
      },
    };

    await writeUpdateInstallState(state);

    expect(getUpdateInstallStateFile()).toBe(join(dir, 'updates', 'install.json'));
    await expect(readUpdateInstallState()).resolves.toEqual(state);
  });
});
