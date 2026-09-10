import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createUserMessage } from '#/message';
import {
  computeBlobId,
  type BuildRunRequestOptions,
} from '#/providers/cursor-native/conversation';
import {
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
