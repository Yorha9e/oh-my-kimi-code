import { extractText, type Message } from '#/message';
import { computeBlobId } from './conversation';
import type { CursorProviderSnapshot } from './index';

/**
 * Encode one intermediate (non-cursor) message as the transcript text carried
 * by an injected `role="user"` JSON blob. Textual parts (`text`, `think`)
 * travel verbatim; every other media part degrades to `[Image]`; assistant
 * tool calls degrade to `[Tool Call: name(args)]`; `tool`-role results degrade
 * to `[Tool Result: text]`. Uniform `user`-blob shape keeps the server-side
 * hydrate on the official packet path; the degradation vocabulary is the v1
 * behavior and may gain fidelity in later versions.
 */
function toInjectedTranscript(message: Message): string {
  if (message.role === 'tool') {
    return `[Tool Result: ${extractText(message)}]`;
  }
  const segments: string[] = [];
  for (const part of message.content) {
    if (part.type === 'text') {
      segments.push(part.text);
    } else if (part.type === 'think') {
      segments.push(part.think);
    } else {
      segments.push('[Image]');
    }
  }
  for (const call of message.toolCalls ?? []) {
    segments.push(`[Tool Call: ${call.name}(${call.arguments ?? '{}'})]`);
  }
  return segments.join('');
}

/**
 * Fold intermediate non-cursor conversation turns into a cursor protocol
 * snapshot so a model switch back to cursor resumes with the full context.
 * Each message becomes one `role="user"` JSON blob (the same packet shape the
 * official compaction result uses): the blob id is registered in `blobStore`
 * and appended to `promptMessageIds` and `turnIds`, `latestStateBlobId` resets
 * to `null` so the next generate builds a fresh state anchor covering the
 * injected turns, and `conversationId` is preserved unchanged. Blob ids
 * already present in `promptMessageIds` are not appended twice, and an empty
 * message list returns the input snapshot unchanged. The input snapshot is
 * never mutated.
 *
 * @param snapshot Current cursor provider snapshot to build on.
 * @param messages Intermediate messages since the last cursor fold, oldest first.
 */
export function injectMessagesIntoCursorSnapshot(
  snapshot: CursorProviderSnapshot,
  messages: readonly Message[],
): CursorProviderSnapshot {
  if (messages.length === 0) {
    return snapshot;
  }
  const blobStore: Record<string, string> = { ...snapshot.blobStore };
  const promptMessageIds: string[] = [...snapshot.promptMessageIds];
  const turnIds: string[] = [...snapshot.turnIds];
  let injected = false;
  for (const message of messages) {
    const bytes = Buffer.from(
      JSON.stringify({ role: 'user', content: toInjectedTranscript(message) }),
      'utf8',
    );
    const id = computeBlobId(bytes);
    blobStore[id] = bytes.toString('base64');
    if (!promptMessageIds.includes(id)) {
      promptMessageIds.push(id);
      injected = true;
    }
    if (!turnIds.includes(id)) {
      turnIds.push(id);
    }
  }
  if (!injected) {
    return snapshot;
  }
  return {
    ...snapshot,
    blobStore,
    promptMessageIds,
    turnIds,
    latestStateBlobId: null,
  };
}
