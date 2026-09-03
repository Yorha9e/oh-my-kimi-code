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
 * HTTP 200). Retryable once capacity recovers.
 */
export class CursorResourceError extends ChatProviderError {
  readonly code: string;
  readonly debugError: string | null;
  readonly title: string | null;
  readonly isRetryable: boolean = true;

  /**
   * Create a resource error, preserving the upstream code and debug details.
   */
  constructor(message: string, init?: CursorErrorInit) {
    super(message);
    this.name = 'CursorResourceError';
    this.code = init?.code ?? 'unknown';
    this.debugError = init?.debugError ?? null;
    this.title = init?.title ?? null;
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
  const code = asString(err['code']) ?? 'unknown';
  const debug = asRecord(err['debug']);
  const debugError = debug !== null ? asString(debug['error']) : null;
  const title = (debug !== null ? asString(debug['title']) : null) ?? asString(err['title']);
  const message = asString(err['message']) ?? title ?? code;
  const init: CursorErrorInit = { code, debugError, title };
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
