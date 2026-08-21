import { spawn } from 'node:child_process';

import { log, type Logger } from '@moonshot-ai/kimi-code-sdk';
import type { TelemetryProperties } from '@moonshot-ai/kimi-telemetry';

import {
  PRODUCT_NAME,
  kimiCodeOfficialInstallUrl,
  nativeInstallCommandUnix,
  nativeInstallCommandWin,
} from '#/constant/app';
import { loadTuiConfig } from '#/tui/config';
import { resolveCommandPath } from '#/utils/process/resolve-command';

import { readUpdateCache } from './cache';
import { releaseNotesUrlForVersion } from './github';
import { tryAcquireUpdateInstallLock } from './install-lock';
import { emptyUpdateInstallState, readUpdateInstallState, writeUpdateInstallState } from './install-state';
import { installNativeUpdate } from './native-install';
import { nativeAssetFileName, nativeTargetTriple } from './native-target';
import {
  promptForInstallChoice,
  type InstallPromptChoiceValue,
  type InstallPromptOptions,
} from './prompt';
import { refreshUpdateCache } from './refresh';
import { selectUpdateTarget } from './select';
import { detectInstallSource } from './source';
import {
  emptyUpdateCache,
  NPM_PACKAGE_NAME,
  type InstallSource,
  type UpdateCache,
  type UpdateDecision,
  type UpdateInstallState,
  type UpdatePreflightResult,
  type UpdateTarget,
} from './types';

export type { UpdatePreflightResult } from './types';

export interface RunUpdatePreflightOptions {
  readonly stdout?: { write(chunk: string): boolean };
  readonly stderr?: { write(chunk: string): boolean };
  readonly isTTY?: boolean;
  readonly track?: (event: string, properties?: TelemetryProperties) => void;
  readonly logger?: UpdateLogger;
  /** Injectable for tests; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

const AUTO_INSTALL_FAILURE_PROMPT_THRESHOLD = 2;
const AUTO_INSTALL_ACTIVE_TTL_MS = 6 * 60 * 60 * 1000;
const USER_VISIBLE_UPDATE_REFRESH_TIMEOUT_MS = 1_000;

type UpdateLogger = Pick<Logger, 'info' | 'warn'>;

function withCmdSuffix(base: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${base}.cmd` : base;
}

function bunCommand(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'bun.exe' : 'bun';
}

export function installCommandFor(
  source: InstallSource,
  version: string,
  platform: NodeJS.Platform,
): string {
  switch (source) {
    case 'npm-global':
      return `npm install -g ${NPM_PACKAGE_NAME}@${version}`;
    case 'pnpm-global':
      return `pnpm add -g ${NPM_PACKAGE_NAME}@${version}`;
    case 'yarn-global':
      return `yarn global add ${NPM_PACKAGE_NAME}@${version}`;
    case 'bun-global':
      return `bun add -g ${NPM_PACKAGE_NAME}@${version}`;
    case 'homebrew':
      return 'brew upgrade kimi-code';
    case 'native':
      return platform === 'win32' ? nativeInstallCommandWin() : nativeInstallCommandUnix();
    case 'unsupported':
      return `npm install -g ${NPM_PACKAGE_NAME}@${version}`;
  }
}

/**
 * Which install sources the community updater can apply on their own.
 *
 * The community edition ships as single-file native executables on GitHub
 * Releases; the npm package name is not published to the registry, so
 * package-manager installs cannot be auto-updated (the old `npm install -g
 * oh-my-kimi-code@latest` would 404) and get manual download instructions
 * instead. Native Windows executables cannot be renamed out of the way
 * while this process holds them open, so win32 stays manual too.
 */
export function canAutoInstall(source: InstallSource, platform: NodeJS.Platform): boolean {
  switch (source) {
    case 'npm-global':
    case 'pnpm-global':
    case 'yarn-global':
    case 'bun-global':
    case 'homebrew':
      return false;
    case 'native':
      return platform !== 'win32';
    case 'unsupported':
      return false;
  }
}

interface SpawnCommand {
  readonly cmd: string;
  readonly args: readonly string[];
}

export function spawnForSource(
  source: InstallSource,
  version: string,
  platform: NodeJS.Platform,
): SpawnCommand {
  switch (source) {
    case 'npm-global':
      return { cmd: withCmdSuffix('npm', platform), args: ['install', '-g', `${NPM_PACKAGE_NAME}@${version}`] };
    case 'pnpm-global':
      return { cmd: withCmdSuffix('pnpm', platform), args: ['add', '-g', `${NPM_PACKAGE_NAME}@${version}`] };
    case 'yarn-global':
      return { cmd: withCmdSuffix('yarn', platform), args: ['global', 'add', `${NPM_PACKAGE_NAME}@${version}`] };
    case 'bun-global':
      return { cmd: bunCommand(platform), args: ['add', '-g', `${NPM_PACKAGE_NAME}@${version}`] };
    case 'homebrew':
      return { cmd: 'brew', args: ['upgrade', 'kimi-code'] };
    case 'native':
      // Native installs self-spawn the hidden downloader sub-command, which
      // stages the binary next to the exe (verified against the release
      // manifest's sha256); the swap happens on the next startup. This
      // replaces the old `curl|bash` / `irm|iex` re-install dance — no shell,
      // no pipeline exit-status loss, no PowerShell dependency on Windows.
      return { cmd: process.execPath, args: ['__update_download', version] };
    case 'unsupported':
      throw new Error('unsupported install source cannot be auto-installed');
  }
}
function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function releaseUrlForCache(cache: UpdateCache, target: UpdateTarget): string {
  return cache.releaseUrl ?? releaseNotesUrlForVersion(target.version);
}

function sourceDescription(source: InstallSource, platform: NodeJS.Platform): string {
  switch (source) {
    case 'npm-global':
    case 'pnpm-global':
    case 'yarn-global':
    case 'bun-global':
      return source;
    case 'homebrew':
      return 'homebrew';
    case 'native':
      return platform === 'win32' ? 'native (windows)' : 'native';
    case 'unsupported':
      return 'unsupported install layout';
  }
}

function manualUpdateNote(source: InstallSource, platform: NodeJS.Platform): string {
  switch (source) {
    case 'npm-global':
    case 'pnpm-global':
    case 'yarn-global':
    case 'bun-global':
      return (
        `The community edition is not published to the npm registry, so it cannot be ` +
        `updated with a package manager.\n`
      );
    case 'homebrew':
      return 'The community edition is not distributed through Homebrew.\n';
    case 'native':
      if (platform === 'win32') {
        return 'Auto-update cannot replace the running Windows executable.\n';
      }
      return '';
    case 'unsupported':
      return '';
  }
}

/**
 * Resolve a spawn target from `spawnForSource` to an absolute executable path
 * via PATH, refusing hits inside the current working directory: the update
 * preflight runs before the workspace trust gate, so a package-manager binary
 * planted in an untrusted workspace must never be executed. On win32 the
 * resolved path is quoted because the spawn goes through cmd.exe (shell:
 * true) and paths like `C:\Program Files\...` would otherwise split. Returns
 * undefined when the command cannot be safely resolved.
 */
function resolveSpawnCommand(cmd: string, platform: NodeJS.Platform): string | undefined {
  const resolved = resolveCommandPath(cmd);
  if (resolved === undefined) return undefined;
  return platform === 'win32' ? `"${resolved}"` : resolved;
}

/**
 * Resolve the spawn target for an install. Package managers are resolved from
 * `PATH` to an absolute executable via `resolveSpawnCommand` (workspace-trust
 * safety, see above). The native self-spawn instead uses `process.execPath`
 * verbatim — already absolute — and never goes through a shell. Returns the
 * shell flag alongside, since Windows package-manager shims (.cmd) still
 * need one.
 */
function resolveInstallSpawn(
  source: InstallSource,
  version: string,
  platform: NodeJS.Platform,
  options?: { readonly manual?: boolean },
): { readonly resolvedCmd: string; readonly args: readonly string[]; readonly shell: boolean } | undefined {
  const { cmd, args } = spawnForSource(source, version, platform);
  if (source === 'native') {
    // A user-confirmed install marks the stage as manual so the startup swap
    // applies it even when automatic updates are opted out via env.
    return { resolvedCmd: cmd, args: options?.manual === true ? [...args, '--manual'] : args, shell: false };
  }
  const resolvedCmd = resolveSpawnCommand(cmd, platform);
  if (resolvedCmd === undefined) return undefined;
  return { resolvedCmd, args, shell: platform === 'win32' };
}

// Built per call: the official-installer URL follows the current region.
export function thirdPartySourceNote(): string {
  return (
    '\nNote: Third-party sources may lag behind the official release.\n' +
    `For the latest updates, use the official installer: ${kimiCodeOfficialInstallUrl()}\n`
  );
}

export function renderManualUpdateMessage(
  currentVersion: string,
  target: UpdateTarget,
  source: InstallSource,
  releaseUrl: string,
  platform: NodeJS.Platform,
): string {
  const note = manualUpdateNote(source, platform);
  return (
    `A newer version of ${PRODUCT_NAME} is available ` +
    `(${currentVersion} -> ${target.version}).\n` +
    `Detected install source: ${sourceDescription(source, platform)}\n` +
    (note.length > 0 ? note : '') +
    `Download the new release from GitHub Releases: ${releaseUrl}\n`
  );
}

export function renderInstallSuccessMessage(target: UpdateTarget): string {
  return `Updated ${PRODUCT_NAME} to ${target.version}. Restart the CLI to use the new version.\n`;
}

function renderBackgroundInstallSuccessNotice(version: string): string {
  const displayVersion = version.startsWith('v') ? version : `v${version}`;
  return `${PRODUCT_NAME} updated to ${displayVersion}\nRelease notes: ${releaseNotesUrlForVersion(version)}\n`;
}

/**
 * Apply an update for an auto-installable source. The community channel only
 * auto-installs the single-file native executable: download the platform
 * archive from the cached release assets, verify its SHA-256, and rename it
 * over the running binary (effective on the next start).
 */
export async function performUpdateInstall(
  source: InstallSource,
  target: UpdateTarget,
  cache: UpdateCache,
  platform: NodeJS.Platform,
): Promise<void> {
  if (source !== 'native') {
    throw new Error(`install source ${source} cannot be auto-installed by the community updater`);
  }
  await installNativeUpdate({ version: target.version, assets: cache.assets, platform });
}

function refreshInBackground(): void {
  void refreshUpdateCache().catch(() => {});
}

function nowIso(): string {
  return new Date().toISOString();
}

function failureAttemptsFor(state: UpdateInstallState, target: UpdateTarget): number {
  return state.lastFailure?.version === target.version ? state.lastFailure.attempts : 0;
}

function hasFreshActiveInstall(state: UpdateInstallState, target: UpdateTarget): boolean {
  const active = state.active;
  if (active === null || active.version !== target.version) return false;
  const startedAt = Date.parse(active.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  return Date.now() - startedAt < AUTO_INSTALL_ACTIVE_TTL_MS;
}

/**
 * A fresh-looking `active` record is not proof of work for native installs:
 * the parent that wrote it may have exited before the spawned downloader's
 * exit event (or the downloader died before doing anything), and the 6 h TTL
 * would then silently block every retry. Past the spawn grace window — the
 * worker needs a moment to self-acquire the lock — lock liveness IS the
 * truth: held ⇒ a download is running; free ⇒ the record is an orphan and
 * the caller may start a new attempt. Package-manager sources have no such
 * liveness signal and keep the TTL behavior above.
 */
const NATIVE_INSTALL_SPAWN_GRACE_MS = 60_000;

async function hasNativeInstallInFlight(
  state: UpdateInstallState,
  target: UpdateTarget,
): Promise<boolean> {
  const active = state.active;
  if (active === null || active.version !== target.version) return false;
  const startedAt = Date.parse(active.startedAt);
  if (Number.isFinite(startedAt) && Date.now() - startedAt < NATIVE_INSTALL_SPAWN_GRACE_MS) {
    return true;
  }
  const probe = await tryAcquireUpdateInstallLock({ version: target.version });
  if (probe === null) return true;
  await probe.release().catch(() => {});
  return false;
}

async function hasInstallInFlight(
  source: InstallSource,
  state: UpdateInstallState,
  target: UpdateTarget,
): Promise<boolean> {
  return source === 'native'
    ? hasNativeInstallInFlight(state, target)
    : hasFreshActiveInstall(state, target);
}

async function showPendingBackgroundInstallNotice(
  state: UpdateInstallState,
  currentVersion: string,
  stdout: { write(chunk: string): boolean },
  track: RunUpdatePreflightOptions['track'],
  logger: UpdateLogger,
): Promise<UpdateInstallState> {
  const success = state.lastSuccess;
  if (success !== null && success.notifiedAt === null && success.version === currentVersion) {
    stdout.write(renderBackgroundInstallSuccessNotice(success.version));
    trackUpdateEvent(track, 'update_success_notice_shown', {
      version: success.version,
      inferred_from_active: false,
    });
    logUpdateInfo(logger, 'background update success notice shown', {
      version: success.version,
      inferredFromActive: false,
    });
    const nextState: UpdateInstallState = {
      ...state,
      active: null,
      lastFailure: null,
      lastSuccess: {
        ...success,
        notifiedAt: nowIso(),
      },
    };
    await writeUpdateInstallState(nextState).catch(() => {});
    return nextState;
  }

  const active = state.active;
  if (active === null || active.version !== currentVersion) return state;
  if (success !== null && success.version === currentVersion && success.notifiedAt !== null) {
    return state;
  }

  const notifiedAt = nowIso();
  stdout.write(renderBackgroundInstallSuccessNotice(active.version));
  trackUpdateEvent(track, 'update_success_notice_shown', {
    version: active.version,
    inferred_from_active: true,
  });
  logUpdateInfo(logger, 'background update success notice shown', {
    version: active.version,
    inferredFromActive: true,
  });
  const nextState: UpdateInstallState = {
    ...state,
    active: null,
    lastFailure: null,
    lastSuccess: {
      version: active.version,
      installedAt: notifiedAt,
      notifiedAt,
    },
  };
  await writeUpdateInstallState(nextState).catch(() => {});
  return nextState;
}

/**
 * `KIMI_CODE_NO_AUTO_UPDATE` (or the legacy `KIMI_CLI_NO_AUTO_UPDATE` alias)
 * fully disables automatic update behavior — no check, no background install,
 * no prompt, and no staged-swap at startup (see `native-swap.ts`). Migrated
 * from kimi-cli, where the variable gated all auto-update behavior. Accepts
 * the usual truthy values (`1`/`true`/`yes`/`on`).
 */
export function isAutoUpdateDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const truthy = (value?: string): boolean =>
    ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
  return truthy(env['KIMI_CODE_NO_AUTO_UPDATE']) || truthy(env['KIMI_CLI_NO_AUTO_UPDATE']);
}

/**
 * The persisted `[upgrade].auto_install` preference (defaults to true when
 * the config cannot be read). Gates the passive background install — and the
 * startup swap of automatically staged payloads (see `native-swap.ts`).
 */
export async function shouldAutoInstallUpdates(): Promise<boolean> {
  try {
    const config = await loadTuiConfig();
    return config.upgrade.autoInstall;
  } catch {
    return true;
  }
}

function trackUpdatePrompted(
  track: RunUpdatePreflightOptions['track'],
  currentVersion: string,
  target: UpdateTarget,
  source: InstallSource,
  decision: UpdateDecision,
): void {
  trackUpdateEvent(track, 'update_prompted', {
    current_version: currentVersion,
    target_version: target.version,
    source,
    decision,
  });
}

function trackUpdateEvent(
  track: RunUpdatePreflightOptions['track'],
  event: string,
  properties: TelemetryProperties,
): void {
  try {
    track?.(event, properties);
  } catch {
    // Telemetry must never affect update prompting.
  }
}

function logUpdateInfo(logger: UpdateLogger, message: string, payload: Record<string, unknown>): void {
  try {
    logger.info(message, payload);
  } catch {
    // Diagnostic logging must never affect update prompting.
  }
}

function logUpdateWarn(logger: UpdateLogger, message: string, payload: Record<string, unknown>): void {
  try {
    logger.warn(message, payload);
  } catch {
    // Diagnostic logging must never affect update prompting.
  }
}

async function promptInstall(
  currentVersion: string,
  target: UpdateTarget,
  cache: UpdateCache,
  source: InstallSource,
  platform: NodeJS.Platform,
): Promise<InstallPromptChoiceValue> {
  const assetName = nativeAssetFileName(nativeTargetTriple(platform, process.arch));
  const options: InstallPromptOptions = {
    currentVersion,
    target,
    installSource: source,
    releaseUrl: releaseUrlForCache(cache, target),
    installSummary: `Download ${assetName} from GitHub Releases and replace the current binary`,
  };
  return promptForInstallChoice(options);
}

export async function installUpdate(
  source: InstallSource,
  version: string,
  platform: NodeJS.Platform,
): Promise<void> {
  // installUpdate only runs after an explicit user choice (the `upgrade`
  // command or the interactive prompt) — mark the stage as manual.
  const spawnTarget = resolveInstallSpawn(source, version, platform, { manual: true });
  if (spawnTarget === undefined) {
    throw new Error(
      `${spawnForSource(source, version, platform).cmd} was not found in PATH; cannot install the update`,
    );
  }
  await new Promise<void>((resolve, reject) => {
    // Windows package managers (npm/pnpm/yarn) are .cmd shims. Since the
    // CVE-2024-27980 fix, Node throws EINVAL when spawning a .cmd/.bat without
    // a shell, so run through the shell on win32. The version is a validated
    // semver and the package name is a constant, so args are shell-safe. The
    // native self-spawn is an .exe and needs no shell.
    const child = spawn(spawnTarget.resolvedCmd, [...spawnTarget.args], {
      stdio: 'inherit',
      shell: spawnTarget.shell ? true : undefined,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = signal !== null ? `signal ${signal}` : `code ${String(code)}`;
      reject(new Error(`update install exited with ${detail}`));
    });
  });
}

async function startBackgroundInstall(
  state: UpdateInstallState,
  currentVersion: string,
  target: UpdateTarget,
  cache: UpdateCache,
  source: InstallSource,
  platform: NodeJS.Platform,
  track: RunUpdatePreflightOptions['track'],
  logger: UpdateLogger,
): Promise<void> {
  // The community edition installs the native update synchronously (no
  // self-spawned downloader child), so the outer install lock must be held for
  // the whole download+replace — it is the only thing that stops two
  // concurrently preflighting sessions from double-installing. Package-manager
  // installs use the same lock, which guards against duplicate spawns.
  const lock = await tryAcquireUpdateInstallLock({ version: target.version });
  if (lock === null) return;

  try {
    const freshState = await readUpdateInstallState().catch(() => state);
    if (
      failureAttemptsFor(freshState, target) >= AUTO_INSTALL_FAILURE_PROMPT_THRESHOLD
    ) {
      return;
    }

    const startedState: UpdateInstallState = {
      ...freshState,
      active: {
        version: target.version,
        source,
        startedAt: nowIso(),
      },
    };
    await writeUpdateInstallState(startedState);
    trackUpdateEvent(track, 'update_background_install_started', {
      current_version: currentVersion,
      target_version: target.version,
      source,
    });
    logUpdateInfo(logger, 'background update install started', {
      currentVersion,
      targetVersion: target.version,
      source,
    });

    const attempts = failureAttemptsFor(startedState, target) + 1;
    let succeeded = false;
    try {
      await performUpdateInstall(source, target, cache, platform);
      succeeded = true;
    } catch {
      succeeded = false;
    }

    const nextState: UpdateInstallState = succeeded
      ? {
        ...startedState,
        active: null,
        lastFailure: null,
        lastSuccess: {
          version: target.version,
          installedAt: nowIso(),
          notifiedAt: null,
        },
      }
      : {
        ...startedState,
        active: null,
        lastFailure: {
          version: target.version,
          failedAt: nowIso(),
          attempts,
        },
      };
    await writeUpdateInstallState(nextState).catch(() => {});
    if (succeeded) {
      trackUpdateEvent(track, 'update_background_install_succeeded', {
        target_version: target.version,
        source,
      });
      logUpdateInfo(logger, 'background update install succeeded', {
        targetVersion: target.version,
        source,
      });
      return;
    }
    trackUpdateEvent(track, 'update_background_install_failed', {
      target_version: target.version,
      source,
      attempts,
    });
    logUpdateWarn(logger, 'background update install failed', {
      targetVersion: target.version,
      source,
      attempts,
    });
  } finally {
    await lock.release().catch(() => {});
  }
}

function refreshAndMaybeInstallInBackground(
  currentVersion: string,
  isInteractive: boolean,
  installState: UpdateInstallState,
  platform: NodeJS.Platform,
  track: RunUpdatePreflightOptions['track'],
  logger: UpdateLogger,
): void {
  void (async () => {
    const refreshed = await refreshUpdateCache();
    if (!isInteractive) return;
    const target = selectUpdateTarget(currentVersion, refreshed.latest);
    if (target === null) return;
    const source = await detectInstallSource().catch(() => 'unsupported' as const);
    await tryStartAutomaticBackgroundInstall(
      installState,
      currentVersion,
      target,
      refreshed,
      source,
      platform,
      track,
      logger,
    );
  })().catch(() => {});
}

interface UserVisibleUpdate {
  readonly target: UpdateTarget | null;
  readonly cache: UpdateCache;
}

/**
 * Re-check the release feed (1s budget) before showing anything to the user,
 * falling back to the cached target when the check hangs or fails — e.g. a
 * rate-limited GitHub API check must never stall the prompt.
 */
async function refreshUserVisibleUpdateTarget(
  currentVersion: string,
  fallbackTarget: UpdateTarget,
  fallbackCache: UpdateCache,
): Promise<UserVisibleUpdate> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const fallback: UserVisibleUpdate = {
    target: fallbackTarget,
    cache: fallbackCache,
  };
  try {
    const refresh = refreshUpdateCache()
      .then((refreshed) => ({
        target: selectUpdateTarget(currentVersion, refreshed.latest),
        cache: refreshed,
      }))
      .catch(() => fallback);
    const timeoutFallback = new Promise<UserVisibleUpdate>((resolve) => {
      timeout = setTimeout(() => {
        resolve(fallback);
      }, USER_VISIBLE_UPDATE_REFRESH_TIMEOUT_MS);
    });
    return await Promise.race([refresh, timeoutFallback]);
  } catch {
    return fallback;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function tryStartAutomaticBackgroundInstall(
  installState: UpdateInstallState,
  currentVersion: string,
  target: UpdateTarget,
  cache: UpdateCache,
  source: InstallSource,
  platform: NodeJS.Platform,
  track: RunUpdatePreflightOptions['track'],
  logger: UpdateLogger,
): Promise<boolean> {
  const sourceCanAutoInstall = canAutoInstall(source, platform);
  const autoInstallUpdates = sourceCanAutoInstall ? await shouldAutoInstallUpdates() : false;
  if (!autoInstallUpdates || !sourceCanAutoInstall) return false;
  if (failureAttemptsFor(installState, target) >= AUTO_INSTALL_FAILURE_PROMPT_THRESHOLD) {
    return false;
  }
  if (!(await hasInstallInFlight(source, installState, target))) {
    await startBackgroundInstall(
      installState,
      currentVersion,
      target,
      cache,
      source,
      platform,
      track,
      logger,
    ).catch(() => {});
  }
  return true;
}

export function decideUpdateAction(
  target: UpdateTarget | null,
  isInteractive: boolean,
  source: InstallSource,
  platform: NodeJS.Platform,
): UpdateDecision {
  if (target === null || !isInteractive) return 'none';
  return canAutoInstall(source, platform) ? 'prompt-install' : 'manual-command';
}

export async function runUpdatePreflight(
  currentVersion: string,
  options: RunUpdatePreflightOptions = {},
): Promise<UpdatePreflightResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const logger = options.logger ?? log;
  const platform = options.platform ?? process.platform;

  if (isAutoUpdateDisabledByEnv()) {
    return 'continue';
  }

  try {
    const isInteractive =
      options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
    let installState = await readUpdateInstallState().catch(() => emptyUpdateInstallState());
    if (isInteractive) {
      installState = await showPendingBackgroundInstallNotice(
        installState,
        currentVersion,
        stdout,
        options.track,
        logger,
      );
    }

    const cache = await readUpdateCache().catch(() => emptyUpdateCache());
    const target = selectUpdateTarget(currentVersion, cache.latest);
    if (target === null) {
      refreshAndMaybeInstallInBackground(
        currentVersion,
        isInteractive,
        installState,
        platform,
        options.track,
        logger,
      );
      return 'continue';
    }

    const source: InstallSource =
      !isInteractive
        ? 'unsupported'
        : await detectInstallSource().catch(() => 'unsupported' as const);

    const decision = decideUpdateAction(target, isInteractive, source, platform);
    if (decision === 'none') {
      refreshInBackground();
      return 'continue';
    }

    if (
      await tryStartAutomaticBackgroundInstall(
        installState,
        currentVersion,
        target,
        cache,
        source,
        platform,
        options.track,
        logger,
      )
    ) {
      refreshInBackground();
      return 'continue';
    }

    const userVisibleUpdate = await refreshUserVisibleUpdateTarget(currentVersion, target, cache);
    const userVisibleTarget = userVisibleUpdate.target;
    if (userVisibleTarget === null) return 'continue';
    if (
      await tryStartAutomaticBackgroundInstall(
        installState,
        currentVersion,
        userVisibleTarget,
        userVisibleUpdate.cache,
        source,
        platform,
        options.track,
        logger,
      )
    ) {
      return 'continue';
    }

    trackUpdatePrompted(options.track, currentVersion, userVisibleTarget, source, decision);

    if (decision === 'manual-command') {
      stdout.write(renderManualUpdateMessage(
        currentVersion,
        userVisibleTarget,
        source,
        releaseUrlForCache(userVisibleUpdate.cache, userVisibleTarget),
        platform,
      ));
      return 'continue';
    }

    const choice = await promptInstall(
      currentVersion,
      userVisibleTarget,
      userVisibleUpdate.cache,
      source,
      platform,
    );
    if (choice === 'skip') return 'continue';

    try {
      await performUpdateInstall(source, userVisibleTarget, userVisibleUpdate.cache, platform);
      stdout.write(renderInstallSuccessMessage(userVisibleTarget));
      return 'exit';
    } catch (error) {
      stderr.write(
        `warning: failed to install ${NPM_PACKAGE_NAME}@${userVisibleTarget.version}: ` +
          `${formatErrorMessage(error)}\n`,
      );
      return 'continue';
    }
  } catch {
    return 'continue';
  }
}
