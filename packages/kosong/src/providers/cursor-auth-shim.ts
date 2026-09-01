/**
 * Auth shim for the embedded `@cursor/sdk`.
 *
 * `setConnectTransportFactory` is not reachable from the SDK main entry (it is
 * webpack-inlined) and the cloud REST API rejects a raw JWT passed as
 * `apiKey`, so the working injection point is a global `fetch` wrapper. It
 * intercepts exactly two URLs — the SDK's `auth/exchange_user_api_key` call
 * (answered with the IDE accessToken, skipping a round-trip that would fail
 * anyway) and the client-side `api.cursor.com/v1/models` existence check —
 * and passes every other request through to the original `fetch` with the
 * arguments untouched, so the SDK keeps its 1:1 request fingerprint.
 */

/** URL suffix identifying the SDK's `exchange_user_api_key` request. */
const EXCHANGE_USER_API_KEY_SUFFIX = '/auth/exchange_user_api_key';

/** Host and path of the client-side model validation endpoint. */
const MODELS_HOSTNAME = 'api.cursor.com';
const MODELS_PATHNAME = '/v1/models';

/**
 * Runtime model id for Cursor "Auto" — the only id the free tier reliably
 * accepts. Always present in the synthetic models list.
 */
export const DEFAULT_MODEL_ID = 'default';

/**
 * Default model id list advertised by the synthetic models response. The
 * free tier resolves `default` (Auto) server-side, so it is the only entry
 * that can be assumed to work.
 */
export const DEFAULT_CURSOR_MODELS: readonly string[] = [DEFAULT_MODEL_ID];

/** One entry of the upstream model list projection served to client validation. */
export interface CursorModelListEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly aliases?: readonly string[];
}

/** Milliseconds a fetched upstream model list stays cached (model tables change rarely). */
const MODEL_LIST_TTL_MS = 5 * 60_000;

export interface CursorAuthShimOptions {
  /**
   * Supplies the Cursor accessToken on demand. Must come from the token
   * supply layer (e.g. `() => defaultCursorTokenStore.getToken()`); the shim
   * never reads, stores, or logs the token itself.
   */
  getToken: () => string | Promise<string>;
  /**
   * Model ids advertised by the synthetic fallback response. `default` is
   * always included, even when omitted here. Defaults to
   * {@link DEFAULT_CURSOR_MODELS}.
   */
  models?: readonly string[];
  /**
   * Gateway mode: pass the SDK's `exchange_user_api_key` call through to the
   * configured backend (the gateway answers it with its own account-pool
   * token) instead of intercepting it with the local IDE accessToken. The
   * synthetic `/v1/models` interception is unaffected — that endpoint is
   * hardcoded to api.cursor.com and unreachable by a gateway anyway.
   */
  passthroughExchange?: boolean;
  /**
   * Pulls the REAL upstream model list (a projection of `GetUsableModels`).
   * When provided, `/v1/models` interception on api.cursor.com serves this
   * list — cached for {@link MODEL_LIST_TTL_MS} with single-flight — falling
   * back to the synthetic ids on failure so client-side validation never
   * crashes on a missing `items` array. When omitted, only the synthetic list
   * is served.
   *
   * Gateway mode does NOT route through this fetcher: the SDK's models call
   * lands on the gateway host, which serves the same projection as a real
   * endpoint, so the interception here is api.cursor.com-only (direct mode,
   * where a raw JWT cannot authenticate the REST endpoint).
   */
  fetchModels?: () => Promise<readonly CursorModelListEntry[]>;
}

export interface CursorAuthShimHandle {
  /**
   * Restore the original global fetch. Returns `false` without restoring when
   * this shim is no longer the current `globalThis.fetch` (something else
   * wrapped it afterwards) — clobbering that wrapper would break it.
   */
  uninstall(): boolean;
}

/** Mutable shared state of the installed shim; re-pointed by repeated installs. */
interface ShimState {
  getToken: () => string | Promise<string>;
  models: readonly string[];
  passthroughExchange: boolean;
  fetchModels: (() => Promise<readonly CursorModelListEntry[]>) | undefined;
  modelListCache: { items: readonly CursorModelListEntry[]; expires: number } | undefined;
  modelListInFlight: Promise<readonly CursorModelListEntry[]> | undefined;
}

/**
 * Whether the process-level warning filter is installed. The Cursor SDK sets
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` by itself whenever its backend URL is
 * localhost/127.0.0.1 (an official convenience for self-signed local
 * backends), which makes Node print a one-time warning banner. Node's default
 * warning printer is a bootstrap-registered `'warning'` listener — adding our
 * own listener does NOT suppress it, so we remove ALL `'warning'` listeners
 * (dropping the default printer) and re-print every non-matching warning
 * ourselves in the default format; only the SDK's TLS banner is dropped.
 */
let warningFilterInstalled = false;

function installWarningFilter(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.message.includes('NODE_TLS_REJECT_UNAUTHORIZED')) return;
    const code = (warning as NodeJS.ErrnoException).code;
    const header = `(node:${process.pid})`;
    if (code !== undefined) {
      console.error(`${header} [${code}] ${warning.message}`);
    } else {
      console.error(`${header} ${warning.name}: ${warning.message}`);
    }
  });
}

let installed:
  | {
      originalFetch: typeof fetch;
      wrapper: typeof fetch;
      state: ShimState;
    }
  | undefined;

/**
 * Install the global fetch wrapper (idempotently).
 *
 * `globalThis.fetch` is wrapped at most once: if a shim is already installed,
 * repeated calls never stack wrappers — they re-point the shared token getter
 * and model list, and return the existing handle. Pass-through requests are
 * forwarded with their arguments unchanged.
 */
export function installCursorAuthShim(options: CursorAuthShimOptions): CursorAuthShimHandle {
  installWarningFilter();
  if (installed !== undefined) {
    installed.state.getToken = options.getToken;
    installed.state.models = normalizeModels(options.models);
    return { uninstall };
  }

  const originalFetch = globalThis.fetch;
  const state: ShimState = {
    getToken: options.getToken,
    models: normalizeModels(options.models),
    passthroughExchange: options.passthroughExchange === true,
    fetchModels: options.fetchModels,
    modelListCache: undefined,
    modelListInFlight: undefined,
  };
  const wrapper: typeof fetch = (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
    const url = requestUrl(args[0]);
    if (url !== undefined) {
      if (!state.passthroughExchange && isExchangeUserApiKeyUrl(url)) {
        return exchangeUserApiKey(state);
      }
      if (isModelsUrl(url)) {
        return modelListResponse(state);
      }
    }
    return originalFetch(...args);
  };

  globalThis.fetch = wrapper;
  installed = { originalFetch, wrapper, state };
  return { uninstall };
}

function uninstall(): boolean {
  const current = installed;
  if (current === undefined) {
    return false;
  }
  installed = undefined;
  if (globalThis.fetch === current.wrapper) {
    globalThis.fetch = current.originalFetch;
    return true;
  }
  return false;
}

/** Build the `exchange_user_api_key` response from a token supplied on demand. */
function exchangeUserApiKey(state: ShimState): Promise<Response> {
  return resolveToken(state).then((accessToken) => jsonResponse({ accessToken }));
}

/**
 * Build the `/v1/models` response: the real upstream projection when a
 * fetcher is configured (cached, single-flight), the synthetic fallback
 * otherwise or on fetch failure — the shape is ALWAYS a valid `items` array
 * so the SDK's `undefined.find` crash cannot recur.
 */
async function modelListResponse(state: ShimState): Promise<Response> {
  return jsonResponse({ items: await resolveModelItems(state) });
}

async function resolveModelItems(state: ShimState): Promise<readonly CursorModelListEntry[]> {
  if (state.fetchModels === undefined) {
    return syntheticItems(state);
  }
  if (state.modelListCache !== undefined && state.modelListCache.expires > Date.now()) {
    return state.modelListCache.items;
  }
  state.modelListInFlight ??= state
    .fetchModels()
    .then((items) => {
      state.modelListCache = { items, expires: Date.now() + MODEL_LIST_TTL_MS };
      return items;
    })
    .finally(() => {
      state.modelListInFlight = undefined;
    });
  try {
    return await state.modelListInFlight;
  } catch {
    return syntheticItems(state);
  }
}

function syntheticItems(state: ShimState): readonly CursorModelListEntry[] {
  return state.models.map((id) => ({ id, displayName: displayNameFor(id) }));
}

async function resolveToken(state: ShimState): Promise<string> {
  const accessToken = await state.getToken();
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('cursor auth shim: token supplier returned no token');
  }
  return accessToken;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function displayNameFor(id: string): string {
  return id === DEFAULT_MODEL_ID ? 'Auto' : id;
}

/** Ensure `default` is present and drop empty ids. */
function normalizeModels(models: readonly string[] | undefined): readonly string[] {
  const list = (models ?? DEFAULT_CURSOR_MODELS).filter((id) => id.length > 0);
  if (!list.includes(DEFAULT_MODEL_ID)) {
    list.unshift(DEFAULT_MODEL_ID);
  }
  return list;
}

/**
 * Extract the request URL from a fetch input (`string`, `URL`, or
 * `Request`-like). Returns `undefined` for anything unparseable so the call
 * falls through to the original fetch untouched.
 */
function requestUrl(input: Parameters<typeof fetch>[0]): URL | undefined {
  try {
    if (typeof input === 'string') {
      return new URL(input);
    }
    if (input instanceof URL) {
      return input;
    }
    const candidate = input as Partial<Request>;
    return typeof candidate.url === 'string' ? new URL(candidate.url) : undefined;
  } catch {
    return undefined;
  }
}

/** Any host ending in `/auth/exchange_user_api_key` is the SDK's exchange call. */
function isExchangeUserApiKeyUrl(url: URL): boolean {
  return url.pathname.endsWith(EXCHANGE_USER_API_KEY_SUFFIX);
}

function isModelsUrl(url: URL): boolean {
  return url.hostname === MODELS_HOSTNAME && trimTrailingSlash(url.pathname) === MODELS_PATHNAME;
}

function trimTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}
