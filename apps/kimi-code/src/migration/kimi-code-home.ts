/**
 * First-run home migration: copy user data from the official kimi-code home
 * (`~/.kimi-code`) into the omkc home (default `~/.omkc`).
 *
 * Trigger: the source home exists, the resolved omkc home has no
 * `.migrated-from-kimi-code` marker, and the source home carries no
 * `.skip-migration-to-omkc` user opt-out marker. The copy never overwrites
 * existing target files, never moves anything (official kimi keeps working),
 * and never blocks startup — the caller wraps this in a best-effort path.
 *
 * Deliberately NOT copied: `device_id` (omkc generates its own device
 * identity), `server.token`, `server/`, `updates/`, `cache/`, `telemetry/`,
 * `logs/`, `bin/kimi.exe*`, `skills_backup_*` (manual user backups).
 *
 * `session_index.jsonl` is rewritten line by line: each entry's `sessionDir`
 * prefix is repointed from the source home to the target home; unparseable
 * lines are dropped and counted. Per-session `state.json` `homedir` fields
 * are NOT rewritten — v2 ignores them and v1 only uses them as a display
 * hint; documented here so the choice is explicit.
 *
 * Sync mode (`runHomeSync` / `syncKimiCodeHome`, exposed as the
 * `/sync-from-kimi` slash command) reuses the same allowlist but is
 * re-runnable: it does not read or write the `.migrated-from-kimi-code`
 * marker, and every file is reconciled by mtime — missing target files are
 * copied, a newer source overwrites the target (temp file + rename), a newer
 * target is kept as-is (counted separately). `session_index.jsonl` is merged
 * (existing target lines kept verbatim, source lines imported with the same
 * `sessionDir` rewrite, deduplicated by `sessionId`). Files being written by
 * a running official kimi (mtime after the sync start) are skipped, and any
 * per-file failure degrades to a warning instead of aborting the run.
 */

import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';

import { KIMI_CODE_LEGACY_DATA_DIR_NAME } from '#/constant/app';

/** Written into the target home on success; presence suppresses re-runs. */
export const MIGRATED_MARKER_FILE = '.migrated-from-kimi-code';
/** User opt-out: place this file in `~/.kimi-code` to never be migrated. */
export const SKIP_MARKER_FILE = '.skip-migration-to-omkc';

/** Plain files copied verbatim when present. */
const COPY_FILES = [
  'config.toml',
  'tui.toml',
  'mcp.json',
  'workspaces.json',
  'migrations-effort.json',
] as const;

/** Directories copied recursively when present. */
const COPY_DIRS = ['credentials', 'skills', 'plugins', 'themes', 'user-history'] as const;

/** Managed tool binaries worth carrying over (whichever exist). */
const COPY_BIN_FILES = ['rg', 'fd', 'rg.exe', 'fd.exe', 'moa-card.exe'] as const;

export interface HomeMigrationSummary {
  copiedFiles: number;
  /** Target file already existed — left untouched. */
  skippedExisting: number;
  /** Source file mtime was later than the migration start (live write). */
  skippedFresh: number;
  sessionIndexRewritten: number;
  sessionIndexBadLines: number;
}

export interface MigrateKimiCodeHomeInput {
  readonly sourceHome: string;
  readonly targetHome: string;
  /** Progress output; defaults to stderr lines. */
  readonly log?: (msg: string) => void;
  /** Migration start time (ms); sessions files newer than this are skipped. */
  readonly startedAtMs?: number;
}

function defaultLog(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/**
 * Copy the allowlisted user data from `sourceHome` to `targetHome`. Pure
 * copy — the source is never modified. Never overwrites existing target
 * files.
 */
export async function migrateKimiCodeHome(
  input: MigrateKimiCodeHomeInput,
): Promise<HomeMigrationSummary> {
  const log = input.log ?? defaultLog;
  const startedAtMs = input.startedAtMs ?? Date.now();
  const summary: HomeMigrationSummary = {
    copiedFiles: 0,
    skippedExisting: 0,
    skippedFresh: 0,
    sessionIndexRewritten: 0,
    sessionIndexBadLines: 0,
  };

  log(`[omkc] migrating data from ${input.sourceHome} to ${input.targetHome} ...`);

  await mkdir(input.targetHome, { recursive: true, mode: 0o700 });

  for (const name of COPY_FILES) {
    await copyFileNoOverwrite(join(input.sourceHome, name), join(input.targetHome, name), summary);
  }
  log('[omkc] migration: config files done');

  for (const name of COPY_DIRS) {
    await copyDirRecursive(join(input.sourceHome, name), join(input.targetHome, name), summary);
  }
  log('[omkc] migration: credentials/skills/plugins/themes/user-history done');

  // Sessions: large tree, streamed; files being written right now by a
  // running official kimi (mtime after the migration start) are skipped.
  await copyDirRecursive(
    join(input.sourceHome, 'sessions'),
    join(input.targetHome, 'sessions'),
    summary,
    startedAtMs,
  );
  log('[omkc] migration: sessions done');

  for (const name of COPY_BIN_FILES) {
    await copyFileNoOverwrite(
      join(input.sourceHome, 'bin', name),
      join(input.targetHome, 'bin', name),
      summary,
    );
  }

  await copySessionIndex(
    join(input.sourceHome, 'session_index.jsonl'),
    join(input.targetHome, 'session_index.jsonl'),
    input.sourceHome,
    input.targetHome,
    summary,
  );
  log('[omkc] migration: session index done');

  return summary;
}

/** Marker payload persisted at `<targetHome>/.migrated-from-kimi-code`. */
export interface MigrationMarker {
  readonly migratedAt: string;
  readonly sourceHome: string;
  readonly targetHome: string;
  readonly summary: HomeMigrationSummary;
}

export async function writeMigrationMarker(
  targetHome: string,
  marker: MigrationMarker,
): Promise<void> {
  await mkdir(targetHome, { recursive: true, mode: 0o700 });
  await writeFile(join(targetHome, MIGRATED_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/**
 * Best-effort entry point mounted at CLI startup. Resolves the real homes,
 * checks the trigger conditions, runs the copy, writes the marker, and
 * swallows every failure as a one-line stderr warning — a failed migration
 * must never block startup (worst case the user logs in again).
 */
export async function runFirstRunHomeMigration(input?: {
  readonly sourceHome?: string;
  readonly targetHome?: string;
  readonly log?: (msg: string) => void;
}): Promise<void> {
  const log = input?.log ?? defaultLog;
  try {
    const targetHome = input?.targetHome ?? resolveKimiHome();
    const sourceHome = input?.sourceHome ?? join(homedir(), KIMI_CODE_LEGACY_DATA_DIR_NAME);

    if (samePath(sourceHome, targetHome)) return;
    if (!existsSync(sourceHome)) return;
    if (existsSync(join(targetHome, MIGRATED_MARKER_FILE))) return;
    if (existsSync(join(sourceHome, SKIP_MARKER_FILE))) return;

    const summary = await migrateKimiCodeHome({ sourceHome, targetHome, log });
    await writeMigrationMarker(targetHome, {
      migratedAt: new Date().toISOString(),
      sourceHome,
      targetHome,
      summary,
    });
    log(
      `[omkc] migration complete: ${summary.copiedFiles} files copied` +
        ` (${summary.skippedExisting} already existed, ${summary.skippedFresh} skipped as in-flight)` +
        `; session index: ${summary.sessionIndexRewritten} rewritten, ${summary.sessionIndexBadLines} bad lines dropped.`,
    );
  } catch (error) {
    log(
      `[omkc] warning: migration from ~/.kimi-code failed (${formatError(error)}); continuing without migrated data.`,
    );
  }
}

function samePath(a: string, b: string): boolean {
  const na = resolve(a);
  const nb = resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function copyFileNoOverwrite(
  src: string,
  dst: string,
  summary: HomeMigrationSummary,
): Promise<void> {
  if (!existsSync(src)) return;
  if (existsSync(dst)) {
    summary.skippedExisting++;
    return;
  }
  await mkdir(dirname(dst), { recursive: true });
  try {
    // 'wx' fails if the destination appeared between the check and the open.
    await pipeline(createReadStream(src), createWriteStream(dst, { flags: 'wx' }));
    summary.copiedFiles++;
  } catch (error) {
    if (isExistsError(error)) {
      summary.skippedExisting++;
      return;
    }
    throw error;
  }
}

async function copyDirRecursive(
  srcDir: string,
  dstDir: string,
  summary: HomeMigrationSummary,
  freshCutoffMs?: number,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(srcDir, { withFileTypes: true });
  } catch {
    return; // missing or unreadable source dir — nothing to copy
  }
  for (const entry of entries) {
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(src, dst, summary, freshCutoffMs);
      continue;
    }
    if (!entry.isFile()) continue; // symlinks and special files are not copied
    if (freshCutoffMs !== undefined) {
      const st = await stat(src);
      if (st.mtimeMs > freshCutoffMs) {
        summary.skippedFresh++;
        continue;
      }
    }
    await copyFileNoOverwrite(src, dst, summary);
  }
}

async function copySessionIndex(
  src: string,
  dst: string,
  sourceHome: string,
  targetHome: string,
  summary: HomeMigrationSummary,
): Promise<void> {
  if (!existsSync(src)) return;
  if (existsSync(dst)) {
    summary.skippedExisting++;
    return;
  }
  const text = await readFile(src, 'utf-8');
  const outLines: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      summary.sessionIndexBadLines++;
      continue;
    }
    if (typeof entry === 'object' && entry !== null) {
      const record = entry as Record<string, unknown>;
      if (typeof record['sessionDir'] === 'string') {
        const rewritten = rewriteSessionDir(record['sessionDir'], sourceHome, targetHome);
        if (rewritten !== record['sessionDir']) {
          record['sessionDir'] = rewritten;
          summary.sessionIndexRewritten++;
        }
      }
    }
    outLines.push(JSON.stringify(entry));
  }
  await mkdir(dirname(dst), { recursive: true });
  await writeFile(dst, outLines.length > 0 ? `${outLines.join('\n')}\n` : '', {
    encoding: 'utf-8',
    flag: 'wx',
  });
  summary.copiedFiles++;
}

/** Repoint a `sessionDir` from the source home to the target home. */
export function rewriteSessionDir(
  sessionDir: string,
  sourceHome: string,
  targetHome: string,
): string {
  const normDir = sessionDir.replaceAll('\\', '/');
  const normSrc = sourceHome.replaceAll('\\', '/').replace(/\/+$/, '');
  if (normDir === normSrc || normDir.startsWith(`${normSrc}/`)) {
    const suffix = normDir.slice(normSrc.length);
    return sessionDir.includes('\\')
      ? `${targetHome}${suffix.replaceAll('/', '\\')}`
      : `${targetHome}${suffix}`;
  }
  // Fallback for entries recorded under a different spelling of the old
  // home: rewrite the `.kimi-code` path segment itself.
  return sessionDir.replace(/([/\\])\.kimi-code([/\\])/, '$1.omkc$2');
}

function isExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'EEXIST'
  );
}

// ---------------------------------------------------------------------------
// Incremental sync (`/sync-from-kimi`) — re-runnable, mtime-based reconciliation
// ---------------------------------------------------------------------------

export interface HomeSyncSummary {
  /** Target file did not exist — copied from the source. */
  copiedFiles: number;
  /** Source file newer than the target — target overwritten. */
  updatedFiles: number;
  /** Source and target mtimes equal — already in sync. */
  skippedFiles: number;
  /** Target file newer than the source — omkc's copy kept as-is. */
  keptNewerFiles: number;
  /** Source file mtime was later than the sync start (live write). */
  skippedFresh: number;
  /** Lines imported from the official session index into omkc's index. */
  sessionIndexImported: number;
  /** Unparseable lines dropped from the official session index. */
  sessionIndexBadLines: number;
}

export interface SyncKimiCodeHomeInput {
  readonly sourceHome: string;
  readonly targetHome: string;
  /** Progress output; defaults to stderr lines. */
  readonly log?: (msg: string) => void;
  /** Sync start time (ms); source files newer than this are skipped. */
  readonly startedAtMs?: number;
}

/**
 * Reconcile the allowlisted user data from `sourceHome` into `targetHome`
 * file by file: missing targets are copied, a newer source mtime overwrites
 * the target, a newer target mtime wins (kept as-is). Pure sync — the source
 * is never modified, and per-file failures are logged and skipped rather
 * than thrown. The allowlist (and therefore the exclusion list) is the same
 * as the first-run migration.
 */
export async function syncKimiCodeHome(
  input: SyncKimiCodeHomeInput,
): Promise<HomeSyncSummary> {
  const log = input.log ?? defaultLog;
  const startedAtMs = input.startedAtMs ?? Date.now();
  const summary: HomeSyncSummary = {
    copiedFiles: 0,
    updatedFiles: 0,
    skippedFiles: 0,
    keptNewerFiles: 0,
    skippedFresh: 0,
    sessionIndexImported: 0,
    sessionIndexBadLines: 0,
  };

  log(`[omkc] syncing data from ${input.sourceHome} to ${input.targetHome} ...`);

  await mkdir(input.targetHome, { recursive: true, mode: 0o700 });

  for (const name of COPY_FILES) {
    await syncFileIncremental(
      join(input.sourceHome, name),
      join(input.targetHome, name),
      summary,
      log,
      startedAtMs,
    );
  }
  log('[omkc] sync: config files done');

  for (const name of COPY_DIRS) {
    await syncDirRecursive(
      join(input.sourceHome, name),
      join(input.targetHome, name),
      summary,
      log,
      startedAtMs,
    );
  }
  log('[omkc] sync: credentials/skills/plugins/themes/user-history done');

  await syncDirRecursive(
    join(input.sourceHome, 'sessions'),
    join(input.targetHome, 'sessions'),
    summary,
    log,
    startedAtMs,
  );
  log('[omkc] sync: sessions done');

  for (const name of COPY_BIN_FILES) {
    await syncFileIncremental(
      join(input.sourceHome, 'bin', name),
      join(input.targetHome, 'bin', name),
      summary,
      log,
      startedAtMs,
    );
  }

  await mergeSessionIndex(
    join(input.sourceHome, 'session_index.jsonl'),
    join(input.targetHome, 'session_index.jsonl'),
    input.sourceHome,
    input.targetHome,
    summary,
    log,
  );
  log('[omkc] sync: session index done');

  return summary;
}

/** Result of a `/sync-from-kimi` run; the caller renders a message per kind. */
export type HomeSyncOutcome =
  | {
      readonly kind: 'synced';
      readonly sourceHome: string;
      readonly targetHome: string;
      readonly summary: HomeSyncSummary;
    }
  | { readonly kind: 'missing-source'; readonly sourceHome: string }
  | { readonly kind: 'same-home'; readonly home: string }
  | { readonly kind: 'skipped-by-marker'; readonly sourceHome: string }
  | { readonly kind: 'failed'; readonly error: string };

/**
 * Best-effort entry point behind the `/sync-from-kimi` slash command. Unlike
 * `runFirstRunHomeMigration` it never consults or writes the migration
 * marker, so it can run any number of times; it still honors the source-side
 * `.skip-migration-to-omkc` opt-out and the source≠target guard, and never
 * throws — unexpected failures come back as a `failed` outcome.
 */
export async function runHomeSync(input?: {
  readonly sourceHome?: string;
  readonly targetHome?: string;
  readonly log?: (msg: string) => void;
  readonly startedAtMs?: number;
}): Promise<HomeSyncOutcome> {
  const log = input?.log ?? defaultLog;
  try {
    const targetHome = input?.targetHome ?? resolveKimiHome();
    const sourceHome = input?.sourceHome ?? join(homedir(), KIMI_CODE_LEGACY_DATA_DIR_NAME);

    if (samePath(sourceHome, targetHome)) return { kind: 'same-home', home: sourceHome };
    if (!existsSync(sourceHome)) return { kind: 'missing-source', sourceHome };
    if (existsSync(join(sourceHome, SKIP_MARKER_FILE))) {
      return { kind: 'skipped-by-marker', sourceHome };
    }

    const summary = await syncKimiCodeHome({
      sourceHome,
      targetHome,
      log,
      startedAtMs: input?.startedAtMs,
    });
    return { kind: 'synced', sourceHome, targetHome, summary };
  } catch (error) {
    const message = formatError(error);
    log(`[omkc] warning: sync from ~/.kimi-code failed (${message}); some data may not have synced.`);
    return { kind: 'failed', error: message };
  }
}

async function syncFileIncremental(
  src: string,
  dst: string,
  summary: HomeSyncSummary,
  log: (msg: string) => void,
  freshCutoffMs: number,
): Promise<void> {
  try {
    if (!existsSync(src)) return;
    const srcStat = await stat(src);
    if (srcStat.mtimeMs > freshCutoffMs) {
      // Written by a live official kimi after the sync started — retry next time.
      summary.skippedFresh++;
      return;
    }
    let dstMtimeMs: number | undefined;
    try {
      dstMtimeMs = (await stat(dst)).mtimeMs;
    } catch {
      dstMtimeMs = undefined; // target missing — fall through to copy
    }
    if (dstMtimeMs === undefined) {
      await copyToDestination(src, dst);
      summary.copiedFiles++;
      return;
    }
    if (srcStat.mtimeMs > dstMtimeMs) {
      await copyToDestination(src, dst);
      summary.updatedFiles++;
    } else if (srcStat.mtimeMs < dstMtimeMs) {
      summary.keptNewerFiles++;
    } else {
      summary.skippedFiles++;
    }
  } catch (error) {
    if (isExistsError(error)) {
      // The destination appeared between stat and copy — leave the winner in place.
      summary.skippedFiles++;
      return;
    }
    log(`[omkc] sync warning: skipping ${src} (${formatError(error)})`);
  }
}

/** Stream `src` into a temp file next to `dst`, then rename over `dst`. */
async function copyToDestination(src: string, dst: string): Promise<void> {
  await mkdir(dirname(dst), { recursive: true });
  const tmp = `${dst}.omkc-sync-${String(process.pid)}.tmp`;
  try {
    await pipeline(createReadStream(src), createWriteStream(tmp, { flags: 'wx' }));
    await rename(tmp, dst);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

async function syncDirRecursive(
  srcDir: string,
  dstDir: string,
  summary: HomeSyncSummary,
  log: (msg: string) => void,
  freshCutoffMs: number,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(srcDir, { withFileTypes: true });
  } catch {
    return; // missing or unreadable source dir — nothing to sync
  }
  for (const entry of entries) {
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      await syncDirRecursive(src, dst, summary, log, freshCutoffMs);
      continue;
    }
    if (!entry.isFile()) continue; // symlinks and special files are not synced
    await syncFileIncremental(src, dst, summary, log, freshCutoffMs);
  }
}

/**
 * Merge the official `session_index.jsonl` into omkc's: existing target lines
 * are kept verbatim (they already point at the target home), then each
 * parseable source line is imported with its `sessionDir` prefix rewritten,
 * skipping lines whose `sessionId` (or rewritten `sessionDir`) the target
 * index already carries. Unparseable source lines are dropped and counted.
 * The target file is only rewritten when at least one line was imported.
 */
async function mergeSessionIndex(
  src: string,
  dst: string,
  sourceHome: string,
  targetHome: string,
  summary: HomeSyncSummary,
  log: (msg: string) => void,
): Promise<void> {
  try {
    if (!existsSync(src)) return;
    const srcText = await readFile(src, 'utf-8');
    const dstExisted = existsSync(dst);
    const dstText = dstExisted ? await readFile(dst, 'utf-8') : '';

    const outLines: string[] = [];
    const seenKeys = new Set<string>();
    for (const line of dstText.split('\n')) {
      if (line.trim() === '') continue;
      outLines.push(line);
      for (const key of indexDedupKeys(line)) seenKeys.add(key);
    }

    const importedAtStart = summary.sessionIndexImported;
    for (const line of srcText.split('\n')) {
      if (line.trim() === '') continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        summary.sessionIndexBadLines++;
        continue;
      }
      if (typeof entry === 'object' && entry !== null) {
        const record = entry as Record<string, unknown>;
        if (typeof record['sessionDir'] === 'string') {
          record['sessionDir'] = rewriteSessionDir(record['sessionDir'], sourceHome, targetHome);
        }
      }
      const outLine = JSON.stringify(entry);
      const keys = indexDedupKeys(outLine);
      // No session identity (neither sessionId nor a string sessionDir):
      // cannot be deduplicated, and the index reader would ignore the line
      // anyway — leave it in the official index and do not import it.
      if (keys.length === 0) continue;
      if (keys.some((key) => seenKeys.has(key))) continue;
      for (const key of keys) seenKeys.add(key);
      outLines.push(outLine);
      summary.sessionIndexImported++;
    }

    if (summary.sessionIndexImported === importedAtStart) return; // nothing new — leave the target untouched
    await mkdir(dirname(dst), { recursive: true });
    const tmp = `${dst}.omkc-sync-${String(process.pid)}.tmp`;
    try {
      await writeFile(tmp, outLines.length > 0 ? `${outLines.join('\n')}\n` : '', {
        encoding: 'utf-8',
        flag: 'wx',
      });
      await rename(tmp, dst);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  } catch (error) {
    log(`[omkc] sync warning: session index not merged (${formatError(error)})`);
  }
}

/**
 * Dedup keys for one index line: `id:<sessionId>` plus the normalized
 * `dir:<sessionDir>` as a fallback for lines without a `sessionId`.
 * Unparseable or keyless lines yield no keys and are not imported.
 */
function indexDedupKeys(line: string): string[] {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return [];
    const record = parsed as Record<string, unknown>;
    const keys: string[] = [];
    if (typeof record['sessionId'] === 'string') keys.push(`id:${record['sessionId']}`);
    if (typeof record['sessionDir'] === 'string') {
      keys.push(`dir:${record['sessionDir'].replaceAll('\\', '/').replace(/\/+$/, '')}`);
    }
    return keys;
  } catch {
    return [];
  }
}
