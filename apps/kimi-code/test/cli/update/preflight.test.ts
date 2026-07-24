import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readUpdateCache } from '#/cli/update/cache';
import {
  emptyUpdateInstallState,
  readUpdateInstallState,
  writeUpdateInstallState,
} from '#/cli/update/install-state';
import { installNativeUpdate } from '#/cli/update/native-install';
import {
  canAutoInstall,
  decideUpdateAction,
  runUpdatePreflight,
} from '#/cli/update/preflight';
import { promptForInstallChoice } from '#/cli/update/prompt';
import type * as PromptModule from '#/cli/update/prompt';
import { refreshUpdateCache } from '#/cli/update/refresh';
import type * as RefreshModule from '#/cli/update/refresh';
import { detectInstallSource } from '#/cli/update/source';
import {
  emptyUpdateCache,
  type InstallSource,
  type UpdateCache,
  type UpdateInstallState,
} from '#/cli/update/types';
import type { TuiConfig } from '#/tui/config';

const mocks = vi.hoisted(() => ({
  readUpdateCache: vi.fn(),
  readUpdateInstallState: vi.fn(),
  writeUpdateInstallState: vi.fn(),
  tryAcquireUpdateInstallLock: vi.fn(),
  loadTuiConfig: vi.fn(),
  detectInstallSource: vi.fn(),
  promptForInstallChoice: vi.fn(),
  refreshUpdateCache: vi.fn(),
  installNativeUpdate: vi.fn(),
}));

vi.mock('../../../src/cli/update/cache', () => ({
  readUpdateCache: mocks.readUpdateCache,
}));

vi.mock('../../../src/cli/update/install-lock', () => ({
  tryAcquireUpdateInstallLock: mocks.tryAcquireUpdateInstallLock,
}));

vi.mock('../../../src/cli/update/install-state', () => ({
  emptyUpdateInstallState: () => ({
    active: null,
    lastFailure: null,
    lastSuccess: null,
  }),
  readUpdateInstallState: mocks.readUpdateInstallState,
  writeUpdateInstallState: mocks.writeUpdateInstallState,
}));

vi.mock('../../../src/tui/config', () => ({
  loadTuiConfig: mocks.loadTuiConfig,
}));

vi.mock('../../../src/cli/update/source', () => ({
  detectInstallSource: mocks.detectInstallSource,
}));

vi.mock('../../../src/cli/update/prompt', async () => {
  const actual = await vi.importActual<typeof PromptModule>('../../../src/cli/update/prompt.js');
  return {
    ...actual,
    promptForInstallChoice: mocks.promptForInstallChoice,
  };
});

vi.mock('../../../src/cli/update/refresh', async () => {
  const actual = await vi.importActual<typeof RefreshModule>('../../../src/cli/update/refresh.js');
  return {
    ...actual,
    refreshUpdateCache: mocks.refreshUpdateCache,
  };
});

vi.mock('../../../src/cli/update/native-install', () => ({
  installNativeUpdate: mocks.installNativeUpdate,
}));

function cacheWith(version: string): UpdateCache {
  return {
    source: 'github',
    checkedAt: '2026-04-23T08:00:00.000Z',
    latest: version,
    tag: `oh-my-kimi-code@${version}`,
    releaseUrl: `https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@${version}`,
    assets: [
      { name: 'omkc-linux-x64.zip', url: 'https://dl.example.test/omkc-linux-x64.zip' },
      { name: 'manifest.json', url: 'https://dl.example.test/manifest.json' },
    ],
  };
}

function installState(overrides: Partial<UpdateInstallState> = {}): UpdateInstallState {
  return {
    active: null,
    lastFailure: null,
    lastSuccess: null,
    ...overrides,
  };
}

function tuiConfig(overrides: Partial<TuiConfig> = {}): TuiConfig {
  return {
    theme: 'auto',
    disablePasteBurst: false,
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    upgrade: { autoInstall: true },
    moa: { card: true, statusService: true, statusExport: true },
    ...overrides,
  };
}

function disableAutoInstall(): void {
  mocks.loadTuiConfig.mockResolvedValue(tuiConfig({ upgrade: { autoInstall: false } }));
}

function captureOutput(platform: NodeJS.Platform = 'linux'): {
  stdout: string[];
  stderr: string[];
  options: {
    stdout: { write(chunk: string): boolean };
    stderr: { write(chunk: string): boolean };
    isTTY: boolean;
    platform: NodeJS.Platform;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    options: {
      stdout: { write: (chunk: string) => { stdout.push(chunk); return true; } },
      stderr: { write: (chunk: string) => { stderr.push(chunk); return true; } },
      isTTY: true,
      platform,
    },
  };
}

type TestLogFn = ReturnType<typeof vi.fn<(message: string, payload?: unknown) => void>>;

function captureLogger(): {
  info: TestLogFn;
  warn: TestLogFn;
  error: TestLogFn;
  debug: TestLogFn;
} {
  return {
    info: vi.fn<(message: string, payload?: unknown) => void>(),
    warn: vi.fn<(message: string, payload?: unknown) => void>(),
    error: vi.fn<(message: string, payload?: unknown) => void>(),
    debug: vi.fn<(message: string, payload?: unknown) => void>(),
  };
}

describe('canAutoInstall / decideUpdateAction', () => {
  it('only auto-installs the native executable, and never on Windows', () => {
    const packageSources: InstallSource[] = ['npm-global', 'pnpm-global', 'yarn-global', 'bun-global'];
    for (const source of packageSources) {
      // The community edition is not on the npm registry: no package-manager
      // auto-install, on any platform.
      expect(canAutoInstall(source, 'linux')).toBe(false);
      expect(canAutoInstall(source, 'win32')).toBe(false);
    }
    expect(canAutoInstall('homebrew', 'darwin')).toBe(false);
    expect(canAutoInstall('unsupported', 'linux')).toBe(false);
    expect(canAutoInstall('native', 'linux')).toBe(true);
    expect(canAutoInstall('native', 'darwin')).toBe(true);
    expect(canAutoInstall('native', 'win32')).toBe(false);
  });

  it('routes installable sources to the prompt and the rest to manual instructions', () => {
    expect(decideUpdateAction(null, true, 'native', 'linux')).toBe('none');
    expect(decideUpdateAction({ version: '0.5.0' }, false, 'native', 'linux')).toBe('none');
    expect(decideUpdateAction({ version: '0.5.0' }, true, 'native', 'linux')).toBe('prompt-install');
    expect(decideUpdateAction({ version: '0.5.0' }, true, 'native', 'win32')).toBe('manual-command');
    expect(decideUpdateAction({ version: '0.5.0' }, true, 'npm-global', 'linux')).toBe('manual-command');
  });
});

describe('runUpdatePreflight', () => {
  beforeEach(() => {
    mocks.readUpdateInstallState.mockResolvedValue(emptyUpdateInstallState());
    mocks.writeUpdateInstallState.mockResolvedValue(undefined);
    mocks.loadTuiConfig.mockResolvedValue(tuiConfig());
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue({
      filePath: '/tmp/omkc-update-install.lock',
      release: vi.fn().mockResolvedValue(undefined),
    });
    mocks.installNativeUpdate.mockResolvedValue(undefined);
  });

  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

  it('skips all update work when KIMI_CODE_NO_AUTO_UPDATE is set', async () => {
    vi.stubEnv('KIMI_CODE_NO_AUTO_UPDATE', '1');
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('continue');

    expect(readUpdateCache).not.toHaveBeenCalled();
    expect(refreshUpdateCache).not.toHaveBeenCalled();
    expect(detectInstallSource).not.toHaveBeenCalled();
    expect(installNativeUpdate).not.toHaveBeenCalled();
  });

  it('also honors the legacy KIMI_CLI_NO_AUTO_UPDATE alias', async () => {
    vi.stubEnv('KIMI_CLI_NO_AUTO_UPDATE', 'true');
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('continue');

    expect(readUpdateCache).not.toHaveBeenCalled();
    expect(detectInstallSource).not.toHaveBeenCalled();
  });

  it('starts a background native install from a fresh check when the cache is empty', async () => {
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.detectInstallSource.mockResolvedValue('native');
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('continue');

    await vi.waitFor(() => {
      expect(installNativeUpdate).toHaveBeenCalledWith({
        version: '0.29.0-omkc.2',
        assets: cacheWith('0.29.0-omkc.2').assets,
        platform: 'linux',
      });
    });
    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(writeUpdateInstallState).toHaveBeenCalledWith(expect.objectContaining({
      active: expect.objectContaining({
        version: '0.29.0-omkc.2',
        source: 'native',
        startedAt: expect.any(String),
      }),
      lastFailure: null,
    }));
    await vi.waitFor(() => {
      expect(writeUpdateInstallState).toHaveBeenLastCalledWith(expect.objectContaining({
        active: null,
        lastFailure: null,
        lastSuccess: expect.objectContaining({
          version: '0.29.0-omkc.2',
          installedAt: expect.any(String),
          notifiedAt: null,
        }),
      }));
    });
  });

  it('does not start a fresh-check background install when automatic updates are disabled', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.detectInstallSource.mockResolvedValue('native');
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('continue');
    await vi.waitFor(() => {
      expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
    });

    expect(detectInstallSource).toHaveBeenCalledTimes(1);
    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(installNativeUpdate).not.toHaveBeenCalled();
  });

  it('skips when non-interactive', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    const { options } = captureOutput();

    await expect(
      runUpdatePreflight('0.29.0-omkc.1', { ...options, isTTY: false }),
    ).resolves.toBe('continue');

    expect(detectInstallSource).not.toHaveBeenCalled();
  });

  it('does not start a fresh-check background install when non-interactive', async () => {
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    const { options } = captureOutput();

    await expect(
      runUpdatePreflight('0.29.0-omkc.1', { ...options, isTTY: false }),
    ).resolves.toBe('continue');
    await vi.waitFor(() => {
      expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
    });

    expect(detectInstallSource).not.toHaveBeenCalled();
    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(installNativeUpdate).not.toHaveBeenCalled();
  });

  it('defaults to automatic background updates when client preferences cannot be loaded', async () => {
    mocks.loadTuiConfig.mockRejectedValue(new Error('broken tui.toml'));
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.detectInstallSource.mockResolvedValue('native');
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('continue');

    expect(promptForInstallChoice).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(installNativeUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it('native on win32: prints manual download instructions, never installs', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.detectInstallSource.mockResolvedValue('native');
    const { stdout, options } = captureOutput('win32');

    await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('continue');

    const rendered = stdout.join('');
    expect(rendered).toContain('A newer version of Oh My Kimi Code is available (0.29.0-omkc.1 -> 0.29.0-omkc.2).');
    expect(rendered).toContain('native (windows)');
    expect(rendered).toContain('cannot replace the running Windows executable');
    expect(rendered).toContain(
      'https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@0.29.0-omkc.2',
    );
    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(installNativeUpdate).not.toHaveBeenCalled();
  });

  for (const source of ['npm-global', 'pnpm-global', 'yarn-global', 'bun-global'] as const) {
    it(`${source}: explains the npm package is not published and points at GitHub Releases`, async () => {
      mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
      mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
      mocks.detectInstallSource.mockResolvedValue(source);
      const { stdout, options } = captureOutput();

      await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('continue');

      const rendered = stdout.join('');
      expect(rendered).toContain(`Detected install source: ${source}`);
      expect(rendered).toContain('not published to the npm registry');
      expect(rendered).toContain('Download the new release from GitHub Releases:');
      expect(rendered).toContain(
        'https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@0.29.0-omkc.2',
      );
      expect(promptForInstallChoice).not.toHaveBeenCalled();
      expect(installNativeUpdate).not.toHaveBeenCalled();
    });
  }

  it('homebrew: prints manual instructions without the npm note', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.detectInstallSource.mockResolvedValue('homebrew');
    const { stdout, options } = captureOutput('darwin');

    await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('continue');

    const rendered = stdout.join('');
    expect(rendered).toContain('not distributed through Homebrew');
    expect(rendered).not.toContain('not published to the npm registry');
    expect(rendered).toContain('https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@0.29.0-omkc.2');
  });

  it('unsupported: prints the GitHub Releases link', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.detectInstallSource.mockResolvedValue('unsupported');
    const { stdout, options } = captureOutput();

    await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('continue');

    expect(stdout.join('')).toContain('Download the new release from GitHub Releases:');
    expect(installNativeUpdate).not.toHaveBeenCalled();
  });

  it('native with auto-install disabled: prompts and installs in the foreground when accepted', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.detectInstallSource.mockResolvedValue('native');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    const { stdout, options } = captureOutput('darwin');

    await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('exit');

    expect(mocks.promptForInstallChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        currentVersion: '0.29.0-omkc.1',
        target: { version: '0.29.0-omkc.2' },
        installSource: 'native',
        releaseUrl:
          'https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@0.29.0-omkc.2',
        installSummary: expect.stringMatching(/^Download omkc-darwin-[a-z0-9]+\.zip from GitHub Releases/),
      }),
    );
    expect(installNativeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      version: '0.29.0-omkc.2',
      platform: 'darwin',
    }));
    expect(stdout.join('')).toContain(
      'Updated Oh My Kimi Code to 0.29.0-omkc.2. Restart the CLI to use the new version.',
    );
  });

  it('refreshes a stale cached target before showing the foreground install prompt', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.3'));
    mocks.detectInstallSource.mockResolvedValue('native');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    const { stdout, options } = captureOutput('darwin');

    await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('exit');

    expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(mocks.promptForInstallChoice).toHaveBeenCalledWith(
      expect.objectContaining({ target: { version: '0.29.0-omkc.3' } }),
    );
    expect(installNativeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      version: '0.29.0-omkc.3',
    }));
    expect(stdout.join('')).toContain('Updated Oh My Kimi Code to 0.29.0-omkc.3');
  });

  it('falls back to the cached foreground prompt target when the refresh hangs', async () => {
    vi.useFakeTimers();
    try {
      disableAutoInstall();
      mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
      mocks.refreshUpdateCache.mockReturnValue(new Promise(() => {}));
      mocks.detectInstallSource.mockResolvedValue('native');
      mocks.promptForInstallChoice.mockResolvedValue('skip');
      const { options } = captureOutput('darwin');

      const result = runUpdatePreflight('0.29.0-omkc.1', options);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe('continue');
      expect(mocks.promptForInstallChoice).toHaveBeenCalledWith(
        expect.objectContaining({ target: { version: '0.29.0-omkc.2' } }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('declined install continues without installing', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.detectInstallSource.mockResolvedValue('native');
    mocks.promptForInstallChoice.mockResolvedValue('skip');
    const { options } = captureOutput('darwin');

    await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('continue');

    expect(installNativeUpdate).not.toHaveBeenCalled();
  });

  it('warns and continues when the foreground install fails, without claiming success', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.detectInstallSource.mockResolvedValue('native');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mocks.installNativeUpdate.mockRejectedValue(new Error('sha256 mismatch'));
    const { stdout, stderr, options } = captureOutput('darwin');

    await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('continue');

    expect(stderr.join('')).toContain(
      'warning: failed to install oh-my-kimi-code@0.29.0-omkc.2: sha256 mismatch',
    );
    // A failed install must never print the "Updated …" success line.
    expect(stdout.join('')).not.toContain('Updated Oh My Kimi Code');
  });

  it('records the first background failure silently so the next launch can retry', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.detectInstallSource.mockResolvedValue('native');
    mocks.installNativeUpdate.mockRejectedValue(new Error('network down'));
    const { stderr, options } = captureOutput();

    await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('continue');
    await vi.waitFor(() => {
      expect(writeUpdateInstallState).toHaveBeenLastCalledWith(expect.objectContaining({
        active: null,
        lastFailure: expect.objectContaining({
          version: '0.29.0-omkc.2',
          attempts: 1,
          failedAt: expect.any(String),
        }),
        lastSuccess: null,
      }));
    });

    expect(stderr.join('')).toBe('');
  });

  it('retries the automatic update once after the first background failure', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.readUpdateInstallState.mockResolvedValue(installState({
      lastFailure: {
        version: '0.29.0-omkc.2',
        failedAt: '2026-04-23T08:00:00.000Z',
        attempts: 1,
      },
    }));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.detectInstallSource.mockResolvedValue('native');
    mocks.installNativeUpdate.mockRejectedValue(new Error('network down'));
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('continue');
    await vi.waitFor(() => {
      expect(installNativeUpdate).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(writeUpdateInstallState).toHaveBeenLastCalledWith(expect.objectContaining({
        lastFailure: expect.objectContaining({
          version: '0.29.0-omkc.2',
          attempts: 2,
        }),
      }));
    });
    expect(promptForInstallChoice).not.toHaveBeenCalled();
  });

  it('prompts for manual foreground install after two background failures', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.readUpdateInstallState.mockResolvedValue(installState({
      lastFailure: {
        version: '0.29.0-omkc.2',
        failedAt: '2026-04-23T08:00:00.000Z',
        attempts: 2,
      },
    }));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.detectInstallSource.mockResolvedValue('native');
    mocks.promptForInstallChoice.mockResolvedValue('skip');
    const { options } = captureOutput('darwin');

    await expect(runUpdatePreflight('0.29.0-omkc.1', options)).resolves.toBe('continue');

    expect(promptForInstallChoice).toHaveBeenCalledWith(expect.objectContaining({
      target: { version: '0.29.0-omkc.2' },
      installSource: 'native',
    }));
    expect(installNativeUpdate).not.toHaveBeenCalled();
  });

  it('starts only one background update when two sessions preflight concurrently', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.detectInstallSource.mockResolvedValue('native');
    let acquired = false;
    mocks.tryAcquireUpdateInstallLock.mockImplementation(async () => {
      if (acquired) return null;
      acquired = true;
      return {
        filePath: '/tmp/omkc-update-install.lock',
        release: vi.fn().mockResolvedValue(undefined),
      };
    });
    const first = captureOutput();
    const second = captureOutput();

    await expect(Promise.all([
      runUpdatePreflight('0.29.0-omkc.1', first.options),
      runUpdatePreflight('0.29.0-omkc.1', second.options),
    ])).resolves.toEqual(['continue', 'continue']);

    await vi.waitFor(() => {
      expect(installNativeUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it('shows a one-shot notice after a background update succeeds and the new version starts', async () => {
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.readUpdateInstallState.mockResolvedValue(installState({
      lastSuccess: {
        version: '0.29.0-omkc.2',
        installedAt: '2026-04-23T08:00:00.000Z',
        notifiedAt: null,
      },
    }));
    mocks.refreshUpdateCache.mockResolvedValue(emptyUpdateCache());
    const { stdout, options } = captureOutput();
    const track = vi.fn();
    const logger = captureLogger();

    await expect(
      runUpdatePreflight('0.29.0-omkc.2', { ...options, track, logger }),
    ).resolves.toBe('continue');

    const rendered = stdout.join('');
    expect(rendered).toContain('Oh My Kimi Code updated to v0.29.0-omkc.2');
    expect(rendered).toContain(
      'Release notes: https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@0.29.0-omkc.2',
    );
    expect(track).toHaveBeenCalledWith('update_success_notice_shown', expect.objectContaining({
      version: '0.29.0-omkc.2',
      inferred_from_active: false,
    }));
    expect(logger.info).toHaveBeenCalledWith('background update success notice shown', expect.objectContaining({
      version: '0.29.0-omkc.2',
      inferredFromActive: false,
    }));
    expect(writeUpdateInstallState).toHaveBeenCalledWith(expect.objectContaining({
      lastSuccess: expect.objectContaining({
        version: '0.29.0-omkc.2',
        notifiedAt: expect.any(String),
      }),
    }));
    expect(detectInstallSource).not.toHaveBeenCalled();
  });

  it('infers a background update success notice when the active install version is now running', async () => {
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.readUpdateInstallState.mockResolvedValue(installState({
      active: {
        version: '0.29.0-omkc.2',
        source: 'native',
        startedAt: '2026-04-23T08:00:00.000Z',
      },
    }));
    mocks.refreshUpdateCache.mockResolvedValue(emptyUpdateCache());
    const { stdout, options } = captureOutput();

    await expect(runUpdatePreflight('0.29.0-omkc.2', options)).resolves.toBe('continue');

    expect(stdout.join('')).toContain('Oh My Kimi Code updated to v0.29.0-omkc.2');
    expect(writeUpdateInstallState).toHaveBeenCalledWith(expect.objectContaining({
      active: null,
      lastFailure: null,
      lastSuccess: expect.objectContaining({
        version: '0.29.0-omkc.2',
        notifiedAt: expect.any(String),
      }),
    }));
  });

  it('tracks update_prompted telemetry for both decisions', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.detectInstallSource.mockResolvedValue('native');
    mocks.promptForInstallChoice.mockResolvedValue('skip');
    const { options } = captureOutput('darwin');
    const track = vi.fn();

    await runUpdatePreflight('0.29.0-omkc.1', { ...options, track });

    expect(track).toHaveBeenCalledWith('update_prompted', expect.objectContaining({
      current_version: '0.29.0-omkc.1',
      target_version: '0.29.0-omkc.2',
      decision: 'prompt-install',
      source: 'native',
    }));
  });

  it('tracks background install started/succeeded telemetry', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.29.0-omkc.2'));
    mocks.detectInstallSource.mockResolvedValue('native');
    const { options } = captureOutput();
    const track = vi.fn();
    const logger = captureLogger();

    await expect(runUpdatePreflight('0.29.0-omkc.1', { ...options, track, logger })).resolves.toBe('continue');
    await vi.waitFor(() => {
      expect(track).toHaveBeenCalledWith('update_background_install_succeeded', expect.objectContaining({
        target_version: '0.29.0-omkc.2',
        source: 'native',
      }));
    });
    expect(track).toHaveBeenCalledWith('update_background_install_started', expect.objectContaining({
      current_version: '0.29.0-omkc.1',
      target_version: '0.29.0-omkc.2',
      source: 'native',
    }));
    expect(logger.info).toHaveBeenCalledWith('background update install succeeded', expect.objectContaining({
      targetVersion: '0.29.0-omkc.2',
      source: 'native',
    }));
  });
});
