import { describe, expect, it, vi } from 'vitest';

import { handleUpgrade } from '#/cli/sub/upgrade';
import type { InstallPromptChoiceValue } from '#/cli/update/prompt';
import type { InstallSource, UpdateCache, UpdateTarget } from '#/cli/update/types';

function cacheWith(
  version: string | null,
  overrides: Partial<UpdateCache> = {},
): UpdateCache {
  return {
    source: 'github',
    checkedAt: '2026-04-23T08:00:00.000Z',
    latest: version,
    tag: version === null ? null : `oh-my-kimi-code@${version}`,
    releaseUrl: version === null
      ? null
      : `https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@${version}`,
    assets: version === null
      ? []
      : [{ name: 'omkc-darwin-arm64.zip', url: 'https://dl.example.test/omkc-darwin-arm64.zip' }],
    ...overrides,
  };
}

function captureOutput(): {
  stdout: string[];
  stderr: string[];
  writable: {
    stdout: { write(chunk: string): boolean };
    stderr: { write(chunk: string): boolean };
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writable: {
      stdout: { write: (chunk: string) => { stdout.push(chunk); return true; } },
      stderr: { write: (chunk: string) => { stderr.push(chunk); return true; } },
    },
  };
}

function createDeps(overrides: {
  readonly latest?: string | null;
  readonly cache?: Partial<UpdateCache>;
  readonly source?: InstallSource;
  readonly isInteractive?: boolean;
  readonly promptForInstallChoice?: () => Promise<InstallPromptChoiceValue>;
  readonly installUpdate?: (
    source: InstallSource,
    target: UpdateTarget,
    cache: UpdateCache,
    platform: NodeJS.Platform,
  ) => Promise<void>;
} = {}) {
  const installUpdate =
    overrides.installUpdate ??
    vi.fn<(
      source: InstallSource,
      target: UpdateTarget,
      cache: UpdateCache,
      platform: NodeJS.Platform,
    ) => Promise<void>>().mockResolvedValue(undefined);

  return {
    refreshUpdateCache: vi
      .fn()
      .mockResolvedValue(cacheWith(overrides.latest ?? '0.29.0-omkc.2', overrides.cache)),
    detectInstallSource: vi.fn().mockResolvedValue(overrides.source ?? 'native'),
    promptForInstallChoice:
      overrides.promptForInstallChoice ?? vi.fn().mockResolvedValue('install'),
    installUpdate,
    track: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    platform: 'darwin' as NodeJS.Platform,
    arch: 'arm64',
    isInteractive: overrides.isInteractive ?? true,
  };
}

describe('handleUpgrade', () => {
  it('prompts and installs the native update when the install source supports it', async () => {
    const { stdout, stderr, writable } = captureOutput();
    const deps = createDeps({ latest: '0.29.0-omkc.2', source: 'native' });

    await expect(handleUpgrade('0.29.0-omkc.1', { ...deps, ...writable })).resolves.toBe(0);

    expect(deps.refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(deps.detectInstallSource).toHaveBeenCalledTimes(1);
    const expectedCache = cacheWith('0.29.0-omkc.2');
    expect(deps.promptForInstallChoice).toHaveBeenCalledWith({
      currentVersion: '0.29.0-omkc.1',
      target: { version: '0.29.0-omkc.2' },
      releaseUrl:
        'https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@0.29.0-omkc.2',
      installSummary: 'Download omkc-darwin-arm64.zip from GitHub Releases and replace the current binary',
      installSource: 'native',
    });
    expect(deps.installUpdate).toHaveBeenCalledWith(
      'native',
      { version: '0.29.0-omkc.2' },
      expectedCache,
      'darwin',
    );
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_succeeded', expect.objectContaining({
      target_version: '0.29.0-omkc.2',
      source: 'native',
    }));
    expect(stdout.join('')).toContain('Updated Oh My Kimi Code to 0.29.0-omkc.2');
    expect(stderr.join('')).toBe('');
  });

  it('skips the install when the update prompt is declined', async () => {
    const { stdout, writable } = captureOutput();
    const deps = createDeps({
      latest: '0.29.0-omkc.2',
      source: 'native',
      promptForInstallChoice: vi.fn().mockResolvedValue('skip'),
    });

    await expect(handleUpgrade('0.29.0-omkc.1', { ...deps, ...writable })).resolves.toBe(0);

    expect(deps.promptForInstallChoice).toHaveBeenCalledTimes(1);
    expect(deps.installUpdate).not.toHaveBeenCalled();
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_skipped', expect.objectContaining({
      target_version: '0.29.0-omkc.2',
      source: 'native',
    }));
    expect(stdout.join('')).toBe('');
  });

  it('prints up-to-date status without detecting the install source when no newer version exists', async () => {
    const { stdout, writable } = captureOutput();
    const deps = createDeps({ latest: '0.29.0-omkc.1' });

    await expect(handleUpgrade('0.29.0-omkc.1', { ...deps, ...writable })).resolves.toBe(0);

    expect(deps.detectInstallSource).not.toHaveBeenCalled();
    expect(deps.installUpdate).not.toHaveBeenCalled();
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_no_update', expect.objectContaining({
      current_version: '0.29.0-omkc.1',
    }));
    expect(stdout.join('')).toContain('Oh My Kimi Code is already up to date (v0.29.0-omkc.1).');
  });

  it('prints manual GitHub Releases instructions for npm installs (package not published)', async () => {
    const { stdout, writable } = captureOutput();
    const deps = createDeps({ latest: '0.29.0-omkc.2', source: 'npm-global' });

    await expect(handleUpgrade('0.29.0-omkc.1', { ...deps, ...writable })).resolves.toBe(0);

    expect(deps.installUpdate).not.toHaveBeenCalled();
    expect(deps.promptForInstallChoice).not.toHaveBeenCalled();
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_manual_command', expect.objectContaining({
      target_version: '0.29.0-omkc.2',
      source: 'npm-global',
    }));
    const rendered = stdout.join('');
    expect(rendered).toContain('not published to the npm registry');
    expect(rendered).toContain(
      'Download the new release from GitHub Releases: ' +
      'https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@0.29.0-omkc.2',
    );
  });

  it('prints manual instructions for unsupported sources', async () => {
    const { stdout, writable } = captureOutput();
    const deps = createDeps({ latest: '0.29.0-omkc.2', source: 'unsupported' });

    await expect(handleUpgrade('0.29.0-omkc.1', { ...deps, ...writable })).resolves.toBe(0);

    expect(deps.installUpdate).not.toHaveBeenCalled();
    expect(deps.promptForInstallChoice).not.toHaveBeenCalled();
    expect(stdout.join('')).toContain('Download the new release from GitHub Releases:');
  });

  it('prints manual instructions for native installs on Windows', async () => {
    const { stdout, writable } = captureOutput();
    const deps = createDeps({ latest: '0.29.0-omkc.2', source: 'native' });

    await expect(
      handleUpgrade('0.29.0-omkc.1', { ...deps, ...writable, platform: 'win32' as NodeJS.Platform, arch: 'x64' }),
    ).resolves.toBe(0);

    expect(deps.installUpdate).not.toHaveBeenCalled();
    expect(deps.promptForInstallChoice).not.toHaveBeenCalled();
    expect(stdout.join('')).toContain('cannot replace the running Windows executable');
  });

  it('prints the manual instructions without prompting when not interactive', async () => {
    const { stdout, writable } = captureOutput();
    const deps = createDeps({ latest: '0.29.0-omkc.2', source: 'native', isInteractive: false });

    await expect(handleUpgrade('0.29.0-omkc.1', { ...deps, ...writable })).resolves.toBe(0);

    expect(deps.promptForInstallChoice).not.toHaveBeenCalled();
    expect(deps.installUpdate).not.toHaveBeenCalled();
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_manual_command', expect.objectContaining({
      target_version: '0.29.0-omkc.2',
      source: 'native',
    }));
    expect(stdout.join('')).toContain('Download the new release from GitHub Releases:');
  });

  it('returns a failing exit code when the install fails', async () => {
    const { stderr, writable } = captureOutput();
    const deps = createDeps({
      latest: '0.29.0-omkc.2',
      source: 'native',
      installUpdate: vi.fn().mockRejectedValue(new Error('sha256 mismatch')),
    });

    await expect(handleUpgrade('0.29.0-omkc.1', { ...deps, ...writable })).resolves.toBe(1);

    expect(stderr.join('')).toContain(
      'warning: failed to install oh-my-kimi-code@0.29.0-omkc.2: sha256 mismatch',
    );
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_failed', expect.objectContaining({
      target_version: '0.29.0-omkc.2',
      source: 'native',
      stage: 'install',
    }));
  });

  it('returns a failing exit code when checking the latest release fails', async () => {
    const { stderr, writable } = captureOutput();
    const deps = {
      ...createDeps(),
      refreshUpdateCache: vi.fn().mockRejectedValue(
        new Error('GitHub API rate limit exceeded (60 requests/hour per IP); skipping this update check'),
      ),
    };

    await expect(handleUpgrade('0.29.0-omkc.1', { ...deps, ...writable })).resolves.toBe(1);

    expect(deps.detectInstallSource).not.toHaveBeenCalled();
    expect(deps.installUpdate).not.toHaveBeenCalled();
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_failed', expect.objectContaining({
      current_version: '0.29.0-omkc.1',
      stage: 'refresh',
    }));
    expect(stderr.join('')).toContain('error: failed to check for updates: GitHub API rate limit exceeded');
  });

  it('uses the deterministic release URL when the cache has no release page', async () => {
    const { stdout, writable } = captureOutput();
    const deps = createDeps({
      latest: '0.29.0-omkc.2',
      source: 'native',
      isInteractive: false,
      cache: { releaseUrl: null },
    });

    await expect(handleUpgrade('0.29.0-omkc.1', { ...deps, ...writable })).resolves.toBe(0);

    expect(stdout.join('')).toContain(
      'https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@0.29.0-omkc.2',
    );
  });
});
