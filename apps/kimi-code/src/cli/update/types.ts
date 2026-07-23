import { NPM_PACKAGE_NAME } from '#/constant/app';

export { NPM_PACKAGE_NAME };

/** Where the running CLI was installed from. Drives update behavior. */
export type InstallSource =
  | 'npm-global'
  | 'pnpm-global'
  | 'yarn-global'
  | 'bun-global'
  | 'homebrew'
  | 'native'
  | 'unsupported';

export interface UpdateTarget {
  readonly version: string;
}

/** One downloadable asset attached to a GitHub Release. */
export interface ReleaseAsset {
  readonly name: string;
  /** Browser download URL — not subject to GitHub API rate limits. */
  readonly url: string;
}

/**
 * Parsed GitHub Release feed entry: the newest release of the community
 * repository. `assets` are the release's download URLs, cached so the
 * background installer never has to query the rate-limited API again.
 */
export interface UpdateFeed {
  readonly version: string;
  readonly tag: string;
  readonly releaseUrl: string;
  readonly publishedAt: string | null;
  readonly assets: readonly ReleaseAsset[];
}

/**
 * Cached result of the last successful release check, persisted under
 * `<dataDir>/updates/latest.json` so a failed or rate-limited check can fall
 * back to the previously known release instead of re-querying the API.
 */
export interface UpdateCache {
  readonly source: 'github';
  readonly checkedAt: string | null;
  readonly latest: string | null;
  readonly tag: string | null;
  readonly releaseUrl: string | null;
  readonly assets: readonly ReleaseAsset[];
}

export interface UpdateInstallActive {
  readonly version: string;
  readonly source: InstallSource;
  readonly startedAt: string;
}

export interface UpdateInstallFailure {
  readonly version: string;
  readonly failedAt: string;
  readonly attempts: number;
}

export interface UpdateInstallSuccess {
  readonly version: string;
  readonly installedAt: string;
  readonly notifiedAt: string | null;
}

export interface UpdateInstallState {
  readonly active: UpdateInstallActive | null;
  readonly lastFailure: UpdateInstallFailure | null;
  readonly lastSuccess: UpdateInstallSuccess | null;
}

export type UpdateDecision = 'none' | 'prompt-install' | 'manual-command';
export type UpdatePreflightResult = 'continue' | 'exit';

export function emptyUpdateCache(): UpdateCache {
  return {
    source: 'github',
    checkedAt: null,
    latest: null,
    tag: null,
    releaseUrl: null,
    assets: [],
  };
}

export function emptyUpdateInstallState(): UpdateInstallState {
  return {
    active: null,
    lastFailure: null,
    lastSuccess: null,
  };
}
