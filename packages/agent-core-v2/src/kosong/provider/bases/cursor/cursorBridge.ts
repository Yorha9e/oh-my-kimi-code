import type { CursorProviderSnapshot } from '@moonshot-ai/kosong';

import type { ChatProvider } from '#/kosong/contract/provider';

/**
 * Per-agent cursor snapshot source backing provider hydration and snapshot
 * persistence. The owning agent-scope service registers itself here; the
 * registration is process-wide under the single-agent assumption that one
 * agent at a time drives the cursor channel.
 */
export interface CursorBridge {
  /** Latest snapshot for the active agent, including the replayed initial state. */
  loadSnapshot(): CursorProviderSnapshot;
  /** Persist a snapshot produced by a completed cursor request. */
  storeSnapshot(snapshot: CursorProviderSnapshot): void;
}

interface SnapshotCapable {
  restoreState(snapshot: CursorProviderSnapshot): void;
  snapshotState(): CursorProviderSnapshot;
}

let activeBridge: CursorBridge | null = null;

function asSnapshotCapable(provider: ChatProvider): SnapshotCapable | null {
  const candidate = provider as Partial<SnapshotCapable>;
  if (
    typeof candidate.restoreState !== 'function' ||
    typeof candidate.snapshotState !== 'function'
  ) {
    return null;
  }
  return candidate as SnapshotCapable;
}

/**
 * Register the active agent's snapshot source, replacing any previous one.
 * The cursor channel is driven by a single agent per process; when several
 * agents share a cursor model they share the underlying provider instance,
 * so the newest registration wins.
 */
export function setCursorBridge(bridge: CursorBridge): void {
  activeBridge = bridge;
}

/**
 * Withdraw a snapshot source previously installed with
 * {@link setCursorBridge}, leaving a newer registration untouched.
 */
export function clearCursorBridge(bridge: CursorBridge): void {
  if (activeBridge === bridge) activeBridge = null;
}

/**
 * Restore a snapshot-capable provider from the active agent's snapshot, if
 * any source is registered. Providers without snapshot support are left
 * untouched.
 */
export function cursorHydrateProvider(provider: ChatProvider): void {
  if (activeBridge === null) return;
  asSnapshotCapable(provider)?.restoreState(activeBridge.loadSnapshot());
}

/**
 * Read a provider snapshot through structural capability detection, without
 * depending on a concrete provider class. Returns undefined for providers
 * that carry no cursor protocol state.
 */
export function readCursorSnapshot(provider: ChatProvider): CursorProviderSnapshot | undefined {
  return asSnapshotCapable(provider)?.snapshotState();
}

/**
 * Persist a snapshot through the active agent's source, if one is
 * registered. Drops the snapshot silently when no agent owns the channel.
 */
export function storeCursorSnapshot(snapshot: CursorProviderSnapshot): void {
  activeBridge?.storeSnapshot(snapshot);
}
