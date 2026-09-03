import { APIConnectionError, ChatProviderError, throwIfAbortError } from '#/errors';
import * as http2 from 'node:http2';
import { randomUUID } from 'node:crypto';
import { encodeFrame, FRAME_FLAG_TRAILER, FrameDecoder, type Frame } from './frame';

/**
 * One server-to-client frame yielded by a run stream's `responses` iteration.
 */
export type ServerFrame = Frame;

/**
 * Default gateway base URL used when the caller omits `gatewayUrl`.
 */
export const DEFAULT_CURSOR_GATEWAY_URL = 'https://127.0.0.1:51443';

/**
 * Transport used by {@link openRunStream} for the `AgentService/Run` bidi
 * stream. `'auto'` resolves to the `node:http2` transport mirroring the
 * official Cursor SDK: the real gateway never responds while an HTTP/1.1
 * request body stays open, so the undici (fetch) half-duplex path hangs
 * against it and Connect bidi requires HTTP/2. `'undici'` keeps the fetch
 * path (and its `fetchImpl` test seam) for h1-compatible gateways.
 */
export type RunStreamTransport = 'auto' | 'undici' | 'http2';

/**
 * Options for {@link openRunStream}.
 */
export interface OpenRunStreamOptions {
  /** Gateway token sent as `Bearer` auth. */
  token: string;
  /** First-frame `AgentClientMessage` JSON (e.g. `{ runRequest: ... }`). */
  firstFrame: Record<string, unknown>;
  /** Gateway base URL. Defaults to {@link DEFAULT_CURSOR_GATEWAY_URL}. */
  gatewayUrl?: string;
  /** Abort signal forwarded to the transport. */
  signal?: AbortSignal;
  /** Outbound `x-request-id`. Generated when omitted. */
  requestId?: string;
  /** Fetch implementation override (test seam). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Transport selection. Defaults to `'auto'` (http2). */
  transport?: RunStreamTransport;
}

/**
 * Full-duplex handle over one Cursor `AgentService/Run` bidi stream.
 *
 * `responses` yields each decoded server frame in arrival order; the iteration
 * ends after the EndStream trailer frame is yielded (the trailer frame itself
 * is the last item). The iteration is single-use: consume it at most once.
 *
 * `send` writes one encoded frame (5-byte header + payload, see
 * `encodeFrame`) into the request body mid-stream and throws
 * `APIConnectionError` once the stream is closed or errored. `send` may be
 * called before `responses` is first pulled: the connection opens eagerly in
 * {@link openRunStream}, so early sends are buffered in the request body, not
 * dropped. `close` ends the request body (client EOS) and releases the
 * connection; it is idempotent. Call `close` once done reading (or to abort
 * reading early — a pending `responses` iteration then terminates).
 *
 * A failed connect surfaces as an `APIConnectionError` on the first
 * `responses` pull; after a failure `send` throws and `close` is a safe
 * no-op. User aborts propagate unwrapped.
 */
export interface RunStreamHandle {
  /** Server frames in arrival order; ends after the trailer-flag frame. */
  responses: AsyncIterable<ServerFrame>;
  /** Write one encoded frame into the request body mid-stream. */
  send(frameBytes: Uint8Array): void;
  /** End the request body (client EOS) and release the connection. */
  close(): void;
}

const CURSOR_CLIENT_TYPE = 'sdk';
const CURSOR_CLIENT_VERSION = 'sdk-1.0.30';
const RUN_PATH = '/agent.v1.AgentService/Run';
const ERROR_EXCERPT_BYTES = 500;

/**
 * Open a Cursor `AgentService/Run` bidi stream and return a full-duplex
 * handle. The connection opens eagerly (the first frame is written
 * immediately), so `send` works before `responses` is first pulled.
 * Trailer error classification is left to the caller via
 * `classifyTrailerError`. Fetch/http2-level failures throw
 * `APIConnectionError`; HTTP status !ok throws `ChatProviderError` with a
 * body excerpt; user aborts propagate unwrapped.
 */
export function openRunStream(options: OpenRunStreamOptions): RunStreamHandle {
  const transport = options.transport ?? 'auto';
  if (transport === 'undici') return openUndiciRunStream(options);
  return openHttp2RunStream(options);
}

function runHeaders(token: string, requestId: string): Record<string, string> {
  return {
    'content-type': 'application/connect+json',
    authorization: `Bearer ${token}`,
    'x-cursor-client-type': CURSOR_CLIENT_TYPE,
    'x-cursor-client-version': CURSOR_CLIENT_VERSION,
    'x-request-id': requestId,
  };
}

function runUrl(gatewayUrl: string): string {
  return `${gatewayUrl.replace(/\/+$/, '')}${RUN_PATH}`;
}

// ---------------------------------------------------------------------------
// Undici (fetch) transport: streaming request body with `duplex: 'half'`.
// ---------------------------------------------------------------------------

function openUndiciRunStream(options: OpenRunStreamOptions): RunStreamHandle {
  const gatewayUrl = options.gatewayUrl ?? DEFAULT_CURSOR_GATEWAY_URL;
  const requestId = options.requestId ?? randomUUID();
  const url = runUrl(gatewayUrl);
  const headers = runHeaders(options.token, requestId);
  const firstBytes = encodeFrame(JSON.stringify(options.firstFrame));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let bodyState: 'open' | 'closed' | 'errored' = 'open';
  let connectError: unknown = null;
  const markErrored = (error: unknown): void => {
    connectError = error;
    if (bodyState === 'open') {
      bodyState = 'errored';
      try {
        controller?.error(error);
      } catch {
        // Already closed/cancelled — the stored error still surfaces via send().
      }
    }
  };
  const onAbort = (): void => {
    markErrored(options.signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
  };

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(firstBytes);
    },
    cancel() {
      bodyState = 'closed';
    },
  });

  let connectPromise: Promise<Response>;
  try {
    connectPromise = Promise.resolve(
      fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: options.signal,
        duplex: 'half',
      } as RequestInit),
    );
  } catch (error) {
    connectPromise = Promise.reject(error);
  }
  connectPromise.then(undefined, (error: unknown) => markErrored(error));
  options.signal?.addEventListener('abort', onAbort, { once: true });

  async function* iterate(): AsyncGenerator<ServerFrame, void, void> {
    let response: Response;
    try {
      response = await connectPromise;
    } catch (error) {
      throwIfAbortError(error);
      throw new APIConnectionError(`Cursor Run connection failed: ${errorDetail(error)}`);
    }
    if (!response.ok) {
      throw new ChatProviderError(`Cursor Run request failed with HTTP ${response.status}${await errorExcerpt(response)}`);
    }
    if (response.body === null) {
      throw new APIConnectionError('Cursor Run stream ended with an empty response body');
    }
    const reader = response.body.getReader();
    const decoder = new FrameDecoder();
    let trailerSeen = false;
    try {
      for (;;) {
        let read: Awaited<ReturnType<typeof reader.read>>;
        try {
          read = await reader.read();
        } catch (error) {
          throwIfAbortError(error);
          throw new APIConnectionError(`Cursor Run stream failed: ${errorDetail(error)}`);
        }
        if (read.done) break;
        for (const frame of decoder.push(read.value)) {
          if ((frame.flags & FRAME_FLAG_TRAILER) !== 0) {
            // Mark before yielding: the consumer breaks out of the loop on
            // this frame, so code after `yield` would never run.
            trailerSeen = true;
            yield frame;
            return;
          }
          yield frame;
        }
      }
    } finally {
      if (trailerSeen) {
        // The RPC ended cleanly with its trailer while the HTTP response may
        // still be open. Release the reader instead of cancelling: cancelling
        // would abort the whole fetch, and a subsequent close() could never
        // deliver the request-body EOS the server is waiting for.
        reader.releaseLock();
      } else {
        await reader.cancel().catch(() => undefined);
      }
    }
  }

  return {
    responses: iterate(),
    send(frameBytes: Uint8Array): void {
      if (connectError !== null) {
        throwIfAbortError(connectError);
        throw new APIConnectionError(
          `Cursor Run stream is closed, cannot send mid-stream frame: ${errorDetail(connectError)}`,
        );
      }
      if (bodyState !== 'open' || controller === null) {
        throw new APIConnectionError('Cursor Run stream is closed, cannot send mid-stream frame');
      }
      try {
        controller.enqueue(frameBytes);
      } catch (error) {
        throwIfAbortError(error);
        markErrored(error);
        throw new APIConnectionError(`Cursor Run stream failed while sending frame: ${errorDetail(error)}`);
      }
    },
    close(): void {
      if (bodyState !== 'open' || controller === null) return;
      bodyState = 'closed';
      options.signal?.removeEventListener('abort', onAbort);
      try {
        controller.close();
      } catch {
        // Already closed or errored — close stays idempotent.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// node:http2 transport: mirrors the official Cursor SDK session handling.
// ---------------------------------------------------------------------------

function openHttp2RunStream(options: OpenRunStreamOptions): RunStreamHandle {
  const gatewayUrl = options.gatewayUrl ?? DEFAULT_CURSOR_GATEWAY_URL;
  const requestId = options.requestId ?? randomUUID();
  const headers = runHeaders(options.token, requestId);
  const firstBytes = encodeFrame(JSON.stringify(options.firstFrame));

  let session: http2.ClientHttp2Session | null = null;
  let stream: http2.ClientHttp2Stream | null = null;
  let state: 'open' | 'closed' | 'errored' = 'open';
  let failure: unknown = null;
  let sessionClosed = false;
  const decoder = new FrameDecoder();
  const pending: ServerFrame[] = [];
  let streamEnded = false;
  let httpStatusFailure: { status: unknown; excerpt: string } | null = null;
  let waiter: (() => void) | null = null;
  const wake = (): void => {
    const pendingWaiter = waiter;
    waiter = null;
    pendingWaiter?.();
  };
  const closeSession = (): void => {
    if (sessionClosed) return;
    sessionClosed = true;
    options.signal?.removeEventListener('abort', onAbort);
    try {
      // Graceful GOAWAY: in-flight streams complete, then the socket closes,
      // so a client EOS written via close() still reaches the server.
      session?.close();
    } catch {
      // Already closed/destroyed — nothing left to release.
    }
  };
  const fail = (error: unknown): void => {
    if (state !== 'open') return;
    state = 'errored';
    failure = error;
    wake();
    try {
      stream?.destroy();
    } catch {
      // Destroy is best-effort; the stored failure is what surfaces.
    }
    try {
      session?.destroy();
    } catch {
      // Same: the connection is already unusable.
    }
  };
  const onAbort = (): void => {
    fail(options.signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
  };

  try {
    const origin = new URL(gatewayUrl).origin;
    const activeSession = http2.connect(origin);
    session = activeSession;
    activeSession.on('error', (error: Error) => {
      fail(new APIConnectionError(`Cursor Run connection failed: ${errorDetail(error)}`));
    });
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        fail(options.signal.reason);
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    if (state === 'open') {
      const activeStream = activeSession.request({
        ':method': 'POST',
        ':path': RUN_PATH,
        ...headers,
      });
      stream = activeStream;
      activeStream.on('response', (responseHeaders) => {
        const status = responseHeaders[':status'];
        if (status !== 200) {
          httpStatusFailure = { status, excerpt: '' };
        }
      });
      activeStream.on('data', (chunk: Uint8Array) => {
        if (httpStatusFailure !== null) {
          httpStatusFailure.excerpt += new TextDecoder().decode(chunk);
          return;
        }
        for (const frame of decoder.push(chunk)) pending.push(frame);
        wake();
      });
      activeStream.on('end', () => {
        if (httpStatusFailure !== null) {
          const excerpt =
            httpStatusFailure.excerpt === '' ? '' : `: ${httpStatusFailure.excerpt.slice(0, ERROR_EXCERPT_BYTES)}`;
          fail(new ChatProviderError(`Cursor Run request failed with HTTP ${String(httpStatusFailure.status)}${excerpt}`));
          return;
        }
        streamEnded = true;
        wake();
      });
      activeStream.on('close', () => {
        streamEnded = true;
        wake();
      });
      activeStream.on('error', (error: Error) => {
        fail(new APIConnectionError(`Cursor Run stream failed: ${errorDetail(error)}`));
      });
      activeStream.write(firstBytes);
    }
  } catch (error) {
    fail(
      error instanceof ChatProviderError
        ? error
        : new APIConnectionError(`Cursor Run connection failed: ${errorDetail(error)}`),
    );
  }

  async function* iterate(): AsyncGenerator<ServerFrame, void, void> {
    let trailerSeen = false;
    try {
      for (;;) {
        while (pending.length === 0) {
          if (failure !== null) {
            throwIfAbortError(failure);
            throw failure;
          }
          if (streamEnded) return;
          await new Promise<void>((resolve) => {
            waiter = resolve;
          });
        }
        const frame = pending.shift()!;
        if ((frame.flags & FRAME_FLAG_TRAILER) !== 0) {
          // Mark before yielding: the consumer breaks out of the loop on
          // this frame, so code after `yield` would never run.
          trailerSeen = true;
          yield frame;
          return;
        }
        yield frame;
      }
    } finally {
      // On a clean trailer end the caller owns teardown via close() (which
      // ends the request body first, then releases the session). Any other
      // exit releases the session here so a dropped iteration cannot leak it.
      if (!trailerSeen) closeSession();
    }
  }

  return {
    responses: iterate(),
    send(frameBytes: Uint8Array): void {
      if (failure !== null) {
        throwIfAbortError(failure);
        throw new APIConnectionError(
          `Cursor Run stream is closed, cannot send mid-stream frame: ${errorDetail(failure)}`,
        );
      }
      if (state !== 'open' || stream === null || stream.destroyed) {
        throw new APIConnectionError('Cursor Run stream is closed, cannot send mid-stream frame');
      }
      try {
        stream.write(frameBytes);
      } catch (error) {
        throwIfAbortError(error);
        fail(new APIConnectionError(`Cursor Run stream failed while sending frame: ${errorDetail(error)}`));
        throw failure;
      }
    },
    close(): void {
      if (state !== 'open') return;
      state = 'closed';
      try {
        stream?.end();
      } catch {
        // Already ended/destroyed — close stays idempotent.
      }
      closeSession();
    },
  };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function errorExcerpt(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text === '' ? '' : `: ${text.slice(0, ERROR_EXCERPT_BYTES)}`;
  } catch {
    return '';
  }
}
