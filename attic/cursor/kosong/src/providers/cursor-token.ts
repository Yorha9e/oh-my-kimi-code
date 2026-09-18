import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * OAuth client id the official Cursor IDE presents when refreshing its token.
 * The refresh endpoint rejects the request without it.
 */
const CURSOR_OAUTH_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';

/** Cursor token-refresh endpoint (same backend the IDE talks to). */
const CURSOR_REFRESH_ENDPOINT = 'https://api2.cursor.sh/oauth/token';

/** SQLite table holding the IDE's key/value state. */
const ITEM_TABLE = 'ItemTable';
const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';
const REFRESH_TOKEN_KEY = 'cursorAuth/refreshToken';

/**
 * A token is considered stale this many milliseconds before its real `exp`, so
 * requests never race the actual expiry mid-flight.
 */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/**
 * Fallback validity window for a refreshed token whose `exp` cannot be parsed.
 * Short by design: an unparseable token is used rather than discarded, but we
 * re-check (and re-refresh) instead of trusting it for a full lifetime.
 */
const UNKNOWN_EXPIRY_TTL_MS = 60 * 1000;

/** Busy timeout for the read-only SQLite open, guarding against transient IDE locks. */
const SQLITE_BUSY_TIMEOUT_MS = 1000;

/**
 * Error raised by the Cursor token supply layer. Messages are intentionally
 * free of credential material — neither the access token nor the refresh token
 * is ever embedded, logged, or serialized by this module.
 */
export class CursorTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorTokenError';
  }
}

export interface CursorTokenStoreOptions {
  /**
   * Explicit path to the Cursor IDE `state.vscdb`. Defaults to the
   * per-platform Cursor global-storage location derived from the environment.
   */
  dbPath?: string;
}

/** Auth entries as read from the IDE's `ItemTable`; either may be absent. */
interface IdeTokens {
  accessToken: string | undefined;
  refreshToken: string | undefined;
}

/** In-memory token cache entry; `expiresAtMs` already includes the safety margin. */
interface CachedToken {
  value: string;
  expiresAtMs: number;
}

/**
 * Supplies the Cursor accessToken used to authenticate SDK requests.
 *
 * Tokens are read from the local Cursor IDE's SQLite state database opened
 * READ-ONLY (never written back — the IDE owns that file and its WAL), so a
 * token minted by an IDE login is picked up with zero configuration. When the
 * stored token is stale, it is refreshed against the OAuth endpoint; the
 * refreshed token lives only in this store's memory.
 *
 * Concurrency and failure semantics:
 * - Refreshes are SINGLE-FLIGHT — concurrent callers awaiting an expired token
 *   share one in-flight refresh instead of firing parallel requests.
 * - A `shouldLogout: true` refresh response means the session was revoked; the
 *   store latches a permanent disabled state and every later {@link getToken}
 *   call fails fast without touching the network.
 */
export class CursorTokenStore {
  private readonly dbPath: string | undefined;
  private cached: CachedToken | undefined;
  private refreshInFlight: Promise<string> | undefined;
  private disabledReason: string | undefined;

  constructor(options: CursorTokenStoreOptions = {}) {
    this.dbPath = options.dbPath;
  }

  /**
   * Whether the store has been permanently disabled (e.g. by a
   * `shouldLogout: true` refresh response). When true, {@link getToken} throws
   * immediately.
   */
  isDisabled(): boolean {
    return this.disabledReason !== undefined;
  }

  /**
   * Return a valid accessToken, refreshing when necessary.
   *
   * Resolution order: the in-memory cache (while it still holds more than the
   * 5-minute safety margin), then a fresh READ-ONLY read of the IDE database
   * (the IDE may have rotated the token itself), then a single-flight refresh.
   *
   * @throws {CursorTokenError} when the store is disabled, the IDE has no
   * credentials, or the refresh request fails. Error messages never contain
   * credential material.
   */
  async getToken(): Promise<string> {
    const disabledReason = this.disabledReason;
    if (disabledReason !== undefined) {
      throw new CursorTokenError(disabledReason);
    }

    const now = Date.now();
    const cached = this.cached;
    if (cached !== undefined && now < cached.expiresAtMs) {
      return cached.value;
    }

    const ide = this.readIdeTokens();
    const ideToken = ide.accessToken;
    if (ideToken !== undefined) {
      const ideExpiry = parseJwtExpiry(ideToken);
      if (ideExpiry !== undefined && now < ideExpiry - EXPIRY_MARGIN_MS) {
        const cachedIde: CachedToken = { value: ideToken, expiresAtMs: ideExpiry - EXPIRY_MARGIN_MS };
        this.cached = cachedIde;
        return ideToken;
      }
    }

    return this.refreshSingleFlight(ide.refreshToken);
  }

  /**
   * Start one refresh if none is in flight and hand every concurrent caller
   * the same promise, so parallel `getToken` calls never produce parallel
   * refresh requests.
   */
  private refreshSingleFlight(refreshToken: string | undefined): Promise<string> {
    if (this.refreshInFlight === undefined) {
      const refresh = this.refresh(refreshToken).finally(() => {
        this.refreshInFlight = undefined;
      });
      this.refreshInFlight = refresh;
    }
    return this.refreshInFlight;
  }

  private async refresh(refreshToken: string | undefined): Promise<string> {
    if (refreshToken === undefined) {
      throw new CursorTokenError(
        `no usable Cursor accessToken and no ${REFRESH_TOKEN_KEY} to refresh with; log in from the Cursor IDE first`,
      );
    }

    let response: Response;
    try {
      response = await fetch(CURSOR_REFRESH_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: CURSOR_OAUTH_CLIENT_ID,
          refresh_token: refreshToken,
        }),
      });
    } catch (error) {
      // fetch is a shimmable surface — keep the thrown message constant (the
      // module never interpolates foreign error text) and preserve the
      // diagnostic on the cause chain instead.
      throw Object.assign(new CursorTokenError('token refresh request failed: network error'), { cause: error });
    }
    if (!response.ok) {
      // The response body may echo credential material — only the status is reported.
      throw new CursorTokenError(`token refresh failed: HTTP ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // JSON parse errors can quote fragments of the body — never surface them.
      throw new CursorTokenError('token refresh failed: unreadable response body');
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new CursorTokenError('token refresh failed: unexpected response shape');
    }
    const record = payload as Record<string, unknown>;

    if (record['shouldLogout'] === true) {
      const reason =
        'Cursor reported shouldLogout for this session — credentials were revoked; ' +
        're-authenticate from the Cursor IDE, then restart the session';
      this.disable(reason);
      throw new CursorTokenError(reason);
    }

    const accessToken = record['access_token'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new CursorTokenError('token refresh failed: response did not include an access_token');
    }

    const expiry = parseJwtExpiry(accessToken);
    const cachedToken: CachedToken = {
      value: accessToken,
      expiresAtMs: expiry !== undefined ? expiry - EXPIRY_MARGIN_MS : Date.now() + UNKNOWN_EXPIRY_TTL_MS,
    };
    this.cached = cachedToken;
    return accessToken;
  }

  /** Latch the permanent disabled state and drop any cached credential. */
  private disable(reason: string): void {
    if (this.disabledReason === undefined) {
      this.disabledReason = reason;
    }
    this.cached = undefined;
  }

  /**
   * Read the two auth entries from the IDE SQLite database. The database is
   * opened READ-ONLY per read and closed immediately: this process never
   * writes to a file the IDE owns, and no lock outlives the call.
   */
  private readIdeTokens(): IdeTokens {
    const dbPath = this.dbPath ?? defaultIdeDbPath();
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
    } catch (error) {
      throw new CursorTokenError(
        `failed to open the Cursor IDE state database at ${dbPath}: ${errorMessage(error)}`,
      );
    }
    try {
      const select = db.prepare(`SELECT value FROM ${ITEM_TABLE} WHERE key = ?`);
      return {
        accessToken: textValue(select.get(ACCESS_TOKEN_KEY)),
        refreshToken: textValue(select.get(REFRESH_TOKEN_KEY)),
      };
    } catch (error) {
      throw new CursorTokenError(
        `failed to read Cursor auth entries from ${dbPath}: ${errorMessage(error)}`,
      );
    } finally {
      db.close();
    }
  }
}

/**
 * Process-wide default store. The provider layer and the auth shim should
 * share this instance so token caching and the single-flight refresh lock are
 * process-wide rather than per consumer.
 */
export const defaultCursorTokenStore = new CursorTokenStore();

/**
 * Resolve the per-platform Cursor IDE global-storage database path:
 * `%APPDATA%\Cursor\User\globalStorage\state.vscdb` on Windows, the
 * `~/Library/Application Support` equivalent on macOS, and
 * `$XDG_CONFIG_HOME/Cursor` (default `~/.config/Cursor`) elsewhere.
 */
function defaultIdeDbPath(): string {
  const appData = process.env['APPDATA'];
  if (appData !== undefined) {
    return join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  const home = process.env['HOME'] ?? process.env['USERPROFILE'];
  if (home === undefined) {
    throw new CursorTokenError(
      'cannot locate the Cursor IDE state database: neither APPDATA nor HOME/USERPROFILE is set',
    );
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  const configHome = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config');
  return join(configHome, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

/**
 * Extract the `exp` claim (epoch seconds) from a JWT payload.
 *
 * Base64url-decodes the payload segment only — the signature is NOT verified,
 * matching the official client, which trusts locally stored IDE tokens. The
 * result is epoch milliseconds, or `undefined` when the token is malformed or
 * carries no numeric `exp`.
 */
function parseJwtExpiry(jwt: string): number | undefined {
  const payloadSegment = jwt.split('.')[1];
  if (payloadSegment === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const exp = (parsed as Record<string, unknown>)['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return undefined;
  }
  return exp * 1000;
}

/** Narrow a SQLite row to its `value` column, accepting only string cells. */
function textValue(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null) {
    return undefined;
  }
  const value = (row as Record<string, unknown>)['value'];
  return typeof value === 'string' ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
