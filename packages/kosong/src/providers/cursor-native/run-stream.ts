import { APIConnectionError, ChatProviderError, throwIfAbortError } from '#/errors';
import { randomUUID } from 'node:crypto';
import { encodeFrame, FRAME_FLAG_TRAILER, FrameDecoder, type Frame } from './frame';

/**
 * One server-to-client frame yielded by {@link openRunStream}.
 */
export type ServerFrame = Frame;

/**
 * Default gateway base URL used when the caller omits `gatewayUrl`.
 */
export const DEFAULT_CURSOR_GATEWAY_URL = 'https://127.0.0.1:51443';

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
  /** Abort signal forwarded to fetch. */
  signal?: AbortSignal;
  /** Outbound `x-request-id`. Generated when omitted. */
  requestId?: string;
  /** Fetch implementation override (test seam). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const CURSOR_CLIENT_TYPE = 'sdk';
const CURSOR_CLIENT_VERSION = 'sdk-1.0.30';
const RUN_PATH = '/agent.v1.AgentService/Run';
const ERROR_EXCERPT_BYTES = 500;

/**
 * Open a Cursor `AgentService/Run` bidi stream and yield each decoded server
 * frame in arrival order. The iteration ends after the EndStream trailer frame
 * is yielded; trailer error classification is left to the caller via
 * `classifyTrailerError`. The connection is established lazily on the first
 * iteration. Fetch-level network failures throw `APIConnectionError`;
 * user aborts propagate unwrapped.
 */
export async function* openRunStream(options: OpenRunStreamOptions): AsyncGenerator<ServerFrame, void, void> {
  const gatewayUrl = options.gatewayUrl ?? DEFAULT_CURSOR_GATEWAY_URL;
  const requestId = options.requestId ?? randomUUID();
  const url = `${gatewayUrl.replace(/\/+$/, '')}${RUN_PATH}`;
  const body = encodeFrame(JSON.stringify(options.firstFrame));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/connect+json',
        authorization: `Bearer ${options.token}`,
        'x-cursor-client-type': CURSOR_CLIENT_TYPE,
        'x-cursor-client-version': CURSOR_CLIENT_VERSION,
        'x-request-id': requestId,
      },
      body,
      signal: options.signal,
    });
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
        yield frame;
        if ((frame.flags & FRAME_FLAG_TRAILER) !== 0) return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
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
