import { createHash, randomUUID } from 'node:crypto';
import { extractText, type Message } from '#/message';
import type { Tool } from '#/tool';
import type { TokenUsage } from '#/usage';

/**
 * AI SDK UIMessage text content item. Tool results travel in this shape as
 * well: the blob-internal tool-result structure is undocumented on the wire,
 * so results are carried as plain text paired by toolCallId; confirm against
 * a live probe in M4.
 */
export interface CursorUiTextContent {
  type: 'text';
  text: string;
}

/**
 * AI SDK UIMessage reasoning content item mapped from a kosong think part.
 * `signature` carries the provider reasoning signature when present.
 */
export interface CursorUiReasoningContent {
  type: 'reasoning';
  text: string;
  signature?: string;
}

/**
 * AI SDK UIMessage tool-call content item. `args` carries the kosong
 * JSON-arguments string verbatim; whether the wire expects a string or a
 * decoded object is unconfirmed — M4 live probe to decide.
 */
export interface CursorUiToolCallContent {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: string;
}

/**
 * Discriminated content union for one {@link CursorUiMessage} turn.
 */
export type CursorUiContent = CursorUiTextContent | CursorUiReasoningContent | CursorUiToolCallContent;

/**
 * One AI SDK UIMessage turn (role plus discriminated content list) as carried
 * inside `preFetchedBlobs`.
 */
export interface CursorUiMessage {
  role: 'user' | 'assistant';
  content: CursorUiContent[];
  providerOptions?: Record<string, unknown>;
}

/**
 * One `AgentRunRequest.preFetchedBlobs` entry: the blob id plus the turn
 * JSON, both base64-encoded following the proto3 JSON convention for `bytes`
 * fields.
 */
export interface PreFetchedBlob {
  id: string;
  value: string;
}

/**
 * Continuation half of the first frame: the `conversationState` object plus
 * the blob table it references, if any.
 */
export interface ConversationStatePayload {
  conversationState: Record<string, unknown>;
  preFetchedBlobs: PreFetchedBlob[] | undefined;
}

/**
 * Options for {@link buildRunRequest}.
 */
export interface BuildRunRequestOptions {
  /** Upstream model id sent as `requestedModel.modelId`. */
  modelId: string;
  /**
   * Full engine history; the last user message becomes the current input.
   * HISTORY IS ONLY USED FOR THE CURRENT INPUT — continuation context comes
   * from the server-issued checkpoint (see `checkpoint`), never from here.
   */
  history: Message[];
  /**
   * System prompt folded into the leading user message text (SDK shape).
   * Deliberately NOT sent as `customSystemPrompt`: the upstream execution
   * layer converts that field into a CLI `--system-prompt` option whose
   * current builds only accept a file path, so the text form is rejected.
   */
  systemPrompt?: string;
  /** Extra model parameters sent as `requestedModel.parameters`. */
  modelParams?: Readonly<Record<string, string>>;
  /** Outbound run id; generated when omitted. */
  runId?: string;
  /** Upstream conversation id for resuming; omitted for a fresh run. */
  conversationId?: string;
  /**
   * Server-issued conversation checkpoint (the raw
   * `conversationCheckpointUpdate` payload from the previous run's response
   * stream). Replayed verbatim as `conversationState`; the server resolves
   * history content-addressed under the blob ids it issued. When present,
   * `workspace` is ignored.
   */
  checkpoint?: Record<string, unknown>;
  /**
   * Server-issued message blob ids (KV set_blob_args), in arrival order.
   * Sent as `conversationState.turns` — the server resolves each id
   * content-addressed; ids it never issued are ignored, which is why the
   * old self-computed hashes left continuations memoryless.
   */
  turns?: string[];
  /**
   * Server-issued message blob payloads to persist back, sent as
   * `preFetchedBlobs` (f17). The server only keeps what the client writes
   * back (SDK `persistForRemoteRead`); a continuation that sends ids
   * without payloads hangs waiting for content it never stored.
   */
  blobs?: { id: string; value: string }[];
  /**
   * Workspace/git/time context for a FRESH run's `conversationState`. The
   * server uses these to persist the conversation (checkpoint issuance); a
   * conversation with no workspace context may never see checkpoints.
   */
  workspace?: CursorWorkspaceContext;
  /**
   * Engine tools declared to the model via `mcpTools` (field 4). Without a
   * declaration the model cannot request any tool — the exec channel only
   * carries calls for tools the run request advertised.
   */
  tools?: Tool[];
}

/**
 * Fresh-run workspace context folded into `conversationState`
 * (`previousWorkspaceUris` / `activeBranchName` / `agentType` /
 * `conversationStartedTimestampMs` / `conversationStartedTimeZone` per the
 * official agent.v1 schema).
 */
export interface CursorWorkspaceContext {
  /** Absolute working directory; sent as a `file://` URI. */
  cwd?: string;
  /** Current git branch name. */
  branch?: string;
  /** Harness label ("ide" is what the official CLI reports). */
  agentType?: string;
  /** Conversation start epoch milliseconds. */
  timestampMs?: number;
  /** IANA time zone id, e.g. "Asia/Shanghai". */
  timeZone?: string;
}

/**
 * Wire shape of a per-turn `turnEnded` usage event. `reasoning` is accepted
 * for shape completeness but intentionally unmapped: like the SDK route, the
 * reasoning budget stays folded into `output`.
 */
export interface TurnEndedUsageEvent {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  reasoning?: unknown;
}

/**
 * Derive a blob id by hashing the blob bytes with sha256 and base64-encoding
 * the digest. The upstream blob-id algorithm is undocumented; this sha256
 * stands in as a placeholder — M4 must confirm it against a live probe
 * before treating ids as server-meaningful.
 */
export function computeBlobId(blob: string | Uint8Array): string {
  const bytes = typeof blob === 'string' ? new TextEncoder().encode(blob) : blob;
  return createHash('sha256').update(bytes).digest('base64');
}

/**
 * Map kosong history onto AI SDK UIMessage turns. System messages stay out
 * (they travel folded into the leading user message text, see
 * {@link buildRunRequest}); tool messages attach to the assistant turn
 * holding the matching tool-call id, falling back to the latest assistant
 * turn and then to a fresh one. Unsupported media parts are skipped with a
 * warning.
 */
export function toUiTurns(history: Message[]): CursorUiMessage[] {
  const turns: CursorUiMessage[] = [];
  for (const message of history) {
    if (message.role === 'system') {
      continue;
    }
    if (message.role === 'tool') {
      const result: CursorUiTextContent = { type: 'text', text: extractText(message) };
      const owner =
        (message.toolCallId !== undefined ? findToolCallOwner(turns, message.toolCallId) : undefined) ??
        lastAssistantTurn(turns);
      if (owner !== undefined) {
        owner.content.push(result);
      } else {
        turns.push({ role: 'assistant', content: [result], providerOptions: undefined });
      }
      continue;
    }
    const content = toUiContents(message);
    if (content.length === 0) {
      continue;
    }
    turns.push({ role: message.role, content, providerOptions: undefined });
  }
  return turns;
}

/**
 * Split history into the continuation payload: prior turns travel via
 * `preFetchedBlobs` with `conversationState.turns` holding only the blob id
 * list, while the last user message stays out of the blobs (the caller places
 * it in `action.userMessageAction`). Histories without an assistant message
 * yield an empty conversation state and no blobs (probe 3c minimal first
 * frame).
 */
export function buildConversationState(history: Message[]): ConversationStatePayload {
  const currentIndex = history.findLastIndex((message) => message.role === 'user');
  const prior = currentIndex < 0 ? history : history.slice(0, currentIndex);
  if (!prior.some((message) => message.role === 'assistant')) {
    return { conversationState: {}, preFetchedBlobs: undefined };
  }
  const blobs: PreFetchedBlob[] = toUiTurns(prior).map((turn) => {
    const json = JSON.stringify(turn);
    return { id: computeBlobId(json), value: Buffer.from(json, 'utf8').toString('base64') };
  });
  return {
    conversationState: {
      turns: blobs.map((blob) => blob.id),
    },
    preFetchedBlobs: blobs,
  };
}

/**
 * Build the `AgentClientMessage` first frame (`{ runRequest: ... }`) for the
 * Run stream client: the probe-3c shape with
 * `RequestedModel.modelId`, uuid `runId`/`messageId`, and a mandatory
 * `conversationState` object. The system prompt rides the leading user message
 * text (SDK shape) — `customSystemPrompt` is intentionally not used because the
 * upstream execution layer rejects its text form (see {@link BuildRunRequestOptions}).
 */
export function buildRunRequest(options: BuildRunRequestOptions): Record<string, unknown> {
  const lastUser = options.history.findLast((message) => message.role === 'user');
  const userText = lastUser === undefined ? '' : extractText(lastUser);
  const systemText = options.systemPrompt;
  // SDK shape: the system prompt folds into the current input text instead of
  // a dedicated wire field (see `BuildRunRequestOptions.systemPrompt`).
  const text =
    systemText === undefined || systemText === '' ? userText : `${systemText}\n\n${userText}`;
  // Continuation runs replay the server's blob ids as `conversationState.turns`
  // (the server content-addresses history under those ids); a raw checkpoint,
  // when the server ever issues one on this wire, wins over the id list.
  // Fresh runs carry a minimal workspace context so the server can persist
  // the conversation. The old self-invented keys are intentionally gone — the
  // server's JSON parser ignores unknown keys, which is exactly why the
  // previous continuation never saw history.
  const conversationState =
    options.checkpoint ??
    (options.turns !== undefined && options.turns.length > 0
      ? { turns: options.turns }
      : initialConversationState(options.workspace));
  const entries = options.modelParams === undefined ? [] : Object.entries(options.modelParams);
  const blobs = options.blobs !== undefined && options.blobs.length > 0 ? options.blobs : undefined;
  return {
    runRequest: {
      action: {
        userMessageAction: {
          userMessage: { text, messageId: randomUUID() },
          // RequestContext must be present: the upstream rejects first
          // contact without it ("Failed to get request context"). All its
          // fields are optional, so an empty object is the minimal valid form.
          requestContext: {},
        },
      },
      requestedModel: {
        modelId: options.modelId,
        parameters:
          entries.length > 0
            ? entries.map(([id, value]) => ({ id, value }))
            : undefined,
      },
      runId: options.runId ?? randomUUID(),
      conversationState,
      conversationId: options.conversationId,
      preFetchedBlobs: blobs,
      // Tool declaration, mirroring the CLI's wire shape exactly (decoded
      // from the gateway dump): each definition's `name` is
      // `custom-user-tools-<Tool>` — the synthetic MCP server prefix — and
      // `providerIdentifier` is the bare server name. Without the prefix
      // and matching identifier the backend drops the table and the model
      // sees no tools (probe A2's NO-TOOL). `toolName` stays bare; the exec
      // channel pairs on it (McpArgs.toolName) while the model-visible
      // call name rides McpArgs.name with the same prefix.
      mcpTools:
        options.tools === undefined || options.tools.length === 0
          ? undefined
          : {
              mcpTools: options.tools.map((tool) => ({
                name: `custom-user-tools-${tool.name}`,
                description: tool.description,
                inputSchema: tool.parameters,
                providerIdentifier: 'custom-user-tools',
                toolName: tool.name,
              })),
            },
    },
  };
}

/**
 * Map a per-turn `turnEnded` usage event onto kosong `TokenUsage`. Missing or
 * non-numeric fields count as zero so the result never carries NaN.
 */
export function mapTurnEndedUsage(event: TurnEndedUsageEvent): TokenUsage {
  return {
    inputOther: toCount(event.input),
    output: toCount(event.output),
    inputCacheRead: toCount(event.cacheRead),
    inputCacheCreation: toCount(event.cacheWrite),
  };
}

function toUiContents(message: Message): CursorUiContent[] {
  const content: CursorUiContent[] = [];
  for (const part of message.content) {
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text });
    } else if (part.type === 'think') {
      content.push({ type: 'reasoning', text: part.think, signature: part.encrypted });
    } else {
      console.warn(`[cursor-native] skipping unsupported ${part.type} part`);
    }
  }
  for (const call of message.toolCalls ?? []) {
    content.push({ type: 'tool-call', toolCallId: call.id, toolName: call.name, args: call.arguments ?? '{}' });
  }
  return content;
}

function findToolCallOwner(turns: CursorUiMessage[], toolCallId: string): CursorUiMessage | undefined {
  for (const turn of turns) {
    const owns = turn.content.some(
      (item): item is CursorUiToolCallContent => item.type === 'tool-call' && item.toolCallId === toolCallId,
    );
    if (owns) {
      return turn;
    }
  }
  return undefined;
}

function lastAssistantTurn(turns: CursorUiMessage[]): CursorUiMessage | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.role === 'assistant') {
      return turn;
    }
  }
  return undefined;
}

/**
 * Build the fresh-run `conversationState` from the workspace context. Omitted
 * fields stay absent (an empty context yields `{}`, the verified-working
 * first-frame shape). int64 timestamps ride proto3-JSON string form.
 */
function initialConversationState(workspace: CursorWorkspaceContext | undefined): Record<string, unknown> {
  if (workspace === undefined) return {};
  const state: Record<string, unknown> = {};
  if (workspace.cwd !== undefined && workspace.cwd !== '') {
    const uri = `file:///${workspace.cwd.replaceAll('\\', '/')}`;
    state['previousWorkspaceUris'] = [uri];
  }
  if (workspace.branch !== undefined && workspace.branch !== '') {
    state['activeBranchName'] = workspace.branch;
  }
  if (workspace.agentType !== undefined && workspace.agentType !== '') {
    state['agentType'] = workspace.agentType;
  }
  if (workspace.timestampMs !== undefined) {
    state['conversationStartedTimestampMs'] = String(workspace.timestampMs);
  }
  if (workspace.timeZone !== undefined && workspace.timeZone !== '') {
    state['conversationStartedTimeZone'] = workspace.timeZone;
  }
  return state;
}

function toCount(value: unknown): number {
  // proto int64 travels as a JSON string on the Connect wire ("11568").
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
