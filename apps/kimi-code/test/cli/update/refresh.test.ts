import { describe, expect, it, vi } from 'vitest';

import { refreshUpdateCache } from '#/cli/update/refresh';
import type { UpdateFeed } from '#/cli/update/types';

const FEED: UpdateFeed = {
  version: '0.29.0-omkc.2',
  tag: 'oh-my-kimi-code@0.29.0-omkc.2',
  releaseUrl: 'https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@0.29.0-omkc.2',
  publishedAt: '2026-05-20T12:00:00.000Z',
  assets: [
    {
      name: 'omkc-linux-x64.zip',
      url: 'https://github.com/Yorha9e/oh-my-kimi-code/releases/download/oh-my-kimi-code@0.29.0-omkc.2/omkc-linux-x64.zip',
    },
  ],
};

describe('refreshUpdateCache', () => {
  it('writes a fresh cache carrying the release feed on successful fetch', async () => {
    const writeCache = vi.fn(async () => {});
    const result = await refreshUpdateCache({
      fetchLatest: async () => FEED,
      writeCache,
      now: () => new Date('2026-05-20T12:34:56.000Z'),
    });

    expect(result).toEqual({
      source: 'github',
      checkedAt: '2026-05-20T12:34:56.000Z',
      latest: '0.29.0-omkc.2',
      tag: 'oh-my-kimi-code@0.29.0-omkc.2',
      releaseUrl: FEED.releaseUrl,
      assets: FEED.assets,
    });
    expect(writeCache).toHaveBeenCalledWith(result);
  });

  it('propagates fetch errors (including rate limiting) and skips writeCache so the cache is preserved', async () => {
    const writeCache = vi.fn(async () => {});
    await expect(
      refreshUpdateCache({
        fetchLatest: async () => {
          throw new Error('GitHub API rate limit exceeded');
        },
        writeCache,
        now: () => new Date(),
      }),
    ).rejects.toThrow(/rate limit/);

    expect(writeCache).not.toHaveBeenCalled();
  });
});
