import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAssistantMessage, createUserMessage, type Message } from '#/message';
import {
  computeBlobId,
  type BuildRunRequestOptions,
} from '#/providers/cursor-native/conversation';
import { injectMessagesIntoCursorSnapshot } from '#/providers/cursor-native/inject';
import {
  compactCursorSnapshot,
  CursorNativeChatProvider,
  type CursorProviderSnapshot,
} from '#/providers/cursor-native/index';

const buildCalls = vi.hoisted(() => ({
  calls: [] as Array<{ options: BuildRunRequestOptions; result: Record<string, unknown> }>,
}));
const uuidState = vi.hoisted(() => ({ n: 0 }));

vi.mock('#/providers/cursor-native/conversation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/providers/cursor-native/conversation')>();
  return {
    ...actual,
    buildRunRequest: (options: BuildRunRequestOptions) => {
      const result = actual.buildRunRequest(options);
      buildCalls.calls.push({ options, result });
      return result;
    },
  };
});

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () => `00000000-0000-4000-8000-${String(uuidState.n++).padStart(12, '0')}`,
  };
});

function turnBlobBytes(): Buffer {
  const text = Buffer.from('hello-turn', 'utf8');
  return Buffer.concat([Buffer.from([0x0a, text.length]), text]);
}

function stepBlobBytes(): Buffer {
  const text = Buffer.from('thinking', 'utf8');
  const inner = Buffer.concat([Buffer.from([0x0a, text.length]), text]);
  return Buffer.concat([Buffer.from([0x0a, inner.length]), inner]);
}

function jsonBlob(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function makeSnapshot(): CursorProviderSnapshot {
  const turnId = computeBlobId(turnBlobBytes());
  const stepId = computeBlobId(stepBlobBytes());
  const stateId = computeBlobId(Buffer.from('state-base', 'utf8'));
  const systemId = computeBlobId(Buffer.from('sys', 'utf8'));
  const rulesId = computeBlobId(Buffer.from('rules', 'utf8'));
  const userId = computeBlobId(Buffer.from('user', 'utf8'));
  const assistantId = computeBlobId(Buffer.from('assistant', 'utf8'));
  return {
    protocolVersion: 1,
    blobStore: {
      [turnId]: turnBlobBytes().toString('base64'),
      [stepId]: stepBlobBytes().toString('base64'),
      [stateId]: Buffer.from('state-base', 'utf8').toString('base64'),
      [systemId]: jsonBlob({ role: 'system', content: 'sys' }),
      [rulesId]: jsonBlob({ role: 'user', content: '<rules>be brief' }),
      [userId]: jsonBlob({ role: 'user', content: [{ type: 'text', text: 'q1' }] }),
      [assistantId]: jsonBlob({ role: 'assistant', content: [{ type: 'text', text: 'a1' }] }),
    },
    turnIds: [turnId, stepId, userId, assistantId],
    promptMessageIds: [userId, assistantId],
    rootPromptIds: [systemId, rulesId],
    latestStateBlobId: stateId,
    conversationId: 'agent-snapshot-test',
    lastRunId: 'run-snapshot-test-1',
    lastUsage: { inputOther: 100, output: 50, inputCacheRead: 20, inputCacheCreation: 30 },
  };
}

function runRequestOf(frame: Record<string, unknown>): Record<string, unknown> {
  return frame['runRequest'] as Record<string, unknown>;
}

function userMessageOf(runRequest: Record<string, unknown>): Record<string, unknown> {
  const action = runRequest['action'] as Record<string, unknown>;
  const userMessageAction = action['userMessageAction'] as Record<string, unknown>;
  return userMessageAction['userMessage'] as Record<string, unknown>;
}

describe('cursor provider snapshot round-trip', () => {
  beforeEach(() => {
    buildCalls.calls.length = 0;
    uuidState.n = 0;
  });

  it('restores every field verbatim', () => {
    const snapshot = makeSnapshot();
    const provider = new CursorNativeChatProvider({ model: 'default' });

    provider.restoreState(snapshot);

    expect(provider.snapshotState()).toEqual(snapshot);
    expect(provider.rootPromptIds).toEqual(snapshot.rootPromptIds);
    expect(provider.blobStore.size).toBe(Object.keys(snapshot.blobStore).length);
    expect(provider.lastUsage).toEqual(snapshot.lastUsage);
    expect(provider.checkpoint).toBeNull();
  });

  it('replaces pre-existing state instead of merging', () => {
    const snapshot = makeSnapshot();
    const provider = new CursorNativeChatProvider({ model: 'default' });
    const other = makeSnapshot();
    other.blobStore['extra-blob'] = 'ZXh0cmE=';
    other.turnIds.push('extra-blob');
    provider.restoreState(other);

    provider.restoreState(snapshot);

    expect(provider.snapshotState()).toEqual(snapshot);
  });

  it('builds identical first frames from the original and the restored provider', async () => {
    const snapshot = makeSnapshot();
    const history = [createUserMessage('follow-up')];

    const original = new CursorNativeChatProvider({ model: 'default' });
    original.restoreState(snapshot);
    uuidState.n = 0;
    await original.generate('system', [], history, { auth: { apiKey: 'test-key' } });
    expect(buildCalls.calls).toHaveLength(1);
    const firstCall = buildCalls.calls[0]!;

    const restored = new CursorNativeChatProvider({ model: 'default' });
    restored.restoreState(snapshot);
    uuidState.n = 0;
    buildCalls.calls.length = 0;
    await restored.generate('system', [], history, { auth: { apiKey: 'test-key' } });
    expect(buildCalls.calls).toHaveLength(1);
    const secondCall = buildCalls.calls[0]!;

    expect(secondCall.options).toEqual(firstCall.options);
    expect(secondCall.result).toEqual(firstCall.result);

    const runRequest = runRequestOf(firstCall.result);
    const conversationState = runRequest['conversationState'] as Record<string, unknown>;
    const turns = conversationState['turns'] as string[];
    expect(turns).toHaveLength(1);
    expect(original.blobStore.has(turns[0]!)).toBe(true);
    expect(conversationState['rootPromptMessagesJson']).toEqual([
      ...snapshot.rootPromptIds,
      ...snapshot.promptMessageIds,
    ]);
    expect(userMessageOf(runRequest)['conversationStateBlobId']).toBeDefined();
    expect(runRequest['conversationId']).toBe(snapshot.conversationId);
    expect(restored.snapshotState()).toEqual(original.snapshotState());
  });
});

describe('cursor provider local compaction', () => {
  beforeEach(() => {
    buildCalls.calls.length = 0;
    uuidState.n = 0;
  });

  it('compactState collapses history into a summary blob and GCs dead blobs', () => {
    const snapshot = makeSnapshot();
    const provider = new CursorNativeChatProvider({ model: 'default' });
    provider.restoreState(snapshot);

    const compacted = provider.compactState('talked about widgets');

    expect(compacted.conversationId).toBe(snapshot.conversationId);
    expect(compacted.lastRunId).toBeNull();
    expect(compacted.latestStateBlobId).toBeNull();
    expect(compacted.lastUsage).toEqual(snapshot.lastUsage);
    expect(compacted.rootPromptIds).toEqual(snapshot.rootPromptIds);
    expect(compacted.turnIds).toEqual([]);
    expect(compacted.promptMessageIds).toHaveLength(1);
    const summaryId = compacted.promptMessageIds[0]!;
    const summaryJson = JSON.stringify({
      role: 'user',
      content: [{ type: 'text', text: '[Previous conversation summary]:\ntalked about widgets' }],
    });
    expect(summaryId).toBe(computeBlobId(Buffer.from(summaryJson, 'utf8')));
    expect(compacted.blobStore[summaryId]).toBe(Buffer.from(summaryJson, 'utf8').toString('base64'));
    expect(Object.keys(compacted.blobStore).sort()).toEqual(
      [...snapshot.rootPromptIds, summaryId].sort(),
    );
    expect(provider.snapshotState()).toEqual(compacted);
  });

  it('compactCursorSnapshot leaves the input snapshot untouched', () => {
    const snapshot = makeSnapshot();
    const frozen = structuredClone(snapshot);

    const compacted = compactCursorSnapshot(snapshot, 'summary');

    expect(snapshot).toEqual(frozen);
    expect(compacted).not.toEqual(snapshot);
    expect(compacted.conversationId).toBe(snapshot.conversationId);
  });

  it('keeps tail messages after the summary blob', () => {
    const snapshot = makeSnapshot();
    const keptUser = createUserMessage('latest question');
    const keptAssistant = createAssistantMessage([{ type: 'text', text: 'latest answer' }]);

    const compacted = compactCursorSnapshot(snapshot, 'summary', {
      keptMessages: [keptUser, keptAssistant],
    });

    expect(compacted.promptMessageIds).toHaveLength(3);
    expect(compacted.turnIds).toEqual(compacted.promptMessageIds.slice(1));
    const [keptUserId, keptAssistantId] = compacted.turnIds;
    const keptUserJson = JSON.stringify({
      role: 'user',
      content: [{ type: 'text', text: 'latest question' }],
    });
    const keptAssistantJson = JSON.stringify({
      role: 'assistant',
      content: [{ type: 'text', text: 'latest answer' }],
    });
    expect(keptUserId).toBe(computeBlobId(Buffer.from(keptUserJson, 'utf8')));
    expect(keptAssistantId).toBe(computeBlobId(Buffer.from(keptAssistantJson, 'utf8')));
    expect(compacted.blobStore[keptUserId!]).toBe(
      Buffer.from(keptUserJson, 'utf8').toString('base64'),
    );
    expect(compacted.blobStore[keptAssistantId!]).toBe(
      Buffer.from(keptAssistantJson, 'utf8').toString('base64'),
    );
  });

  it('a restored compacted snapshot generates a first frame with only roots and summary', async () => {
    const snapshot = makeSnapshot();
    const compacted = compactCursorSnapshot(snapshot, 'summary here');

    const provider = new CursorNativeChatProvider({ model: 'default' });
    provider.restoreState(compacted);
    uuidState.n = 0;
    await provider.generate('system', [], [createUserMessage('follow-up')], {
      auth: { apiKey: 'test-key' },
    });

    expect(buildCalls.calls).toHaveLength(1);
    const runRequest = runRequestOf(buildCalls.calls[0]!.result);
    const conversationState = runRequest['conversationState'] as Record<string, unknown>;
    expect(conversationState['turns']).toBeUndefined();
    expect(conversationState['rootPromptMessagesJson']).toEqual([
      ...snapshot.rootPromptIds,
      ...compacted.promptMessageIds,
    ]);
    expect(userMessageOf(runRequest)['conversationStateBlobId']).toBeUndefined();
    expect(runRequest['conversationId']).toBe(snapshot.conversationId);
  });
});

function decodedPromptContents(snapshot: CursorProviderSnapshot, ids: string[]): unknown[] {
  return ids.map((id) => JSON.parse(Buffer.from(snapshot.blobStore[id]!, 'base64').toString('utf8')));
}

describe('cursor provider cross-model message injection', () => {
  it('registers one user blob per message and resets the state anchor', () => {
    const snapshot = makeSnapshot();
    const messages: Message[] = [
      createUserMessage('hello from the other model'),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'other model answer' }],
        toolCalls: [],
      },
    ];

    const injected = injectMessagesIntoCursorSnapshot(snapshot, messages);

    expect(injected).not.toBe(snapshot);
    expect(snapshot.promptMessageIds).toHaveLength(2);
    expect(injected.promptMessageIds).toHaveLength(4);
    expect(injected.turnIds.slice(-2)).toEqual(injected.promptMessageIds.slice(-2));
    expect(decodedPromptContents(injected, injected.promptMessageIds.slice(-2))).toEqual([
      { role: 'user', content: 'hello from the other model' },
      { role: 'user', content: 'other model answer' },
    ]);
    for (const id of injected.promptMessageIds.slice(-2)) {
      expect(injected.blobStore[id]).toBeDefined();
    }
    expect(injected.latestStateBlobId).toBeNull();
    expect(injected.conversationId).toBe(snapshot.conversationId);
    expect(injected.rootPromptIds).toEqual(snapshot.rootPromptIds);
  });

  it('degrades rich content to the v1 transcript vocabulary', () => {
    const snapshot = makeSnapshot();
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'image_url', imageUrl: { url: 'https://example.test/chart.png' } },
          { type: 'think', think: 'silent reasoning' },
        ],
        toolCalls: [{ type: 'function', id: 'call-1', name: 'Read', arguments: '{"path":"a"}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'file contents' }],
        toolCalls: [],
        toolCallId: 'call-1',
      },
    ];

    const injected = injectMessagesIntoCursorSnapshot(snapshot, messages);

    expect(decodedPromptContents(injected, injected.promptMessageIds.slice(-2))).toEqual([
      { role: 'user', content: '[Image]silent reasoning[Tool Call: Read({"path":"a"})]' },
      { role: 'user', content: '[Tool Result: file contents]' },
    ]);
  });

  it('returns the input snapshot untouched for empty messages', () => {
    const snapshot = makeSnapshot();
    const before = Object.keys(snapshot.blobStore);

    const injected = injectMessagesIntoCursorSnapshot(snapshot, []);

    expect(injected).toBe(snapshot);
    expect(Object.keys(injected.blobStore)).toEqual(before);
    expect(injected.promptMessageIds).toHaveLength(2);
    expect(injected.latestStateBlobId).toBe(snapshot.latestStateBlobId);
  });
});
