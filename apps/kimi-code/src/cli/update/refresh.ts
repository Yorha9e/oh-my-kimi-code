import { writeUpdateCache } from './cache';
import { fetchLatestFromGitHub } from './github';
import { type UpdateCache, type UpdateFeed } from './types';

export interface RefreshUpdateCacheDeps {
  /** Resolves with the newest community release. **Throws** on any
   * failure (including GitHub API rate limiting) — callers (including the
   * default background invocation in preflight) must catch. Errors
   * intentionally skip `writeCache` so a failed check never overwrites a
   * previously known release, and the passive surfaces fall back to the
   * cache silently. */
  readonly fetchLatest: () => Promise<UpdateFeed>;
  readonly writeCache: (cache: UpdateCache) => Promise<void>;
  readonly now: () => Date;
}

export async function refreshUpdateCache(
  overrides: Partial<RefreshUpdateCacheDeps> = {},
): Promise<UpdateCache> {
  const resolved: RefreshUpdateCacheDeps = {
    fetchLatest: overrides.fetchLatest ?? (() => fetchLatestFromGitHub()),
    writeCache: overrides.writeCache ?? writeUpdateCache,
    now: overrides.now ?? (() => new Date()),
  };

  const feed = await resolved.fetchLatest();
  const cache: UpdateCache = {
    source: 'github',
    checkedAt: resolved.now().toISOString(),
    latest: feed.version,
    tag: feed.tag,
    releaseUrl: feed.releaseUrl,
    assets: feed.assets,
  };
  await resolved.writeCache(cache);
  return cache;
}
