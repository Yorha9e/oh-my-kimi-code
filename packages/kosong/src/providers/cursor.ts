/**
 * Cursor chat provider — embeds the official `@cursor/sdk` Agent runtime as a
 * kosong `ChatProvider` wire.
 *
 * L1 design notes:
 * - The SDK is loaded with a dynamic `import()` inside `generate()` so CLI
 *   startup never pays the ~11MB bundle + native binary cost for users that
 *   never select the cursor wire. Every SDK type below is referenced through
 *   an erased `import()` type query — there is no top-level runtime import of
 *   `@cursor/sdk`.
 * - Auth goes through the M1 global fetch shim (`installCursorAuthShim`):
 *   `setConnectTransportFactory` is unreachable from the SDK entry and the
 *   cloud REST API rejects a raw JWT passed as `apiKey`, so the shim answers
 *   the SDK's `auth/exchange_user_api_key` call with the IDE accessToken while
 *   the SDK's own interceptor keeps the request fingerprint 1:1.
 * - Unlike the other providers this wire is STATEFUL: conversation context
 *   lives in the Cursor backend, so `generate()` bridges sessions — a history
 *   ending in tool results resumes the previous agent, anything else starts a
 *   fresh one. Safety premise: the host drives a sequential loop and each
 *   agent scope owns its own provider instance, so parallel subagents never
 *   share one instance's `lastAgentId`.
 */

import { createAbortError } from '#/errors';
import { extractText, type Message, type StreamedMessagePart, type ToolCall } from '#/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  StreamedMessage,
  ThinkingEffort,
} from '#/provider';
import type { Tool } from '#/tool';
import type { TokenUsage } from '#/usage';
import { DEFAULT_MODEL_ID, installCursorAuthShim } from './cursor-auth-shim';
import { defaultCursorTokenStore, type CursorTokenStore } from './cursor-token';

/**
 * Type-only views of the dynamically loaded SDK module. `import(...)` type
 * queries are fully erased, so they add no startup cost while keeping the
 * stream and tool mapping type-checked against the real SDK declarations.
 */
type SdkAgent = import('@cursor/sdk').SDKAgent;
type SdkCustomTool = import('@cursor/sdk').SDKCustomTool;
type SdkCustomToolContext = import('@cursor/sdk').SDKCustomToolContext;
type SdkCustomToolResult = import('@cursor/sdk').SDKCustomToolResult;
type SdkRun = import('@cursor/sdk').Run;
type SdkStatusMessage = import('@cursor/sdk').SDKStatusMessage;
type SdkTokenUsage = import('@cursor/sdk').TokenUsage;

/** Official Cursor backend. The SDK falls back to this when the env var is unset. */
const OFFICIAL_BACKEND_URL = 'https://api2.cursor.sh';

/**
 * Value handed to the SDK as `apiKey`. The auth shim answers the SDK's
 * `exchange_user_api_key` call with the token-store JWT, so this value is
 * never used for a real request — it only satisfies the SDK's non-empty key
 * check (the T1 probe ran with a placeholder as well).
 */
const PLACEHOLDER_API_KEY = 'kosong-cursor-placeholder';

/**
 * Backend URL pinned into `process.env.CURSOR_BACKEND_URL` by the first
 * `generate()` in this process, or `undefined` while nothing has pinned it.
 */
let pinnedBackendUrl: string | undefined;

export interface CursorOptions {
  /**
   * Runtime model id sent to Cursor. Defaults to {@link DEFAULT_MODEL_ID}
   * ("default" — Auto), the only id the free tier reliably accepts:
   * "auto" / "auto-smart" are display aliases that run validation rejects.
   */
  model?: string;
  /** Working directory for the local Cursor agent. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Gateway base URL. Omit for direct access to the official endpoint.
   *
   * The SDK reads `process.env.CURSOR_BACKEND_URL` at MODULE LOAD time, so the
   * value is pinned before the dynamic import. The env var is process-global:
   * mixing a direct and a gateway cursor provider in one process is rejected
   * with an error naming both backends instead of being worked around.
   */
  baseURL?: string;
  /**
   * API key handed to the SDK (a gateway-issued key in gateway mode). In
   * direct mode the auth shim answers the exchange call, so a placeholder is
   * used and the value never reaches the wire.
   */
  apiKey?: string;
  /**
   * Token supply for the auth shim. Defaults to the process-wide
   * {@link defaultCursorTokenStore} so caching and the single-flight refresh
   * lock are shared across provider instances.
   */
  tokenStore?: CursorTokenStore;
  /**
   * Host-side tool executor. When provided, every mapped custom tool's
   * `execute` callback forwards to it (the Cursor agent loop awaits the
   * result in-process, so the tool round-trip stays inside one SDK run).
   * When omitted, tool calls fail cleanly with `isError` so the loop
   * observes a tool error instead of hanging.
   */
  toolExecutor?: CursorToolExecutor;
  /** Model ids advertised by the shim's synthetic models list. Defaults to the SDK store's `DEFAULT_CURSOR_MODELS`. */
  models?: readonly string[];
}

/**
 * Host-side executor for mapped custom tools. Called from inside the Cursor
 * agent loop's `customTools` execute callback; the returned value (string,
 * JSON value, or `{content, isError}` shape) is handed back to the model as
 * the tool result.
 */
export type CursorToolExecutor = (
  name: string,
  args: Record<string, import('@cursor/sdk').SDKJsonValue>,
  context: { toolCallId?: string },
) => import('@cursor/sdk').SDKCustomToolResult | Promise<import('@cursor/sdk').SDKCustomToolResult>;

/**
 * Map Kimi tool definitions onto the SDK's in-process `customTools` record.
 *
 * Custom tools are surfaced to the model through the SDK's synthetic
 * `custom-user-tools` MCP server, which rides the `mcp` capability group: this
 * provider therefore never sets a `tools` allowlist (the standard toolset
 * includes `mcp`; a non-empty allowlist without `"mcp"` would silently disable
 * every mapped tool).
 *
 * When the provider was constructed with a {@link CursorToolExecutor}, the
 * `execute` callback forwards to it and the tool round-trip stays inside one
 * SDK run. Without one, calls fail cleanly with `isError` so the agent loop
 * observes a tool error instead of hanging or crashing.
 */
function toSdkCustomTools(tools: Tool[], executor: CursorToolExecutor | undefined): Record<string, SdkCustomTool> {
  const record: Record<string, SdkCustomTool> = {};
  for (const tool of tools) {
    record[tool.name] = {
      description: tool.description,
      inputSchema: tool.parameters as Record<string, import('@cursor/sdk').SDKJsonValue>,
      execute: async (args: Record<string, import('@cursor/sdk').SDKJsonValue>, context: SdkCustomToolContext): Promise<SdkCustomToolResult> => {
        if (executor === undefined) {
          return {
            content: [
              {
                type: 'text',
                text: `tool "${tool.name}" has no host-side executor configured; the call was not executed (toolCallId: ${context.toolCallId ?? 'unknown'})`,
              },
            ],
            isError: true,
          };
        }
        try {
          return await executor(tool.name, args, context);
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `tool "${tool.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    };
  }
  return record;
}

/**
 * Pin `process.env.CURSOR_BACKEND_URL` to this instance's backend.
 *
 * MUST run before the dynamic import: the SDK evaluates
 * `process.env.CURSOR_BACKEND_URL || OFFICIAL_BACKEND_URL` at module load, so
 * setting it afterwards would silently route gateway traffic to the official
 * endpoint. Direct mode deletes the env var so the SDK default applies.
 *
 * The process has no committed backend until the first pin (which immediately
 * precedes the SDK module load). Conflicts are only possible after that first
 * pin, so the first generate in a process adopts its own value freely.
 */
function pinBackendUrl(baseURL: string | undefined): void {
  const desired = baseURL ?? OFFICIAL_BACKEND_URL;
  if (pinnedBackendUrl !== undefined && pinnedBackendUrl !== desired) {
    throw new Error(
      `cursor provider: CURSOR_BACKEND_URL is process-global and this process already targets ${pinnedBackendUrl}; ` +
        `this instance requires ${desired}. Direct (no baseURL) and gateway (baseURL) cursor providers ` +
        'cannot be mixed in one process.',
    );
  }
  pinnedBackendUrl = desired;
  if (desired === OFFICIAL_BACKEND_URL) {
    delete process.env['CURSOR_BACKEND_URL'];
  } else {
    process.env['CURSOR_BACKEND_URL'] = desired;
  }
}

/** Collect the trailing run of `role: 'tool'` result messages, if any. */
function trailingToolResults(history: Message[]): Message[] {
  let start = history.length;
  while (start > 0 && history[start - 1]?.role === 'tool') {
    start -= 1;
  }
  return history.slice(start);
}

/** Map tool-call ids to names so serialized tool results can be labeled. */
function toolNameLookup(history: Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of history) {
    for (const call of message.toolCalls) {
      names.set(call.id, call.name);
    }
  }
  return names;
}

/** Render tool results as labeled text blocks the model can correlate. */
function serializeToolResults(results: Message[], names: Map<string, string>): string {
  return results
    .map((message) => {
      const id = message.toolCallId ?? 'unknown';
      const name = names.get(id);
      const label = name === undefined ? `id="${id}"` : `id="${id}" name="${name}"`;
      return `<tool_result ${label}>\n${extractText(message)}\n</tool_result>`;
    })
    .join('\n\n');
}

/**
 * Prompt for a fresh session: the host system prompt rides along (the SDK has
 * no system-prompt field) followed by the latest user text. Only text parts
 * are forwarded — image/audio/video parts are an L1 limitation.
 */
function buildFreshPrompt(systemPrompt: string, history: Message[]): string {
  const lastUser = history.findLast((message) => message.role === 'user');
  const text = lastUser === undefined ? '' : extractText(lastUser);
  return systemPrompt.length > 0 ? `${systemPrompt}\n\n${text}` : text;
}

/** Normalize a `tool_use` block's `input` into the JSON-arguments string. */
function toolArguments(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  return JSON.stringify(input ?? {});
}

/** Map the SDK usage event onto kosong's breakdown. */
function mapUsage(usage: SdkTokenUsage): TokenUsage {
  return {
    // Established SDK event shape: the cache counters map 1:1.
    inputOther: usage.inputTokens,
    // reasoningTokens are a subset of outputTokens on the SDK side; kosong has
    // no separate bucket, so they stay folded into output.
    output: usage.outputTokens,
    inputCacheRead: usage.cacheReadTokens,
    inputCacheCreation: usage.cacheWriteTokens,
  };
}

/**
 * kosong view of one Cursor run: an async iterator over the SDK's
 * `SDKMessage` events plus the post-stream id/usage/finishReason trio.
 */
class CursorStreamedMessage implements StreamedMessage {
  readonly id: string | null;

  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;

  constructor(
    private readonly _agent: SdkAgent,
    private readonly _run: SdkRun,
    private readonly _signal: AbortSignal | undefined,
  ) {
    this.id = _run.id;
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

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    const signal = this._signal;
    const onAbort = (): void => {
      void this._run.cancel().catch(() => {});
    };
    if (signal?.aborted === true) {
      onAbort();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const message of this._run.stream()) {
        switch (message.type) {
          case 'assistant': {
            for (const block of message.message.content) {
              if (block.type === 'text') {
                yield { type: 'text', text: block.text } satisfies StreamedMessagePart;
              } else {
                yield {
                  type: 'function',
                  id: block.id,
                  name: block.name,
                  arguments: toolArguments(block.input),
                } satisfies ToolCall;
              }
            }
            break;
          }
          case 'thinking':
            yield { type: 'think', think: message.text } satisfies StreamedMessagePart;
            break;
          case 'usage':
            this._usage = mapUsage(message.usage);
            break;
          case 'status':
            this._captureStatus(message);
            break;
          default:
            // system / user / tool_call / request / task events are SDK
            // bookkeeping (init echo, in-process tool execution progress) with
            // no counterpart in the kosong part stream.
            break;
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      // Close the SDK handle whenever the stream ends or is dropped/aborted:
      // an http2 session left open at process.exit trips libuv's
      // UV_HANDLE_CLOSING assertion. The conversation itself survives in the
      // backend store — the next generate() resumes it by agent id.
      this._agent.close();
    }
  }

  /** Derive the kosong finish reason from a run status event. */
  private _captureStatus(message: SdkStatusMessage): void {
    if (message.status === 'CREATING' || message.status === 'RUNNING') {
      return;
    }
    this._rawFinishReason = message.status;
    this._finishReason = message.status === 'FINISHED' ? 'completed' : 'other';
  }
}

/**
 * {@link ChatProvider} over the embedded `@cursor/sdk` Agent runtime.
 *
 * Instances are stateful on purpose (`lastAgentId` bridges the Cursor
 * conversation across the tool loop), so hosts should keep one instance per
 * agent scope instead of re-creating it per call. `withThinking` clones share
 * that session state by design, mirroring how other providers share transport
 * state across clones.
 */
export class CursorChatProvider implements ChatProvider {
  readonly name: string = 'cursor';

  private readonly _model: string;
  private readonly _cwd: string | undefined;
  private readonly _baseURL: string | undefined;
  private readonly _apiKey: string | undefined;
  private readonly _gatewayMode: boolean;
  private readonly _tokenStore: CursorTokenStore;
  private readonly _toolExecutor: CursorToolExecutor | undefined;
  private readonly _models: readonly string[] | undefined;
  private _thinkingEffort: ThinkingEffort | null = null;
  private _lastAgentId: string | undefined;

  constructor(options: CursorOptions) {
    this._model = options.model ?? DEFAULT_MODEL_ID;
    this._cwd = options.cwd;
    this._baseURL = options.baseURL;
    this._apiKey = options.apiKey;
    this._gatewayMode = options.apiKey !== undefined;
    this._tokenStore = options.tokenStore ?? defaultCursorTokenStore;
    this._toolExecutor = options.toolExecutor;
    this._models = options.models;
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return this._thinkingEffort;
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    // Both must happen before the dynamic import below: the env var is read at
    // SDK module load, and the shim must wrap global fetch before the SDK can
    // issue its first request.
    pinBackendUrl(this._baseURL);
    // Gateway mode = a non-official backend was pinned (baseURL) or the caller
    // supplied a per-request key (v2 auth material): the exchange call must
    // reach that backend so IT answers with the account-pool token. Direct
    // mode keeps the local IDE-token interception.
    const callApiKey = options?.auth?.apiKey;
    installCursorAuthShim({
      getToken: () => this._tokenStore.getToken(),
      models: this._models,
      passthroughExchange: this._baseURL !== undefined || callApiKey !== undefined,
      backendHost: this._baseURL === undefined ? undefined : new URL(this._baseURL).hostname,
    });

    const { Agent } = await import('@cursor/sdk');

    const customTools = tools.length > 0 ? toSdkCustomTools(tools, this._toolExecutor) : undefined;
    const toolResults = trailingToolResults(history);
    const apiKey = callApiKey ?? this._apiKey ?? PLACEHOLDER_API_KEY;

    let agent: SdkAgent;
    let prompt: string;
    if (toolResults.length > 0 && this._lastAgentId !== undefined) {
      // Tool-loop continuation: feed the results back into the SAME Cursor
      // conversation so the backend checkpointed context stays intact.
      agent = await Agent.resume(this._lastAgentId, {
        apiKey,
        local: { cwd: this._cwd, customTools },
      });
      prompt = serializeToolResults(toolResults, toolNameLookup(history));
    } else {
      agent = await Agent.create({
        model: { id: this._model },
        apiKey,
        local: { cwd: this._cwd, customTools },
      });
      prompt = buildFreshPrompt(systemPrompt, history);
      if (toolResults.length > 0) {
        // Degraded path: tool results without a remembered agent id (fresh
        // provider instance). Ship them to a new conversation instead of
        // failing the loop.
        prompt = `${prompt}\n\n${serializeToolResults(toolResults, toolNameLookup(history))}`;
      }
    }
    this._lastAgentId = agent.agentId;

    options?.onRequestSent?.();
    let run: SdkRun;
    try {
      run = await agent.send(prompt);
    } catch (error) {
      // The handle owns an http2 session and the stream's finally-close cannot
      // run — no CursorStreamedMessage was built — so close it here before the
      // rejection escapes (auth failure, quota, network).
      agent.close();
      throw error;
    }
    // An abort landing during the send window would leave a dispatched but
    // doomed run; cancel it and surface the standard abort error instead of
    // letting the iterator discover it.
    if (options?.signal?.aborted === true) {
      void run.cancel().catch(() => {});
      agent.close();
      throw createAbortError();
    }
    return new CursorStreamedMessage(agent, run, options?.signal);
  }

  /**
   * Cursor's Auto runtime resolves thinking effort server-side; L1 records
   * the effort for observability and passes nothing extra on the wire.
   */
  withThinking(effort: ThinkingEffort): ChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as CursorChatProvider,
      this,
    );
    clone._thinkingEffort = effort;
    return clone;
  }
}
