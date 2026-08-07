import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const TOWER_GUARD_MIRROR_FILE = '.tower-guard.json';

export interface TowerGuardMirrorAgentEntry {
  readonly name?: string;
  readonly worktree?: string | null;
  readonly agentId?: string | null;
}

export interface TowerGuardMirror {
  readonly version?: unknown;
  readonly repoRoot?: unknown;
  readonly updatedAt?: unknown;
  readonly agents?: Readonly<Record<string, TowerGuardMirrorAgentEntry>>;
  readonly worktrees?: readonly string[];
}

const mirrorCache = new Map<string, TowerGuardMirror>();

/**
 * Read `<repoRoot>/.tower-guard.json` — the guard mirror the moamcp tower
 * controller writes atomically (tmp+rename) as `{updatedAt, repoRoot,
 * agents: {name: {worktree: string|null, agentId: string|null}},
 * worktrees: string[]}` (B2-6 定稿; the omkc policy scans the agents map by
 * agentId — a pending agentId:null entry never matches a real agentId).
 *
 * Never throws: ENOENT, read errors, JSON parse failures and malformed
 * shapes all yield `undefined` (no mirror → fail open). Results are cached
 * by (path, mtimeMs, size) — a rewritten mirror (new mtime/size) or a
 * deleted file simply misses the cache and re-reads (B3-10). A rewrite that
 * keeps both mtimeMs and size identical (coarse-grained filesystems, or a
 * writer pinning timestamps) would hit the stale cache entry instead —
 * accepted residual, deliberately not fixed in code (B3R-2).
 */
export async function readTowerGuardMirror(
  repoRoot: string,
): Promise<TowerGuardMirror | undefined> {
  const file = join(repoRoot, TOWER_GUARD_MIRROR_FILE);
  try {
    const stats = await stat(file);
    const cacheKey = `${file}:${stats.mtimeMs}:${stats.size}`;
    const cached = mirrorCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isTowerGuardMirror(parsed)) return undefined;
    mirrorCache.set(cacheKey, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

function isTowerGuardMirror(doc: unknown): doc is TowerGuardMirror {
  if (typeof doc !== 'object' || doc === null) return false;
  const agents = (doc as { readonly agents?: unknown }).agents;
  if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) return false;
  return true;
}
