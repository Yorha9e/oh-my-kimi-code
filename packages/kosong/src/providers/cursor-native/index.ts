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
import { buildRunRequest, mapTurnEndedUsage, type TurnEndedUsageEvent } from './conversation';
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
  private _thinkingEffort: ThinkingEffort | null = null;

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
      runId,
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
   * `execClientMessage` replies produced for exec requests seen on this
   * stream, in arrival order. Each reply is also transmitted mid-stream over
   * the full-duplex Run transport as it is produced; this buffer stays as the
   * observable record (probes and tests read it).
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
    try {
      for await (const frame of stream.responses) {
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
            const reply = await handleExecServerMessage(msg, executor, {
              isPermissionDenied: options.isPermissionDenied,
              isTimeout: options.isTimeout,
            });
            if (reply !== null) {
              const body = reply['execClientMessage'];
              if (isRecord(body)) body['localExecutionTimeMs'] = Date.now() - startedAt;
              this._execReplies.push(reply);
              stream.send(encodeFrame(JSON.stringify(reply)));
            }
          }
          continue;
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
