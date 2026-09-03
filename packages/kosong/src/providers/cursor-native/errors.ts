import { ChatProviderError } from '#/errors';
import type { TrailerMap } from './frame';

/**
 * Constructor options carrying the upstream error details preserved on every
 * cursor native error.
 */
export interface CursorErrorInit {
  code?: string;
  debugError?: string | null;
  title?: string | null;
  /**
   * Trailer-advertised retryability. Only {@link CursorResourceError} honors
   * it; protocol and model errors are never retryable. Defaults to false when
   * absent.
   */
  isRetryable?: boolean;
}

/**
 * Protocol or request-construction failure (`invalid_argument` and any
 * unrecognized code). Not retryable: resending the same request fails again.
 */
export class CursorProtocolError extends ChatProviderError {
  readonly code: string;
  readonly debugError: string | null;
  readonly title: string | null;
  readonly isRetryable: boolean = false;

  /**
   * Create a protocol error, preserving the upstream code and debug details.
   */
  constructor(message: string, init?: CursorErrorInit) {
    super(message);
    this.name = 'CursorProtocolError';
    this.code = init?.code ?? 'unknown';
    this.debugError = init?.debugError ?? null;
    this.title = init?.title ?? null;
  }
}

/**
 * Business-layer model failure (`not_found` with an `ERROR_*` debug code
 * such as `ERROR_BAD_MODEL_NAME`). Not retryable.
 */
export class CursorModelError extends ChatProviderError {
  readonly code: string;
  readonly debugError: string | null;
  readonly title: string | null;
  readonly isRetryable: boolean = false;

  /**
   * Create a model error, preserving the upstream code and debug details.
   */
  constructor(message: string, init?: CursorErrorInit) {
    super(message);
    this.name = 'CursorModelError';
    this.code = init?.code ?? 'unknown';
    this.debugError = init?.debugError ?? null;
    this.title = init?.title ?? null;
  }
}

/**
 * Quota or pool failure (`resource_exhausted`, delivered as an EOS trailer on
 * HTTP 200). Retryable only when the trailer advertises `isRetryable: true`
 * (pool queue / High Load, read from `error.details[i].debug.details`
 * with top-level fallbacks); quota errors arrive with `isRetryable: false` and
 * must not be retried. Defaults to false when the trailer omits the field.
 */
export class CursorResourceError extends ChatProviderError {
  readonly code: string;
  readonly debugError: string | null;
  readonly title: string | null;
  readonly isRetryable: boolean;

  /**
   * Create a resource error, preserving the upstream code, debug details, and
   * trailer-advertised retryability (default false).
   */
  constructor(message: string, init?: CursorErrorInit) {
    super(message);
    this.name = 'CursorResourceError';
    this.code = init?.code ?? 'unknown';
    this.debugError = init?.debugError ?? null;
    this.title = init?.title ?? null;
    this.isRetryable = init?.isRetryable ?? false;
  }
}

/**
 * Classify an EndStream trailer map into the matching cursor error.
 * Trailers without an `error` entry mean success and return `null`.
 * Unrecognized codes fall back to {@link CursorProtocolError} with the
 * original code preserved.
 */
export function classifyTrailerError(
  trailers: TrailerMap,
): CursorProtocolError | CursorModelError | CursorResourceError | null {
  const rawError: unknown = trailers?.['error'];
  if (rawError === null || rawError === undefined) return null;
  if (typeof rawError === 'string') {
    return new CursorProtocolError(rawError, { code: 'unknown' });
  }
  if (typeof rawError !== 'object') {
    return new CursorProtocolError(String(rawError), { code: 'unknown' });
  }
  const err = rawError as Record<string, unknown>;
  const details = asDetailsArray(err['details']);
  const detailEntry = firstDetailWithDebug(details);
  const code = asString(err['code']) ?? asString(detailEntry?.['code']) ?? 'unknown';
  const debug = asRecord(err['debug']) ?? asRecord(detailEntry?.['debug']);
  const debugError = debug !== null ? asString(debug['error']) : null;
  const title =
    (debug !== null ? asString(debug['title']) : null) ??
    asString(err['title']) ??
    firstNestedDetailsTitle(details);
  const message = asString(err['message']) ?? title ?? code;
  const isRetryable =
    asBoolean(err['isRetryable']) ??
    (debug !== null ? asBoolean(debug['isRetryable']) : undefined) ??
    firstBooleanInDetails(details, (entry) => entry['isRetryable']) ??
    firstBooleanInDetails(details, (entry) => asRecord(entry['debug'])?.['isRetryable']) ??
    firstBooleanInDetails(details, (entry) => asRecord(asRecord(entry['debug'])?.['details'])?.['isRetryable']) ??
    false;
  const init: CursorErrorInit = { code, debugError, title, isRetryable };
  switch (code.toLowerCase()) {
    case 'resource_exhausted':
      return new CursorResourceError(message, init);
    case 'not_found':
      return new CursorModelError(message, init);
    default:
      return new CursorProtocolError(message, init);
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Return the first `details` entry carrying a `debug` record (real-device
 * quota/limit errors nest it at `error.details[0].debug` instead of
 * `error.debug`), or `null` when no entry qualifies.
 */
function firstDetailWithDebug(value: unknown): Record<string, unknown> | null {
  for (const entry of asDetailsArray(value)) {
    if (asRecord(entry['debug']) !== null) return entry;
  }
  return null;
}

/** Coerce an unknown `details` value to its entry records (non-array → empty). */
function asDetailsArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record !== null) out.push(record);
  }
  return out;
}

/**
 * First boolean found by `pick` across the `details` entries (the real
 * gateway advertises retryability at
 * `error.details[i].debug.details.isRetryable`); `undefined` when absent.
 */
function firstBooleanInDetails(
  details: Record<string, unknown>[],
  pick: (entry: Record<string, unknown>) => unknown,
): boolean | undefined {
  for (const entry of details) {
    const found = asBoolean(pick(entry));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** First `details[i].debug.details.title` string across the entries, if any. */
function firstNestedDetailsTitle(details: Record<string, unknown>[]): string | null {
  for (const entry of details) {
    const nested = asRecord(asRecord(entry['debug'])?.['details']);
    const title = nested !== null ? asString(nested['title']) : null;
    if (title !== null) return title;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
