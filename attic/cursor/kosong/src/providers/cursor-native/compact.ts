import { extractText, type Message } from '#/message';

import { computeBlobId } from './conversation';
import type { CursorProviderSnapshot } from './index';

/**
 * Options for {@link compactCursorSnapshot}.
 */
export interface CompactCursorSnapshotOptions {
  readonly keptMessages?: Message[];
}

/**
 * Rebuild a cursor provider snapshot in the server's post-compaction shape:
 * the compacted history becomes one `role="user"` summary blob prefixed with
 * `[Previous conversation summary]:`, `rootPromptIds` keep the leading
 * system/rules blobs, `promptMessageIds` shrink to the summary blob plus any
 * kept tail messages, `turnIds` drop every pre-compaction reference,
 * `latestStateBlobId`/`lastRunId` reset so the next generate builds a fresh
 * anchor, and `conversationId`/`lastUsage` carry over. Blobs no longer
 * referenced by the rebuilt id lists are dropped from `blobStore`. The input
 * snapshot is never mutated.
 */
export function compactCursorSnapshot(
  snapshot: CursorProviderSnapshot,
  summaryText: string,
  opts?: CompactCursorSnapshotOptions,
): CursorProviderSnapshot {
  const summaryBytes = Buffer.from(
    JSON.stringify({
      role: 'user',
      content: [{ type: 'text', text: `[Previous conversation summary]:\n${summaryText}` }],
    }),
    'utf8',
  );
  const summaryBlobId = computeBlobId(summaryBytes);
  const kept: Array<{ id: string; value: string }> = [];
  for (const message of opts?.keptMessages ?? []) {
    const blob = keptMessageBlob(message);
    if (blob !== undefined) kept.push(blob);
  }
  const blobStore: Record<string, string> = {};
  for (const id of snapshot.rootPromptIds) {
    const value = snapshot.blobStore[id];
    if (value !== undefined) blobStore[id] = value;
  }
  blobStore[summaryBlobId] = summaryBytes.toString('base64');
  for (const blob of kept) blobStore[blob.id] = blob.value;
  return {
    protocolVersion: snapshot.protocolVersion,
    blobStore,
    turnIds: kept.map((blob) => blob.id),
    promptMessageIds: [summaryBlobId, ...kept.map((blob) => blob.id)],
    rootPromptIds: [...snapshot.rootPromptIds],
    latestStateBlobId: null,
    conversationId: snapshot.conversationId,
    lastRunId: null,
    lastUsage: snapshot.lastUsage === null ? null : { ...snapshot.lastUsage },
  };
}

function keptMessageBlob(message: Message): { id: string; value: string } | undefined {
  if (message.role === 'system') return undefined;
  const text = extractText(message);
  if (text === '') return undefined;
  const bytes = Buffer.from(
    JSON.stringify({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text }],
    }),
    'utf8',
  );
  return { id: computeBlobId(bytes), value: bytes.toString('base64') };
}
