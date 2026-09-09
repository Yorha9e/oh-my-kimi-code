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
  computeBlobId,
  mapTurnEndedUsage,
  toTokenDetails,
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
  /** Called when a turn ends with the accumulated usage (for budget replay). */
  readonly onUsage?: (usage: TokenUsage) => void;
  /** Called with each server-issued blob (KV set_blob_args). Implementations
   * keep the payload for the get_blob_args answer channel. */
  readonly onBlob?: (blob: { id: string; value: string }) => void;
  /** Called for each get_blob_args with the answer hit/miss outcome. */
  readonly onKvGet?: (outcome: { id: string; hit: boolean }) => void;
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
  /**
   * Every server-issued turn blob id in `setBlobArgs` arrival order — the chain
   * the server replays to rebuild history. Two failure modes to guard: slicing
   * or filtering the list drops the assistant answer (the turn a continuation
   * must recall), while admitting non-turn blobs — intra-turn step fragments,
   * reference packs — makes the server's hydrate fail to parse it. Root-prompt
   * blobs are split off into {@link _rootPromptIds}, steps skipped on arrival.
   */
  private _turnIds: string[] = [];
  /**
   * Leading root-prompt blob ids (system message + rules payload). The wire
   * keeps them in `rootPromptMessagesJson` (field 1), not in `turns`
   * (field 8); they are split out on arrival.
   */
  private _rootPromptIds: string[] = [];
  /** Self-issued conversation id (`agent-<uuid>`), sent from the 2nd run on. */
  private _conversationId: string | null = null;
  /** The previous run's id — the request that produced the wrapped turn. */
  private _lastRunId: string | null = null;
  /**
   * The last state blob the server pushed (mini ConversationStateStructure
   * with f8 referencing the round's turns) — the anchor the next outgoing
   * user message mounts against.
   */
  private _latestStateBlobId: string | null = null;
  /**
   * Prompt-message blob ids (role JSON: system / rules / user / assistant),
   * in arrival order. `rootPromptMessagesJson` is the context list the
   * prompt renderer actually consumes; the round's user and assistant
   * messages belong there, appended after the initial roots.
   */
  private _promptMessageIds: string[] = [];
  /** Most recent run's accumulated usage, replayed as tokenDetails budget. */
  private _lastUsage: TokenUsage | null = null;
  /** KV answer-channel diagnostics. */
  private _kvGets = 0;
  private _kvHits = 0;
  private _kvMisses = 0;

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

  /**
   * Continuation turn pointer: the id of the last PROTO-encoded turn blob.
   * The wire field holds a single reference the server hydrates as binary
   * proto — a JSON-plain message blob there (e.g. the assistant answer)
   * crashes the parse with `invalid end group tag`. The chain itself is
   * expanded by the server following the aggregate state blob, so one valid
   * pointer is all a continuation needs.
   */
  get turnBlobIds(): readonly string[] {
    for (let index = this._turnIds.length - 1; index >= 0; index -= 1) {
      const id = this._turnIds[index]!;
      const raw = Buffer.from(this._blobStore.get(id) ?? '', 'base64');
      if (raw[0] !== 0x7b) return [id];
    }
    return [];
  }

  /** Leading root-prompt blob ids (system message + rules), when issued. */
  get rootPromptIds(): readonly string[] {
    return this._rootPromptIds;
  }

  /** Blob payload store backing the KV answer channel. */
  get blobStore(): ReadonlyMap<string, string> {
    return this._blobStore;
  }

  /**
   * The last round wrapped as the official `AgentConversationTurnStructure`
   * (source-verified field list): f1 references the server-issued user turn
   * blob (32B id), f2 references the round's native step blobs (32B ids, in
   * issuance order — the official replay expects thinking steps before the
   * assistant step, which is the order the server pushes them in), and f3
   * carries the round's request uuid. All referenced blobs are server-issued
   * and already cached locally; only the wrapper itself is new and registered
   * in the KV store for the hydrate's `getBlobArgs`.
   */
  private conversationTurnBlob(): { id: string; value: string } | undefined {
    const userTurn = this.lastProtoTurnBlob();
    if (userTurn === undefined) return undefined;
    let steps = this.nativeStepBlobIds();
    if (steps.length === 0) {
      // Some rounds issue no native step blobs (short replies skip the step
      // stream). Build the assistant step then — same proto shape the server
      // generates, with monotonic timestamps, registered in the KV store so
      // the hydrate's getBlobArgs resolves it.
      const built = this.buildAssistantStep();
      if (built === undefined) return undefined;
      steps = [built.idRaw];
    }
    const agentTurn = Buffer.concat([
      lengthDelimited(1, userTurn.idRaw),
      ...steps.map((idRaw) => lengthDelimited(2, idRaw)),
      lengthDelimited(3, Buffer.from(this._lastRunId, 'utf8')),
    ]);
    const conversationTurn = lengthDelimited(1, agentTurn);
    const value = conversationTurn.toString('base64');
    const id = computeBlobId(conversationTurn);
    this._blobStore.set(id, value);
    return { id, value };
  }

  /**
   * Encode the last JSON answer as a ConversationStep{assistant_message}
   * blob — the same shape the server generates natively (AssistantMessage:
   * f1 text, f2/f3 optional started/completed ms). Returns the raw id and
   * registers the blob in the KV store.
   */
  private buildAssistantStep(): { idRaw: Buffer } | undefined {
    for (let index = this._turnIds.length - 1; index >= 0; index -= 1) {
      const raw = Buffer.from(this._blobStore.get(this._turnIds[index]!) ?? '', 'base64');
      if (raw[0] !== 0x7b) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        continue;
      }
      const message = parsed as { role?: unknown; content?: unknown };
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      const text = message.content
        .map((part) => (part as { type?: string; text?: string }).type === 'text' ? (part as { text?: string }).text ?? '' : '')
        .join('');
      if (text === '') continue;
      const completed = Date.now();
      const started = Math.max(0, completed - 1000);
      const assistantMessage = Buffer.concat([
        lengthDelimited(1, Buffer.from(text, 'utf8')),
        varintField(2, started),
        varintField(3, completed),
      ]);
      const step = lengthDelimited(1, assistantMessage);
      const id = computeBlobId(step);
      this._blobStore.set(id, step.toString('base64'));
      return { idRaw: Buffer.from(id, 'base64') };
    }
    return undefined;
  }

  /**
   * The server-issued native step blobs of the round (proto ConversationStep:
   * a top-level f1 assistant_message / f2 tool_call / f3 thinking_message
   * oneof), in issuance order. JSON messages are skipped — they are the
   * AI-SDK rendering, not the steps the server hydrates with.
   */
  private nativeStepBlobIds(): Buffer[] {
    const ids: Buffer[] = [];
    for (const id of this._turnIds) {
      const raw = Buffer.from(this._blobStore.get(id) ?? '', 'base64');
      if (raw[0] !== 0x0a && raw[0] !== 0x12 && raw[0] !== 0x1a) continue;
      const fields = protoFields(raw);
      const isStep = fields.some((field) => field.fieldNo === 1 || field.fieldNo === 2 || field.fieldNo === 3);
      // A ConversationStep's oneof payload is a nested message; a bare text
      // field 1 (a UserMessage) opens with readable text instead.
      const f1 = fields.find((field) => field.fieldNo === 1);
      const nested = f1 !== undefined && f1.payload.length > 0 && f1.payload[0] === 0x0a;
      if (isStep && (f1 === undefined || nested)) ids.push(Buffer.from(id, 'base64'));
    }
    return ids;
  }

  /**
   * The last proto turn issued by the server, as its blob id (raw 32 bytes).
   * The server already holds this blob, so the turn reference points at
   * content it can fetch on its own.
   */
  private lastProtoTurnBlob(): { idRaw: Buffer } | undefined {
    for (let index = this._turnIds.length - 1; index >= 0; index -= 1) {
      const id = this._turnIds[index]!;
      const raw = Buffer.from(this._blobStore.get(id) ?? '', 'base64');
      if (raw[0] === 0x7b) continue;
      // A UserMessage opens with f1 = raw text; a step opens with f1 wrapping
      // a nested message. The turn blob is the one with readable text.
      const fields = protoFields(raw);
      const f1 = fields.find((field) => field.fieldNo === 1);
      if (f1 === undefined || f1.payload.length === 0) continue;
      if (f1.payload[0] === 0x0a) continue; // step, not a user message
      if (!isReadableText(f1.payload)) continue;
      return { idRaw: Buffer.from(id, 'base64') };
    }
    return undefined;
  }

  /**
   * The state anchor the outgoing user message mounts against: a
   * ConversationState blob constructed here — the base state the server
   * pushed at round start (roots + workspace) plus an f8 reference to the
   * round's ConversationTurn blob. The prompt renderer expands history by
   * recursing from this anchor and following f8 to the turns; referencing a
   * turn blob directly (or an empty initial state) yields either mis-parse
   * or an empty history. The constructed blob is registered in the KV store
   * for the hydrate's getBlobArgs.
   */
  private stateAnchorId(): string | undefined {
    const baseState = this._latestStateBlobId;
    if (baseState === null) return undefined;
    const turn = this.conversationTurnBlob();
    if (turn === undefined) return undefined;
    const baseRaw = Buffer.from(this._blobStore.get(baseState) ?? '', 'base64');
    if (baseRaw.length === 0) return undefined;
    // Append f8 (tag 0x42, 32B) referencing the turn. The base state carries
    // roots/workspace but no f8 of its own; appending (rather than splicing)
    // is wire-equivalent for a repeated field.
    const stateWithTurn = Buffer.concat([
      baseRaw,
      Buffer.from('4220', 'hex'),
      Buffer.from(turn.id, 'base64'),
    ]);
    const id = computeBlobId(stateWithTurn);
    this._blobStore.set(id, stateWithTurn.toString('base64'));
    return id;
  }

  /** KV answer-channel diagnostics: {gets, hits, misses}. */
  get kvDiagnostics(): { gets: number; hits: number; misses: number } {
    return { gets: this._kvGets, hits: this._kvHits, misses: this._kvMisses };
  }

  /** Most recent run's accumulated usage (null before the first completed run). */
  get lastUsage(): TokenUsage | null {
    return this._lastUsage;
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
    if (this._conversationId === null) {
      this._conversationId = `agent-${randomUUID()}`;
    }
    // The continuation turn: the last round wrapped as the official
    // AgentConversationTurnStructure, referencing the server-issued user
    // turn and native step blobs (f3 carries the ROUND-1 request id — the
    // request that produced the referenced turn). Only set from the second
    // run on, when a previous round exists to wrap.
    let continuationTurn: string | undefined;
    if (this._lastRunId !== null) {
      const wrapped = this.conversationTurnBlob();
      if (wrapped !== undefined) continuationTurn = wrapped.id;
    }
    this._lastRunId = runId;
    const firstFrame = buildRunRequest({
      modelId: this._model,
      history,
      systemPrompt,
      modelParams: this.effectiveModelParams(),
      tools,
      runId,
      checkpoint: this._checkpoint ?? undefined,
      turns: continuationTurn !== undefined ? [continuationTurn] : undefined,
      // rootPromptMessagesJson is the context list the prompt renderer
      // consumes: initial roots followed by every message blob (user /
      // assistant) the round produced, in arrival order.
      rootPromptIds:
        [...this._rootPromptIds, ...this._promptMessageIds].length > 0
          ? [...this._rootPromptIds, ...this._promptMessageIds]
          : undefined,
      // State anchor (UserMessage.f10): mounts the question against the same
      // state snapshot the round's user turn carries — taken verbatim from
      // that turn's f10, the server's own anchor.
      stateAnchorId: this.stateAnchorId() ?? undefined,
      // Self-issued conversation id, sent from the FIRST run on and reused
      // for the whole session (CLI shape): the server claims the session
      // under the client-provided id, so a round2-only id has no session.
      conversationId: this._conversationId,
      workspace: this._workspace,
      // Budget replay (agent.v1 field 5): the CLI persists the server-issued
      // checkpoint budget and sends it back on resume; we rebuild the same
      // shape from the previous run's usage so the server sees the expected
      // field on continuation runs.
      tokenDetails: this._lastUsage === null ? undefined : toTokenDetails(this._lastUsage),
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
      onUsage: (usage) => {
        this._lastUsage = usage;
      },
      onKvGet: (outcome) => {
        this._kvGets += 1;
        if (outcome.hit) this._kvHits += 1;
        else this._kvMisses += 1;
      },
      onBlob: (blob) => {
        if (!this._blobStore.has(blob.id)) {
          this._blobStore.set(blob.id, blob.value);
        }
        // Every server-issued blob is tracked in arrival order. Steps are NOT
        // turn references on their own — handing one to `turns` crashes the
        // hydrate — but they are the round's history halves: the official
        // AgentConversationTurnStructure's steps array references exactly
        // these native blobs, so they must be kept for the wrapper to point
        // at.
        switch (classifyBlob(blob.value)) {
          case 'pack':
            // The server pushes state snapshots throughout the round; the
            // LAST one carries the round's turns (f8) and is the anchor the
            // next question mounts against.
            this._latestStateBlobId = blob.id;
            break;
          case 'root':
            if (!this._rootPromptIds.includes(blob.id)) this._rootPromptIds.push(blob.id);
            break;
          case 'user':
          case 'assistant':
            // Prompt-message blobs: `rootPromptMessagesJson` is the actual
            // context list the prompt renderer consumes — the server puts
            // every message there, system/rules first, then the round's
            // user/assistant turns. Record them in arrival order so the next
            // request replays the full conversation.
            if (!this._promptMessageIds.includes(blob.id)) this._promptMessageIds.push(blob.id);
            if (!this._turnIds.includes(blob.id)) this._turnIds.push(blob.id);
            break;
          default:
            if (!this._turnIds.includes(blob.id)) this._turnIds.push(blob.id);
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
          options.onKvGet?.({
            id: typeof id === 'string' ? id : '',
            hit: value !== undefined,
          });
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
              // Surface the accumulated usage so the provider can replay the
              // budget as tokenDetails on the next continuation run.
              options.onUsage?.(this._usage);
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
 * True when a blob payload is a reference pack (state snapshot / aggregate
 * index) rather than a message. A pack's field 1 is a nested proto that opens
 * with a 32-byte length-delimited entry (`0a 20 <32B blob id>`) — either at
 * the top level or one level down (`0a <len> 0a 20 …`). Message blobs open
 * with readable text/plain JSON instead.
 *
 * A payload that starts with `{` is NOT a pack: the server issues system,
 * rules, user and — critically — assistant messages as plain JSON, and the
 * assistant message is what a continuation must recall. Treating JSON as a
 * pack dropped the assistant turn from `turns` and left resumptions
 * memoryless (gateway tap measured flat inputTokens across rounds).
 */
function isStateSnapshotBlob(data: string): boolean {
  if (data === '') return false;
  let raw: Buffer;
  try {
    raw = Buffer.from(data, 'base64');
  } catch {
    return true;
  }
  if (raw.length === 0) return true;
  if (raw[0] !== 0x0a) return false; // message blobs start with text or '{'
  // field 1, wire type 2: read the varint length, then inspect the payload.
  let i = 1;
  let len = 0;
  let shift = 0;
  for (; i < raw.length; i += 1) {
    const b = raw[i]!;
    len |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) return false;
  }
  const inner = raw.subarray(i + 1);
  // A pack either holds a 32-byte blob id directly (len === 32) or nests a
  // proto that opens with one (`0a 20 <32B>`).
  if (len === 32) return true;
  return inner.length >= 2 && inner[0] === 0x0a && inner[1] === 0x20;
}

/**
 * Classify a server-issued blob so the continuation can replay the right set:
 * - `pack`: a reference container (state snapshot / aggregate index) — never a
 *   turn; the server fails to parse it as one.
 * - `root`: a leading root-prompt message (system prompt, rules).
 * - `assistant` / `user`: a complete conversation turn.
 * - `step`: an intra-turn fragment (thinking / intermediate text) issued while
 *   the assistant is composing its answer. Steps are NOT turns — including
 *   them in `turns` crashes the server's hydrate with `illegal tag` (gateway
 *   tap: a 49B and a 75B fragment were the culprits).
 * - `other`: unclassified binary, treated as a turn so history is not dropped.
 */
function classifyBlob(data: string): 'pack' | 'root' | 'assistant' | 'user' | 'step' | 'other' {
  let raw: Buffer;
  try {
    raw = Buffer.from(data, 'base64');
  } catch {
    return 'pack';
  }
  if (raw.length === 0) return 'pack';
  if (raw[0] === 0x7b) {
    // Plain JSON message: its top-level `role` decides the class.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return 'other';
    }
    if (typeof parsed !== 'object' || parsed === null) return 'other';
    const role = (parsed as { role?: unknown }).role;
    if (role === 'assistant') return 'assistant';
    if (role === 'system') return 'root';
    if (role === 'user') return isRulesPayload(parsed) ? 'root' : 'user';
    return 'other';
  }
  if (isStateSnapshotBlob(data)) return 'pack';
  // Binary fragment: field 3 (thinking_message) is a ConversationStep's oneof
  // member, and a field-1 payload that is a single plain-text field is a
  // step's assistant_message. Either way it is a step, not a turn.
  return isStepFragment(raw) ? 'step' : 'other';
}

/**
 * True when a binary blob is a {@code ConversationStep} rather than a turn.
 *
 * Both are encoded as a message body wrapped in an outer field 1, so the outer
 * shape cannot tell them apart — the inner `field 2` can, when present:
 * - a turn carries `messageId` there, a length-delimited string (wire type 2);
 * - a step carries a timestamp there, a varint (wire type 0).
 * Bodies with no second field are plain user messages and stay turns. Counting
 * inner fields does not work either: a step's two fields (text + varint
 * timestamp) look just as numerous as a turn's (text + messageId), which is
 * what mis-classified a 49B step as a turn and crashed the server's hydrate
 * (gateway tap: `illegal tag: field no 6`).
 */
function isStepFragment(raw: Buffer): boolean {
  const outer = firstLengthDelimited(raw);
  if (outer === null) return false;
  // field 3 is thinking_message — unmistakably a step.
  if (outer.fieldNo === 3) return true;
  if (outer.fieldNo !== 1) return false;
  // A payload that is plain readable text is a user message body, not a step:
  // steps wrap their text in a nested field (`0a <len> text`) instead.
  if (isReadableText(outer.payload)) return false;
  // Inspect the inner message's field 2, when it has one: a length-delimited
  // field 2 is the messageId of a real turn, while a varint one is the
  // timestamp of a step. A body with no second field is a plain user message
  // (text only) and stays a turn — erring that way keeps history intact.
  const inner = secondFieldWireType(outer.payload);
  return inner === 0;
}

/**
 * Encode a varint length prefix followed by the payload bytes.
 */
function lengthDelimited(fieldNo: number, payload: Buffer): Buffer {
  const tag = Buffer.of((fieldNo << 3) | 2);
  const len: number[] = [];
  let value = payload.length;
  for (;;) {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    len.push(byte);
    if (value === 0) break;
  }
  return Buffer.concat([tag, Buffer.from(len), payload]);
}

/**
 * Encode a uint64 field as a varint (BigInt-safe for epoch timestamps).
 */
function varintField(fieldNo: number, value: number): Buffer {
  const bytes: number[] = [];
  let rest = BigInt(value);
  for (;;) {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest !== 0n) byte |= 0x80;
    bytes.push(byte);
    if (rest === 0n) break;
  }
  return Buffer.concat([Buffer.of(fieldNo << 3), Buffer.from(bytes)]);
}

/**
 * Walk a protobuf body and return its top-level length-delimited fields.
 */
function protoFields(body: Buffer): { fieldNo: number; payload: Buffer }[] {
  const fields: { fieldNo: number; payload: Buffer }[] = [];
  let i = 0;
  while (i < body.length) {
    let tag = 0;
    let shift = 0;
    for (;;) {
      if (i >= body.length) return fields;
      const b = body[i]!;
      i += 1;
      tag |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) return fields;
    }
    const fieldNo = tag >> 3;
    const wt = tag & 7;
    if (wt === 2) {
      const len = readVarintAt(body, i);
      if (len === null || i + len.value > body.length) return fields;
      i = len.next;
      fields.push({ fieldNo, payload: body.subarray(i, i + len.value) });
      i += len.value;
    } else if (wt === 0) {
      const v = readVarintAt(body, i);
      if (v === null) return fields;
      i = v.next;
    } else if (wt === 5) i += 4;
    else if (wt === 1) i += 8;
    else return fields;
  }
  return fields;
}

/**
 * True when a protobuf payload is plain readable text rather than a nested
 * message: user message bodies arrive as bare text, while steps wrap theirs in
 * a nested field. Reading a bare-text payload as proto would surface a
 * meaningless `field 2` and mis-classify a real turn as a step.
 */
function isReadableText(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const text = buf.toString('utf8');
  // Reject anything with control characters (proto tags / lengths live there).
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
  }
  return true;
}

/** Read the first length-delimited field of a protobuf body. */
function firstLengthDelimited(raw: Buffer): { fieldNo: number; payload: Buffer } | null {
  let i = 0;
  let tag = 0;
  let shift = 0;
  for (;;) {
    if (i >= raw.length) return null;
    const b = raw[i]!;
    i += 1;
    tag |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) return null;
  }
  if ((tag & 7) !== 2) return null;
  let len = 0;
  let ls = 0;
  for (;;) {
    if (i >= raw.length) return null;
    const b = raw[i]!;
    i += 1;
    len |= (b & 0x7f) << ls;
    if ((b & 0x80) === 0) break;
    ls += 7;
    if (ls > 63) return null;
  }
  if (i + len > raw.length) return null;
  return { fieldNo: tag >> 3, payload: raw.subarray(i, i + len) };
}

/**
 * Wire type of the message body's second field, or null when it has none.
 */
function secondFieldWireType(body: Buffer): number | null {
  let i = 0;
  let seen = 0;
  while (i < body.length) {
    let tag = 0;
    let shift = 0;
    for (;;) {
      if (i >= body.length) return null;
      const b = body[i]!;
      i += 1;
      tag |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) return null;
    }
    const wt = tag & 7;
    seen += 1;
    if (wt === 2) {
      const len = readVarintAt(body, i);
      if (len === null) return null;
      i = len.next + len.value;
    } else if (wt === 0) {
      const v = readVarintAt(body, i);
      if (v === null) return null;
      i = v.next;
    } else if (wt === 5) i += 4;
    else if (wt === 1) i += 8;
    else return null;
    if (seen === 2) return wt;
  }
  return null;
}

/** Read a varint at `i`, returning its value and the index after it. */
function readVarintAt(buf: Buffer, i: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (i >= buf.length) return null;
    const b = buf[i]!;
    i += 1;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7;
    if (shift > 63) return null;
  }
}
/**
 * True when a parsed JSON message is the rules payload rather than a
 * conversation turn. The server ships the rules block as a `user` message
 * whose content is one plain string starting with `<rules>`; real user turns
 * carry structured content. Keying on the rules marker rather than on
 * "content is a string" keeps ordinary string-content user messages as turns —
 * classifying those as root prompts would drop them from the history.
 */
function isRulesPayload(parsed: object): boolean {
  const content = (parsed as { content?: unknown }).content;
  return typeof content === 'string' && content.trimStart().startsWith('<rules');
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
