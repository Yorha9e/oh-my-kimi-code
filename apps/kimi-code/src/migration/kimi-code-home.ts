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
 */

import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
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
