import { describe, expect, it, vi } from 'vitest';

import {
  fetchLatestFromGitHub,
  githubLatestReleaseApiUrl,
  githubReleaseTagUrl,
  githubReleasesUrl,
  GitHubFeedError,
  releaseNotesUrlForVersion,
  releaseTagForVersion,
  updateRepoSlug,
} from '#/cli/update/github';

interface MockResponseInit {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

function mockResponse(init: MockResponseInit): Response {
  const status = init.status ?? 200;
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => init.body ?? '',
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
  } as unknown as Response;
}

const RELEASE_BODY = JSON.stringify({
  tag_name: 'oh-my-kimi-code@0.29.0-omkc.2',
  html_url: 'https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@0.29.0-omkc.2',
  published_at: '2026-06-12T00:00:00.000Z',
  assets: [
    {
      name: 'omkc-linux-x64.zip',
      browser_download_url:
        'https://github.com/Yorha9e/oh-my-kimi-code/releases/download/oh-my-kimi-code@0.29.0-omkc.2/omkc-linux-x64.zip',
      size: 1234,
      content_type: 'application/zip',
    },
    {
      name: 'omkc-linux-x64.zip.sha256',
      browser_download_url:
        'https://github.com/Yorha9e/oh-my-kimi-code/releases/download/oh-my-kimi-code@0.29.0-omkc.2/omkc-linux-x64.zip.sha256',
      size: 99,
    },
    {
      name: 'manifest.json',
      browser_download_url:
        'https://github.com/Yorha9e/oh-my-kimi-code/releases/download/oh-my-kimi-code@0.29.0-omkc.2/manifest.json',
      size: 300,
    },
  ],
});

describe('updateRepoSlug', () => {
  it('defaults to the community repository', () => {
    expect(updateRepoSlug({})).toBe('Yorha9e/oh-my-kimi-code');
  });

  it('honors the OMKC_UPDATE_REPO override', () => {
    expect(updateRepoSlug({ OMKC_UPDATE_REPO: 'example/fork' })).toBe('example/fork');
  });

  it('ignores a malformed override instead of injecting it into URLs', () => {
    expect(updateRepoSlug({ OMKC_UPDATE_REPO: 'bad slug/../x' })).toBe('Yorha9e/oh-my-kimi-code');
    expect(updateRepoSlug({ OMKC_UPDATE_REPO: '' })).toBe('Yorha9e/oh-my-kimi-code');
    expect(updateRepoSlug({ OMKC_UPDATE_REPO: '   ' })).toBe('Yorha9e/oh-my-kimi-code');
  });
});

describe('release URL builders', () => {
  it('builds the API, releases, and tag URLs from the repo slug', () => {
    expect(githubLatestReleaseApiUrl('example/fork')).toBe(
      'https://api.github.com/repos/example/fork/releases/latest',
    );
    expect(githubReleasesUrl('example/fork')).toBe('https://github.com/example/fork/releases');
    expect(githubReleaseTagUrl('example/fork', 'oh-my-kimi-code@0.1.0')).toBe(
      'https://github.com/example/fork/releases/tag/oh-my-kimi-code@0.1.0',
    );
  });

  it('derives the release notes URL deterministically from a version', () => {
    expect(releaseTagForVersion('0.29.0-omkc.1')).toBe('oh-my-kimi-code@0.29.0-omkc.1');
    expect(releaseNotesUrlForVersion('0.29.0-omkc.1', {})).toBe(
      'https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@0.29.0-omkc.1',
    );
    expect(releaseNotesUrlForVersion('0.1.0', { OMKC_UPDATE_REPO: 'example/fork' })).toBe(
      'https://github.com/example/fork/releases/tag/oh-my-kimi-code@0.1.0',
    );
  });
});

describe('fetchLatestFromGitHub', () => {
  it('parses the latest release feed with version, tag, page, and assets', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ body: RELEASE_BODY }));

    await expect(fetchLatestFromGitHub({ fetchImpl, env: {} })).resolves.toEqual({
      version: '0.29.0-omkc.2',
      tag: 'oh-my-kimi-code@0.29.0-omkc.2',
      releaseUrl:
        'https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@0.29.0-omkc.2',
      publishedAt: '2026-06-12T00:00:00.000Z',
      assets: [
        {
          name: 'omkc-linux-x64.zip',
          url: 'https://github.com/Yorha9e/oh-my-kimi-code/releases/download/oh-my-kimi-code@0.29.0-omkc.2/omkc-linux-x64.zip',
        },
        {
          name: 'omkc-linux-x64.zip.sha256',
          url: 'https://github.com/Yorha9e/oh-my-kimi-code/releases/download/oh-my-kimi-code@0.29.0-omkc.2/omkc-linux-x64.zip.sha256',
        },
        {
          name: 'manifest.json',
          url: 'https://github.com/Yorha9e/oh-my-kimi-code/releases/download/oh-my-kimi-code@0.29.0-omkc.2/manifest.json',
        },
      ],
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/Yorha9e/oh-my-kimi-code/releases/latest',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          Accept: 'application/vnd.github+json',
          'User-Agent': expect.any(String),
        }),
      }),
    );
  });

  it('queries the overridden repository when OMKC_UPDATE_REPO is set', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ body: RELEASE_BODY }));
    await fetchLatestFromGitHub({ fetchImpl, env: { OMKC_UPDATE_REPO: 'example/fork' } });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/example/fork/releases/latest',
      expect.anything(),
    );
  });

  it('accepts bare version tags and defaults missing optional fields', async () => {
    const body = JSON.stringify({ tag_name: 'v0.5.0', html_url: 'https://example.test/r/1' });
    const fetchImpl = vi.fn(async () => mockResponse({ body }));

    await expect(fetchLatestFromGitHub({ fetchImpl, env: {} })).resolves.toEqual({
      version: '0.5.0',
      tag: 'v0.5.0',
      releaseUrl: 'https://example.test/r/1',
      publishedAt: null,
      assets: [],
    });
  });

  it('ignores unknown payload fields (lenient parsing)', async () => {
    const body = JSON.stringify({
      tag_name: 'oh-my-kimi-code@0.5.0',
      html_url: 'https://example.test/r/1',
      future_field: { nested: true },
    });
    const fetchImpl = vi.fn(async () => mockResponse({ body }));
    await expect(fetchLatestFromGitHub({ fetchImpl, env: {} })).resolves.toMatchObject({
      version: '0.5.0',
    });
  });

  it('marks exhausted unauthenticated quota as rate limited on 403', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    );
    const error = await fetchLatestFromGitHub({ fetchImpl, env: {} }).catch((error) => error);
    expect(error).toBeInstanceOf(GitHubFeedError);
    expect(error.rateLimited).toBe(true);
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/rate limit/i);
  });

  it('marks 429 responses as rate limited', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ status: 429 }));
    const error = await fetchLatestFromGitHub({ fetchImpl, env: {} }).catch((error) => error);
    expect(error).toBeInstanceOf(GitHubFeedError);
    expect(error.rateLimited).toBe(true);
  });

  it('does not flag a plain 403 (e.g. private repo) as rate limiting', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ status: 403, headers: { 'x-ratelimit-remaining': '42' } }),
    );
    const error = await fetchLatestFromGitHub({ fetchImpl, env: {} }).catch((error) => error);
    expect(error.rateLimited).toBe(false);
    expect(error.status).toBe(403);
  });

  it('reports a repo without published releases as a 404 feed error', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ status: 404 }));
    const error = await fetchLatestFromGitHub({ fetchImpl, env: {} }).catch((error) => error);
    expect(error).toBeInstanceOf(GitHubFeedError);
    expect(error.status).toBe(404);
    expect(error.message).toMatch(/no published release/);
  });

  it('throws on other non-2xx statuses', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ status: 500 }));
    await expect(fetchLatestFromGitHub({ fetchImpl, env: {} })).rejects.toThrow(/HTTP 500/);
  });

  it('throws when the body is not JSON', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ body: 'not json {' }));
    await expect(fetchLatestFromGitHub({ fetchImpl, env: {} })).rejects.toThrow(/non-JSON/);
  });

  it('throws when the payload fails schema validation', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ body: JSON.stringify({ nope: true }) }));
    await expect(fetchLatestFromGitHub({ fetchImpl, env: {} })).rejects.toThrow(/validation/);
  });

  it('throws when the release tag is not a valid semver version', async () => {
    const body = JSON.stringify({ tag_name: 'oh-my-kimi-code@nightly', html_url: 'x' });
    const fetchImpl = vi.fn(async () => mockResponse({ body }));
    await expect(fetchLatestFromGitHub({ fetchImpl, env: {} })).rejects.toThrow(/not a valid semver/);
  });

  it('wraps network failures in a feed error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const error = await fetchLatestFromGitHub({ fetchImpl, env: {} }).catch((error) => error);
    expect(error).toBeInstanceOf(GitHubFeedError);
    expect(error.rateLimited).toBe(false);
    expect(error.message).toMatch(/network down/);
  });

  it('aborts when the request hangs past the timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          }, { once: true });
        });
      }) as unknown as typeof fetch;

      const result = fetchLatestFromGitHub({ fetchImpl, env: {} });
      const expectation = expect(result).rejects.toThrow(/aborted/);
      await vi.advanceTimersByTimeAsync(5_000);

      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});
