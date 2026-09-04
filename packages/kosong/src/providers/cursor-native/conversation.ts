import { createHash, randomUUID } from 'node:crypto';
import { extractText, type Message } from '#/message';
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
  /** Full engine history; the last user message becomes the current input. */
  history: Message[];
  /** System prompt sent as `customSystemPrompt`; omitted when empty. */
  systemPrompt?: string;
  /** Extra model parameters sent as `requestedModel.parameters`. */
  modelParams?: Readonly<Record<string, string>>;
  /** Outbound run id; generated when omitted. */
  runId?: string;
  /** Upstream conversation id for resuming; omitted for a fresh run. */
  conversationId?: string;
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
 * (they travel via the run-request system-prompt field); tool messages attach
 * to the assistant turn holding the matching tool-call id, falling back to
 * the latest assistant turn and then to a fresh one. Unsupported media parts
 * are skipped with a warning.
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
 * `conversationState` object. The system prompt rides `customSystemPrompt`;
 * whether `system_prompt_spec` (append) behaves better is left for the M4
 * live probe.
 */
export function buildRunRequest(options: BuildRunRequestOptions): Record<string, unknown> {
  const lastUser = options.history.findLast((message) => message.role === 'user');
  const text = lastUser === undefined ? '' : extractText(lastUser);
  const state = buildConversationState(options.history);
  const entries = options.modelParams === undefined ? [] : Object.entries(options.modelParams);
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
      conversationState: state.conversationState,
      customSystemPrompt:
        options.systemPrompt === undefined || options.systemPrompt === '' ? undefined : options.systemPrompt,
      conversationId: options.conversationId,
      preFetchedBlobs: state.preFetchedBlobs,
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
  for (const call of message.toolCalls) {
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

function toCount(value: unknown): number {
  // proto int64 travels as a JSON string on the Connect wire ("11568").
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
