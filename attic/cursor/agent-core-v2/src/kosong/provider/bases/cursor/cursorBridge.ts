import type { CursorProviderSnapshot } from '@moonshot-ai/kosong';

import type { ChatProvider } from '#/kosong/contract/provider';

/**
 * Per-agent cursor snapshot source backing provider hydration and snapshot
 * persistence. Every agent-scope cursor service registers its own source;
 * registrations form a stack so a nested sub-agent hydrates from and folds
 * into its own snapshot while it lives, and its parent resumes once the
 * sub-agent disposes.
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

const bridgeStack: CursorBridge[] = [];

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
 * Register an agent snapshot source on top of the bridge stack, moving it to
 * the top when it is already registered. The newest registration drives
 * hydration and snapshot persistence until it is withdrawn.
 */
export function setCursorBridge(bridge: CursorBridge): void {
  const registered = bridgeStack.indexOf(bridge);
  if (registered !== -1) bridgeStack.splice(registered, 1);
  bridgeStack.push(bridge);
}

/**
 * Withdraw a snapshot source previously installed with
 * {@link setCursorBridge}. The newest remaining registration, if any, becomes
 * the active source.
 */
export function clearCursorBridge(bridge: CursorBridge): void {
  const registered = bridgeStack.indexOf(bridge);
  if (registered !== -1) bridgeStack.splice(registered, 1);
}

/**
 * Newest registered snapshot source driving hydration and persistence, if any
 * registration is live. Switch-back injection keys its per-agent watermark on
 * this handle so nested agents track independently.
 */
export function activeCursorBridge(): CursorBridge | undefined {
  return bridgeStack.at(-1);
}

/**
 * Restore a snapshot-capable provider from the newest registered snapshot
 * source, if any source is registered. Providers without snapshot support are
 * left untouched.
 */
export function cursorHydrateProvider(provider: ChatProvider): void {
  const active = bridgeStack.at(-1);
  if (active === undefined) return;
  asSnapshotCapable(provider)?.restoreState(active.loadSnapshot());
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
 * Persist a snapshot through the newest registered snapshot source, if one is
 * registered. Drops the snapshot silently when no agent owns the channel.
 */
export function storeCursorSnapshot(snapshot: CursorProviderSnapshot): void {
  bridgeStack.at(-1)?.storeSnapshot(snapshot);
}
