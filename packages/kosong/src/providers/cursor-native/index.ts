import { throwIfAbortError } from '#/errors';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  HostToolExecutor,
  StreamedMessage,
  ThinkingEffort,
} from '#/provider';
import type { Message, StreamedMessagePart } from '#/message';
import type { Tool } from '#/tool';
import { addUsage, type TokenUsage } from '#/usage';
import { randomUUID } from 'node:crypto';
import {
  buildRunRequest,
  mapTurnEndedUsage,
  type CursorWorkspaceContext,
  type TurnEndedUsageEvent,
} from './conversation';
import {
  classifyTrailerError,
  CursorProtocolError,
  CursorResourceError,
} from './errors';
import { decodeExecServerMessage, handleExecServerMessage } from './exec-tools';
import { decodeFramePayload, encodeFrame, FRAME_FLAG_TRAILER, parseFrameJson, parseTrailers } from './frame';
import { DEFAULT_CURSOR_GATEWAY_URL, openRunStream, type RunStreamTransport } from './run-stream';

/**
 * Constructor options for {@link CursorNativeChatProvider}.
 */
export interface CursorNativeOptions {
  readonly model?: string;
  readonly gatewayUrl?: string;
  readonly apiKey?: string;
  readonly toolExecutor?: HostToolExecutor;
  readonly modelParams?: Readonly<Record<string, string>>;
  readonly toolNameMap?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly maxRetries?: number;
  /** Run transport selection (`'auto'` = http2; undici h1 bidi hangs on open request bodies). Defaults to `'auto'`. */
  readonly transport?: RunStreamTransport;
  readonly isPermissionDenied?: (error: unknown) => boolean;
  readonly isTimeout?: (error: unknown) => boolean;
  /**
   * Workspace context for fresh-run conversation persistence (server
   * checkpoint issuance). Without it the server may never hand out
   * checkpoints, which leaves continuations memoryless.
   */
  readonly workspace?: CursorWorkspaceContext;
}

/**
 * Driver options for {@link CursorNativeStreamedMessage}.
 */
export interface CursorNativeStreamOptions {
  readonly token: string;
  readonly firstFrame: Record<string, unknown>;
  readonly runId: string;
  readonly gatewayUrl: string;
  readonly signal?: AbortSignal;
  readonly requestId?: string;
  readonly fetchImpl?: typeof fetch;
  /** Run transport selection, passed through to `openRunStream`. */
  readonly transport?: RunStreamTransport;
  readonly executor: HostToolExecutor;
  readonly toolNameMap: Readonly<Record<string, string>>;
  readonly maxRetries: number;
  readonly isPermissionDenied?: (error: unknown) => boolean;
  readonly isTimeout?: (error: unknown) => boolean;
  readonly onRequestSent?: () => void;
  /** Called with each server-issued `conversationCheckpointUpdate` payload. */
  readonly onCheckpoint?: (checkpoint: Record<string, unknown>) => void;
  /**
   * Called with each server-issued blob (KV set_blob_args). Implementations
   * keep the payload for the get_blob_args answer channel.
   */
  readonly onBlob?: (blob: { id: string; value: string }) => void;
  /** Blob payload store backing the get_blob_args answer channel. */
  readonly blobStore: ReadonlyMap<string, string>;
}

const DEFAULT_MODEL_ID = 'default';

/**
 * Default cursor public-name to engine tool-name mapping. Entries without a
 * known engine counterpart pass through unchanged so the host executor reports
 * a clean unknown-tool failure; hosts override via `toolNameMap`.
 */
export const DEFAULT_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  shell: 'Bash',
  read: 'Read',
  write: 'Write',
  grep: 'Grep',
  fetch: 'FetchURL',
};

/**
 * `ChatProvider` over the hand-written Connect bidi JSON client. Assembles the
 * M1 frame layer, the M2 conversation mapping, and the M3 exec tool loop:
 * text and thinking deltas stream as parts, `turnEnded` feeds usage, exec
 * requests run through the host `HostToolExecutor` behind the engine
 * permission gate, and EOS trailer errors classify into typed errors.
 */
export class CursorNativeChatProvider implements ChatProvider {
  readonly name: string = 'cursor-native';

  private readonly _model: string;
  private readonly _gatewayUrl: string;
  private readonly _apiKey: string | undefined;
  private readonly _toolExecutor: HostToolExecutor | undefined;
  private readonly _modelParams: Readonly<Record<string, string>>;
  private readonly _toolNameMap: Readonly<Record<string, string>>;
  private readonly _fetchImpl: typeof fetch | undefined;
  private readonly _maxRetries: number;
  private readonly _transport: RunStreamTransport | undefined;
  private readonly _isPermissionDenied: ((error: unknown) => boolean) | undefined;
  private readonly _isTimeout: ((error: unknown) => boolean) | undefined;
  private readonly _workspace: CursorWorkspaceContext | undefined;
  private _thinkingEffort: ThinkingEffort | null = null;
  /** Latest server-issued checkpoint; replayed as `conversationState` on the next generate. */
  private _checkpoint: Record<string, unknown> | null = null;
  /** Server-issued blob payload store (id → base64), backing the KV answer channel. */
  private _blobStore: Map<string, string> = new Map();
  /** Continuation turns: checkpoint-derived blob id list, when issued. */
  private _checkpointTurnIds: string[] | null = null;
  /** Provisional turns: non-JSON, non-snapshot blob ids (no checkpoint yet). */
  private _fallbackTurnIds: string[] = [];

  /**
   * Create a native cursor provider. The token defaults to the constructor
   * `apiKey`; a per-request `options.auth.apiKey` wins when present.
   */
  constructor(options: CursorNativeOptions = {}) {
    this._model = options.model ?? DEFAULT_MODEL_ID;
    this._gatewayUrl = options.gatewayUrl ?? DEFAULT_CURSOR_GATEWAY_URL;
    this._apiKey = options.apiKey;
    this._toolExecutor = options.toolExecutor;
    this._modelParams = options.modelParams ?? {};
    this._toolNameMap = { ...DEFAULT_TOOL_NAME_MAP, ...options.toolNameMap };
    this._fetchImpl = options.fetchImpl;
    this._maxRetries = options.maxRetries ?? 0;
    this._transport = options.transport;
    this._isPermissionDenied = options.isPermissionDenied;
    this._isTimeout = options.isTimeout;
    this._workspace = options.workspace;
  }

  /** Latest server-issued conversation checkpoint, or null on a fresh conversation. */
  get checkpoint(): Record<string, unknown> | null {
    return this._checkpoint;
  }

  /** Continuation turns: checkpoint blob ids when issued, else provisional ids. */
  get turnBlobIds(): readonly string[] {
    return this._checkpointTurnIds ?? this._fallbackTurnIds;
  }

  /** Blob payload store backing the KV answer channel. */
  get blobStore(): ReadonlyMap<string, string> {
    return this._blobStore;
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return this._thinkingEffort;
  }

  /**
   * Build the `AgentClientMessage` first frame and return a lazy
   * {@link StreamedMessage} over the Run stream. `tools` are accepted for
   * interface conformance but not transmitted: no `mcp_tools` field is sent,
   * so custom tool definitions never reach the model.
   */
  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    void tools;
    const token = options?.auth?.apiKey ?? this._apiKey;
    if (token === undefined || token === '') {
      throw new CursorProtocolError(
        'cursor-native: no token for the Run stream; pass apiKey at construction or per-request auth.apiKey (gateway GET /api/cursor/token)',
      );
    }
    const runId = randomUUID();
    const firstFrame = buildRunRequest({
      modelId: this._model,
      history,
      systemPrompt,
      modelParams: this.effectiveModelParams(),
      tools,
      runId,
      checkpoint: this._checkpoint ?? undefined,
      turns: this.turnBlobIds.length > 0 ? [...this.turnBlobIds] : undefined,
      // conversationId is intentionally NOT sent: the CLI's id is
      // server-issued (a locally fabricated `agent-<uuid>` poisons the
      // server's hydrate — two distinct proto-parser crashes observed).
      workspace: this._workspace,
    });
    return new CursorNativeStreamedMessage({
      token,
      firstFrame,
      runId,
      gatewayUrl: this._gatewayUrl,
      signal: options?.signal,
      requestId: randomUUID(),
      fetchImpl: this._fetchImpl,
      transport: this._transport,
      executor: options?.toolExecutor ?? this._toolExecutor ?? missingExecutor(),
      toolNameMap: this._toolNameMap,
      maxRetries: this._maxRetries,
      isPermissionDenied: this._isPermissionDenied,
      isTimeout: this._isTimeout,
      onRequestSent: options?.onRequestSent,
      onCheckpoint: (checkpoint) => {
        this._checkpoint = checkpoint;
      },
      onBlob: (blob) => {
        if (!this._blobStore.has(blob.id)) {
          this._blobStore.set(blob.id, blob.value);
        }
        if (isStateSnapshotBlob(blob.value)) {
          // State pack: its f1 carries the session's blob-id list (the real
          // `turns`) — parse and take it over. Content blobs only feed the
          // answer channel; they are never turns themselves.
          const ids = extractTurnIds(blob.value);
          if (ids !== null && ids.length > 0) this._checkpointTurnIds = ids;
        } else if (this._checkpointTurnIds === null) {
          this._fallbackTurnIds.push(blob.id);
        }
      },
      blobStore: this._blobStore,
    });
  }

  /**
   * Return a shallow copy of this provider with the given thinking effort. The
   * effort rides `RequestedModel.parameters` at generate time.
   */
  withThinking(effort: ThinkingEffort): ChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as CursorNativeChatProvider,
      this,
    );
    clone._thinkingEffort = effort;
    return clone;
  }

  private effectiveModelParams(): Readonly<Record<string, string>> | undefined {
    const effort = this._thinkingEffort;
    const merged: Record<string, string> = {};
    if (effort !== null && effort !== 'off' && effort !== 'on') merged['effort'] = effort;
    for (const [key, value] of Object.entries(this._modelParams)) merged[key] = value;
    return Object.keys(merged).length > 0 ? merged : undefined;
  }
}

/**
 * Lazy `StreamedMessage` over one cursor Run stream. The connection opens on
 * the first iteration; trailer errors throw the classified cursor error.
 */
export class CursorNativeStreamedMessage implements StreamedMessage {
  readonly id: string | null;

  private readonly _options: CursorNativeStreamOptions;
  private readonly _execReplies: Record<string, unknown>[] = [];
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;

  /**
   * Create a streamed message over the given Run driver options.
   */
  constructor(options: CursorNativeStreamOptions) {
    this._options = options;
    this.id = options.runId;
  }

  get usage(): TokenUsage | null {
    return this._usage;
  }

  get finishReason(): FinishReason | null {
    return this._finishReason;
  }

  get rawFinishReason(): string | null {
    return this._rawFinishReason;
  }

  /**
   * Client frames transmitted in response to exec requests, in send order:
   * the result envelope(s) (shell_stream success is event-framed: a stdout
   * event before the exit event) plus the trailing stream-close control
   * frame that completes each exec round trip. Probes and tests read it as
   * the observable record of the exec channel.
   */
  get execReplies(): readonly Record<string, unknown>[] {
    return this._execReplies;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    this._options.onRequestSent?.();
    const executedToolCallIds = new Set<string>();
    let attempt = 0;
    let yielded = 0;
    for (;;) {
      try {
        for await (const part of this.drainOnce(executedToolCallIds)) {
          yielded += 1;
          yield part;
        }
        return;
      } catch (error) {
        throwIfAbortError(error);
        if (yielded === 0 && attempt < this._options.maxRetries && isRetryableCursorError(error)) {
          attempt += 1;
          this._usage = null;
          continue;
        }
        throw error;
      }
    }
  }

  private async *drainOnce(
    executedToolCallIds: Set<string>,
  ): AsyncGenerator<StreamedMessagePart, void, void> {
    const options = this._options;
    const pendingToolCalls = new Map<string, { name: string; argsText: string }>();
    let sawThinking = false;
    const executor = mapToolNames(options.executor, options.toolNameMap, executedToolCallIds);
    const stream = openRunStream({
      token: options.token,
      firstFrame: options.firstFrame,
      gatewayUrl: options.gatewayUrl,
      signal: options.signal,
      requestId: options.requestId,
      fetchImpl: options.fetchImpl,
      transport: options.transport,
    });
    // Drive the response iterator manually instead of `for await`: a plain
    // `break` then exits without invoking the iterator's `return()`, keeping
    // `stream.close()` in the finally block as the only teardown (the EOS it
    // sends is what the server waits for once the turn has ended).
    const responses = stream.responses[Symbol.asyncIterator]();
    try {
      drainLoop: for (;;) {
        const next = await responses.next();
        if (next.done) break;
        const frame = next.value;
        if ((frame.flags & FRAME_FLAG_TRAILER) !== 0) {
          const failure = classifyTrailerError(parseTrailers(decodeFramePayload(frame)));
          if (failure !== null) throw failure;
          break;
        }
        let msg: unknown;
        try {
          msg = parseFrameJson(frame);
        } catch {
          continue;
        }
        const execReq = decodeExecServerMessage(msg);
        if (execReq !== null) {
          const seenId = execToolCallId(execReq.args);
          if (seenId === undefined || !executedToolCallIds.has(seenId)) {
            const startedAt = Date.now();
            const replies = await handleExecServerMessage(msg, executor, {
              isPermissionDenied: options.isPermissionDenied,
              isTimeout: options.isTimeout,
            });
            if (replies !== null) {
              for (const reply of replies) {
                const body = reply['execClientMessage'];
                if (isRecord(body) && body['localExecutionTimeMs'] === undefined) {
                  body['localExecutionTimeMs'] = Date.now() - startedAt;
                }
                this._execReplies.push(reply);
                stream.send(encodeFrame(JSON.stringify(reply)));
              }
            }
          }
          continue;
        }
        // KV channels: the server pushes content-addressed blobs
        // (set_blob_args) and — on continuation runs — asks for blob payloads
        // back (get_blob_args). The get request MUST be answered on the same
        // bidi stream via kvClientMessage.get_blob_result; an unanswered get
        // deadlocks the run (the server's hydrate worker waits forever —
        // gateway tap confirmed 10-minute hangs on un-answered gets).
        const getReq = kvGetBlobOf(msg);
        if (getReq !== null) {
          // CLI shape: kv_client_message.get_blob_result.blob_data only.
          // No blob id inside (matched by request order); the correlation
          // `id` is echoed when the server frame carried one.
          const id = getReq['blobId'];
          const value = typeof id === 'string' ? options.blobStore.get(id) : undefined;
          if (value === undefined) {
            console.warn(`[cursor-native] getBlobArgs for unknown blob ${String(id)}; answering empty`);
          }
          const result: Record<string, unknown> = { getBlobResult: { blobData: value ?? '' } };
          const serverId = kvServerIdOf(msg);
          if (serverId !== null) result['id'] = serverId['id'];
          stream.send(encodeFrame(JSON.stringify({ kvClientMessage: result })));
          continue;
        }
        // Server-issued conversation checkpoint (proto-wire form; the JSON
        // wire carries blobs via KV instead, but keep the notification for
        // parity with the SDK's checkpoint stream).
        const checkpoint = checkpointOf(msg);
        if (checkpoint !== null) {
          options.onCheckpoint?.(checkpoint);
        }
        const kv = kvSetBlobOf(msg);
        if (kv !== null) {
          const id = kv['blobId'];
          const data = kv['blobData'];
          if (typeof id === 'string' && typeof data === 'string') {
            options.onBlob?.({ id, value: data });
          }
        }
        const update = interactionUpdateOf(msg);
        if (update === null) continue;
        for (const [caseKey, payload] of Object.entries(update)) {
          const normalized = caseKey.toLowerCase().replaceAll('_', '');
          if (normalized === 'textdelta') {
            const text = deltaText(payload, ['text', 'delta', 'content']);
            if (text !== null && text !== '') yield { type: 'text', text };
          } else if (normalized === 'thinkingdelta') {
            const think = deltaText(payload, ['text', 'thinking', 'delta', 'content']);
            if (think !== null && think !== '') {
              sawThinking = true;
              yield { type: 'think', think };
            }
          } else if (normalized === 'thinkingcompleted') {
            const think = deltaText(payload, ['text', 'thinking', 'delta', 'content']);
            if (think !== null && think !== '' && !sawThinking) {
              sawThinking = true;
              yield { type: 'think', think };
            }
          } else if (
            normalized === 'toolcallstarted' ||
            normalized === 'partialtoolcall' ||
            normalized === 'toolcalldelta' ||
            normalized === 'toolcallcompleted'
          ) {
            mergeToolCallUpdate(pendingToolCalls, payload, normalized === 'toolcallcompleted');
          } else if (normalized === 'turnended') {
            const event = turnEndedEventOf(payload);
            if (event !== null) {
              const mapped = mapTurnEndedUsage(event);
              this._usage = this._usage === null ? mapped : addUsage(this._usage, mapped);
            }
            // The upstream keeps the bidi stream open after a turn ends
            // (heartbeats continue indefinitely) — the turn, not the stream
            // close, is what bounds one generate() call. Stop consuming here;
            // `stream.close()` in the finally block sends the client EOS.
            // The break must escape the frame loop (`break drainLoop`), or
            // the stream keeps being drained for its endless heartbeats and
            // the iteration never completes.
            break drainLoop;
          }
        }
      }
    } finally {
      stream.close();
    }
    this._finishReason = 'completed';
    this._rawFinishReason = null;
    for (const [toolCallId, call] of pendingToolCalls) {
      if (executedToolCallIds.has(toolCallId)) continue;
      yield { type: 'function', id: toolCallId, name: call.name, arguments: call.argsText === '' ? '{}' : call.argsText };
    }
  }
}

function isRetryableCursorError(error: unknown): boolean {
  return error instanceof CursorResourceError && error.isRetryable;
}

function missingExecutor(): HostToolExecutor {
  return async (name) => ({
    content: [
      {
        type: 'text',
        text: `tool "${name}" has no host-side executor configured; the call was not executed`,
      },
    ],
    isError: true,
  });
}

function mapToolNames(
  executor: HostToolExecutor,
  toolNameMap: Readonly<Record<string, string>>,
  executedToolCallIds: Set<string>,
): HostToolExecutor {
  return (name, args) => {
    const toolCallId = args['toolCallId'];
    if (typeof toolCallId === 'string' && toolCallId !== '') executedToolCallIds.add(toolCallId);
    return executor(toolNameMap[name] ?? name, args);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function execToolCallId(args: Record<string, unknown>): string | undefined {
  const value = args['toolCallId'];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function interactionUpdateOf(msg: unknown): Record<string, unknown> | null {
  if (!isRecord(msg)) return null;
  const inner = msg['interactionUpdate'] ?? msg['interaction_update'];
  return isRecord(inner) ? inner : null;
}

function checkpointOf(msg: unknown): Record<string, unknown> | null {
  if (!isRecord(msg)) return null;
  const inner = msg['conversationCheckpointUpdate'] ?? msg['conversation_checkpoint_update'];
  return isRecord(inner) ? inner : null;
}

/**
 * Extract the `setBlobArgs` payload of a `kvServerMessage` frame. The server
 * uses this channel to hand out content-addressed blobs (turns, root-prompt
 * packs, state snapshots) on the JSON wire.
 */
function kvSetBlobOf(msg: unknown): Record<string, unknown> | null {
  if (!isRecord(msg)) return null;
  const kv = msg['kvServerMessage'] ?? msg['kv_server_message'];
  if (!isRecord(kv)) return null;
  const set = kv['setBlobArgs'] ?? kv['set_blob_args'];
  return isRecord(set) ? set : null;
}

/**
 * Extract the `getBlobArgs` payload of a `kvServerMessage` frame — a request
 * for a blob payload that MUST be answered on the same stream with a
 * `kvClientMessage.get_blob_result`, or the run deadlocks.
 */
function kvGetBlobOf(msg: unknown): Record<string, unknown> | null {
  if (!isRecord(msg)) return null;
  const kv = msg['kvServerMessage'] ?? msg['kv_server_message'];
  if (!isRecord(kv)) return null;
  const get = kv['getBlobArgs'] ?? kv['get_blob_args'];
  return isRecord(get) ? get : null;
}

/**
 * Return the `id` of a `kvServerMessage` frame so the answering
 * `kvClientMessage` can echo the correlation id, or null when absent.
 */
function kvServerIdOf(msg: unknown): Record<string, unknown> | null {
  if (!isRecord(msg)) return null;
  const kv = msg['kvServerMessage'] ?? msg['kv_server_message'];
  if (!isRecord(kv)) return null;
  const id = kv['id'];
  if (id === undefined) return null;
  return { id };
}

/**
 * Extract the session blob-id list (the real `turns`) from a state-pack blob:
 * proto field 1 (repeated bytes, 32-byte entries). Returns null when the
 * payload is not a walkable pack — callers keep their previous turns.
 */
function extractTurnIds(blobData: string): string[] | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(blobData, 'base64');
  } catch {
    return null;
  }
  const ids: string[] = [];
  let i = 0;
  while (i < buf.length) {
    let tag = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) return null;
      const b = buf[i]!;
      i += 1;
      tag |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) return null;
    }
    const fno = tag >> 3;
    const wt = tag & 7;
    if (wt === 2) {
      let len = 0;
      let lshift = 0;
      for (;;) {
        if (i >= buf.length) return null;
        const b = buf[i]!;
        i += 1;
        len |= (b & 0x7f) << lshift;
        if ((b & 0x80) === 0) break;
        lshift += 7;
        if (lshift > 63) return null;
      }
      if (i + len > buf.length) return null;
      if (fno === 1 && len === 32) {
        ids.push(buf.subarray(i, i + 32).toString('base64'));
      }
      i += len;
    } else if (wt === 0) {
      for (;;) {
        if (i >= buf.length) return null;
        const b = buf[i]!;
        i += 1;
        if ((b & 0x80) === 0) break;
      }
    } else if (wt === 5) {
      i += 4;
    } else if (wt === 1) {
      i += 8;
    } else {
      return null;
    }
  }
  return ids.length > 0 ? ids : null;
}

/**
 * True when a blob payload is a state/root-prompt pack rather than a turn:
 * those payloads start with a length-32 length-delimited field (0x0A 0x20)
 * holding a nested blob id, while turn payloads start with a plain text,
 * JSON, or a non-32-length field. Non-ASCII/base64-invalid payloads are
 * treated as turns (keep them — better over-inclusion than dropped history).
 */
function isStateSnapshotBlob(data: string): boolean {
  if (data === '') return false;
  try {
    const head = Buffer.from(data, 'base64');
    if (head.length === 0) return true;
    if (head[0] === 0x7b) return true; // '{' — JSON-plain message, not a Turn proto
    return head.length >= 2 && head[0] === 0x0a && head[1] === 0x20;
  } catch {
    return true;
  }
}

function deltaText(payload: unknown, keys: ReadonlyArray<string>): string | null {
  if (typeof payload === 'string') return payload;
  if (!isRecord(payload)) return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function stringField(record: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function argsTextOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value) || Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function mergeToolCallUpdate(
  pending: Map<string, { name: string; argsText: string }>,
  payload: unknown,
  isCompleted: boolean,
): void {
  const record = isRecord(payload) ? payload : null;
  const nested = record !== null && isRecord(record['toolCall']) ? record['toolCall'] : null;
  const source = nested ?? record;
  if (source === null) return;
  const toolCallId =
    stringField(source, ['toolCallId', 'tool_call_id', 'id', 'callId', 'call_id']) ?? `cursor-${pending.size + 1}`;
  const current = pending.get(toolCallId) ?? { name: '', argsText: '' };
  const name = stringField(source, ['toolName', 'tool_name', 'name']);
  if (name !== undefined) current.name = name;
  const args = argsTextOf(source['args'] ?? source['arguments'] ?? source['input'] ?? source['argsDelta'] ?? source['args_delta']);
  if (args !== undefined) {
    if (isCompleted) {
      if (current.argsText === '') current.argsText = args;
    } else {
      current.argsText += args;
    }
  }
  pending.set(toolCallId, current);
}

function turnEndedEventOf(payload: unknown): TurnEndedUsageEvent | null {
  const record = isRecord(payload) ? payload : null;
  if (record === null) return null;
  return {
    input: record['input'] ?? record['inputTokens'] ?? record['input_tokens'],
    output: record['output'] ?? record['outputTokens'] ?? record['output_tokens'],
    cacheRead: record['cacheRead'] ?? record['cacheReadTokens'] ?? record['cache_read_tokens'],
    cacheWrite: record['cacheWrite'] ?? record['cacheWriteTokens'] ?? record['cache_write_tokens'],
    reasoning: record['reasoning'] ?? record['reasoningTokens'] ?? record['reasoning_tokens'],
  };
}
