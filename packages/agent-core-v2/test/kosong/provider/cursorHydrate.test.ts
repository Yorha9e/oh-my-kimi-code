import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatProvider } from '#/kosong/contract/provider';
import '#/kosong/provider/bases/cursor/index';
import { clearCursorBridge, setCursorBridge } from '#/kosong/provider/bases/cursor/cursorBridge';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import type { CursorProviderSnapshot } from '#/agent/cursor/cursorState';

function makeSnapshot(tag: string): CursorProviderSnapshot {
  return {
    protocolVersion: 1,
    blobStore: { [`${tag}-blob`]: 'YmxvYi12YWx1ZQ==' },
    turnIds: [`${tag}-blob`],
    promptMessageIds: [],
    rootPromptIds: [],
    latestStateBlobId: null,
    conversationId: `agent-${tag}`,
    lastRunId: `run-${tag}-1`,
    lastUsage: null,
  };
}

interface SnapshotCapable {
  snapshotState(): CursorProviderSnapshot;
  restoreState(snapshot: CursorProviderSnapshot): void;
}

function asSnapshotCapable(provider: ChatProvider): SnapshotCapable {
  return provider as unknown as SnapshotCapable;
}

describe('cursor protocol hydration', () => {
  const registry = new ProtocolAdapterRegistry();
  const snapshot = makeSnapshot('hydrated');
  const testBridge = {
    loadSnapshot: () => snapshot,
    storeSnapshot: () => {},
  };

  afterEach(() => {
    clearCursorBridge(testBridge);
  });

  it('restores the bridged snapshot into a fresh cursor provider', () => {
    setCursorBridge(testBridge);
    const provider = registry.createChatProvider({ protocol: 'cursor', modelName: 'cursor-test' });

    expect(asSnapshotCapable(provider).snapshotState()).toEqual(snapshot);
  });

  it('leaves a fresh cursor provider empty without a bridge', () => {
    const provider = registry.createChatProvider({ protocol: 'cursor', modelName: 'cursor-test' });

    expect(asSnapshotCapable(provider).snapshotState().turnIds).toEqual([]);
    expect(asSnapshotCapable(provider).snapshotState().conversationId).toBeNull();
  });

  it('invokes the explicit hydrate hook with the created provider', () => {
    const hydrate = vi.fn();
    const provider = registry.createChatProvider({
      protocol: 'cursor',
      modelName: 'cursor-test',
      hydrate,
    });

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledWith(provider);
  });

  it('round-trips a snapshot through the adapter', () => {
    const provider = registry.createChatProvider({ protocol: 'cursor', modelName: 'cursor-test' });
    const capable = asSnapshotCapable(provider);

    capable.restoreState(snapshot);

    expect(capable.snapshotState()).toEqual(snapshot);
  });
});
