import { valid } from 'semver';
import { z } from 'zod';

import { OMKC_UPDATE_REPO, OMKC_UPDATE_REPO_ENV } from '#/constant/app';

import type { ReleaseAsset, UpdateFeed } from './types';

export const GITHUB_FEED_FETCH_TIMEOUT_MS = 5_000;

/** GitHub requires a User-Agent on every API request; a missing one is a 403. */
const GITHUB_API_USER_AGENT = 'oh-my-kimi-code-update-check';

const REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const TAG_PREFIX = 'oh-my-kimi-code@';

/**
 * Resolve the `owner/name` repository that self-update checks. The
 * `OMKC_UPDATE_REPO` env var overrides the community default so forks and
 * tests can point the updater at their own releases. A malformed override is
 * ignored (never injected into URLs) and falls back to the default repo.
 */
export function updateRepoSlug(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = (env[OMKC_UPDATE_REPO_ENV] ?? '').trim();
  if (override.length > 0 && REPO_SLUG_PATTERN.test(override)) {
    return override;
  }
  return OMKC_UPDATE_REPO;
}

export function githubLatestReleaseApiUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

export function githubReleasesUrl(repo: string): string {
  return `https://github.com/${repo}/releases`;
}

export function githubReleaseTagUrl(repo: string, tag: string): string {
  return `https://github.com/${repo}/releases/tag/${tag}`;
}

/** Community release tag for a version: `oh-my-kimi-code@<version>`. */
export function releaseTagForVersion(version: string): string {
  return `${TAG_PREFIX}${version}`;
}

/** Release-notes page for a version, derived deterministically (no API call). */
export function releaseNotesUrlForVersion(
  version: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return githubReleaseTagUrl(updateRepoSlug(env), releaseTagForVersion(version));
}

/**
 * Normalize a release tag to its semver version. Release tags follow
 * `oh-my-kimi-code@<version>` (see scripts/native/resolve-release.mjs); a bare
 * `v<version>` / `<version>` tag is accepted too. Throws on anything that is
 * not valid semver — including `<version>-omkc.N` prereleases, which ARE
 * valid and compare correctly (`0.29.0-omkc.1 < 0.29.0-omkc.2 < 0.29.0-omkc.10
 * < 0.29.1-omkc.1`).
 */
export function versionFromReleaseTag(tag: string): string {
  const stripped = tag.startsWith(TAG_PREFIX)
    ? tag.slice(TAG_PREFIX.length)
    : tag.replace(/^v/, '');
  const version = stripped.trim();
  if (valid(version) === null) {
    throw new GitHubFeedError(`release tag is not a valid semver version: ${JSON.stringify(tag)}`);
  }
  return version;
}

/**
 * Failure querying the GitHub Releases feed. `rateLimited` marks HTTP
 * 403/429 responses caused by the unauthenticated API quota (60 requests/h
 * per IP) — passive update checks swallow those silently and fall back to
 * the cache instead of bothering the user.
 */
export class GitHubFeedError extends Error {
  readonly status: number | null;
  readonly rateLimited: boolean;

  constructor(message: string, options: { readonly status?: number; readonly rateLimited?: boolean } = {}) {
    super(message);
    this.name = 'GitHubFeedError';
    this.status = options.status ?? null;
    this.rateLimited = options.rateLimited ?? false;
  }
}

const GitHubReleaseAssetSchema = z.object({
  name: z.string().min(1),
  browser_download_url: z.string().min(1),
});

/**
 * GitHub `GET /repos/{owner}/{repo}/releases/latest` wire format. The
 * endpoint already excludes drafts and prereleases. Deliberately NOT
 * `.strict()` — unknown fields are ignored so future API additions never
 * break shipped clients.
 */
export const GitHubLatestReleaseSchema = z.object({
  tag_name: z.string().min(1),
  html_url: z.string().min(1),
  published_at: z.string().min(1).nullable().optional(),
  assets: z.array(GitHubReleaseAssetSchema).readonly().default([]),
});

function toReleaseAssets(assets: readonly z.infer<typeof GitHubReleaseAssetSchema>[]): readonly ReleaseAsset[] {
  return assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url }));
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': GITHUB_API_USER_AGENT,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isRateLimitResponse(response: Response): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  const remaining = response.headers.get('x-ratelimit-remaining');
  return remaining !== null && remaining.trim() === '0';
}

export interface FetchLatestFromGitHubDeps {
  readonly fetchImpl?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

/**
 * Fetch the newest community release from the GitHub Releases API.
 *
 * **Throws** `GitHubFeedError` on any failure: network error, non-2xx (404 =
 * the repo has no published release yet), rate limiting, malformed JSON, or
 * a tag that is not valid semver. Callers must catch — `refreshUpdateCache`
 * deliberately lets the error propagate so the existing cache stays intact
 * and a failed check is skipped silently.
 */
export async function fetchLatestFromGitHub(
  deps: FetchLatestFromGitHubDeps = {},
): Promise<UpdateFeed> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const repo = updateRepoSlug(deps.env);
  const url = githubLatestReleaseApiUrl(repo);

  let response: Response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, deps.timeoutMs ?? GITHUB_FEED_FETCH_TIMEOUT_MS);
  } catch (error) {
    throw new GitHubFeedError(
      `failed to reach the GitHub Releases API: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    if (isRateLimitResponse(response)) {
      throw new GitHubFeedError(
        'GitHub API rate limit exceeded (60 requests/hour per IP); skipping this update check',
        { status: response.status, rateLimited: true },
      );
    }
    if (response.status === 404) {
      throw new GitHubFeedError(`no published release found at ${url}`, { status: 404 });
    }
    throw new GitHubFeedError(`GitHub Releases API returned HTTP ${response.status}`, {
      status: response.status,
    });
  }

  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new GitHubFeedError('GitHub Releases API returned a non-JSON body');
  }

  const parsed = GitHubLatestReleaseSchema.safeParse(body);
  if (!parsed.success) {
    throw new GitHubFeedError(`GitHub release payload failed validation: ${parsed.error.message}`);
  }

  const release = parsed.data;
  const publishedAt = release.published_at ?? null;
  return {
    version: versionFromReleaseTag(release.tag_name),
    tag: release.tag_name,
    releaseUrl: release.html_url,
    publishedAt,
    assets: toReleaseAssets(release.assets),
  };
}
