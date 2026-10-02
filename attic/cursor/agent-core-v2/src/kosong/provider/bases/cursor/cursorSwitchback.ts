import { injectMessagesIntoCursorSnapshot, type CursorProviderSnapshot } from '@moonshot-ai/kosong';

import type { Message, StreamedMessagePart } from '#/kosong/contract/message';
import type { ChatProvider, StreamedMessage } from '#/kosong/contract/provider';

import { activeCursorBridge, type CursorBridge } from './cursorBridge';

function asSnapshotCapable(provider: ChatProvider): {
  restoreState(snapshot: CursorProviderSnapshot): void;
} | null {
  const candidate = provider as Partial<{
    restoreState(snapshot: CursorProviderSnapshot): void;
  }>;
  if (typeof candidate.restoreState !== 'function') {
    return null;
  }
  return candidate as {
    restoreState(snapshot: CursorProviderSnapshot): void;
  };
}

/**
 * Messages selected for switch-back injection: every history entry between
 * the watermark and the live input, plus the length the watermark advances to
 * once they are handled. The trailing user message is the live input the
 * current generate sends as its question, so it is covered but never
 * injected; compaction summary messages are covered by the compacted snapshot
 * itself, so they are skipped as well; a history without any user message
 * treats everything as pending.
 */
export interface CursorSwitchbackSelection {
  readonly pending: Message[];
  readonly coveredLength: number;
}

/**
 * Select the history slice a cursor generate must inject before running:
 * entries in `[watermark, liveInput)` except compaction summaries, where
 * `liveInput` is the last user message and `coveredLength` is its index.
 * Out-of-range watermarks clamp to the history bounds and never produce a
 * negative slice.
 *
 * @param history Full engine history, oldest first.
 * @param watermark Message count already covered by the cursor snapshot.
 */
export function selectPendingSwitchbackMessages(
  history: readonly Message[],
  watermark: number,
): CursorSwitchbackSelection {
  const start = watermark < 0 ? 0 : Math.min(watermark, history.length);
  let liveInputIndex = history.length;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'user') {
      liveInputIndex = index;
      break;
    }
  }
  const end = Math.min(liveInputIndex, history.length);
  const pending: Message[] = [];
  for (let index = start; index < end; index += 1) {
    const message = history[index]!;
    if (!isCompactionSummaryMessage(message)) {
      pending.push(message);
    }
  }
  return {
    pending,
    coveredLength: end,
  };
}

function isCompactionSummaryMessage(message: Message): boolean {
  const origin = (message as { readonly origin?: { readonly kind?: unknown } }).origin;
  return origin !== undefined && origin !== null && origin.kind === 'compaction_summary';
}

const watermarks = new WeakMap<CursorBridge, number>();

/**
 * Read the switch-back watermark for a bridge: the history length its cursor
 * snapshot already covers. Defaults to zero for bridges never seen before.
 *
 * @param bridge Bridge to read; defaults to the active registration.
 */
export function cursorSwitchbackWatermark(bridge?: CursorBridge): number {
  const owner = bridge ?? activeCursorBridge();
  if (owner === undefined) {
    return 0;
  }
  return watermarks.get(owner) ?? 0;
}

/**
 * Move a bridge's switch-back watermark to a history length. Compaction
 * resets it to zero so the post-compaction history is rescanned from scratch
 * (the summary message stays skipped as snapshot-covered); injection advances
 * it past the injected slice.
 *
 * @param historyLength History length the cursor snapshot now covers.
 * @param bridge Bridge to move; defaults to the active registration.
 */
export function setCursorSwitchbackWatermark(historyLength: number, bridge?: CursorBridge): void {
  const owner = bridge ?? activeCursorBridge();
  if (owner === undefined) {
    return;
  }
  watermarks.set(owner, Math.max(0, historyLength));
}

/**
 * Inject intermediate non-cursor turns into the cursor snapshot before a
 * cursor generate runs. Restores the provider to the injected snapshot and
 * folds it through the active bridge, then advances the watermark past the
 * injected slice so rapid model toggles never duplicate. Returns false and
 * folds nothing when no bridge is active, the provider carries no cursor
 * state, or no pending messages exist. Switching away from cursor never
 * reaches this path, so it performs zero state mutations.
 *
 * @param provider Cursor provider about to generate.
 * @param history Full engine history, oldest first.
 */
export function ensureCursorSwitchbackInjected(
  provider: ChatProvider,
  history: readonly Message[],
): boolean {
  const bridge = activeCursorBridge();
  if (bridge === undefined) {
    return false;
  }
  const capable = asSnapshotCapable(provider);
  if (capable === null) {
    return false;
  }
  const selection = selectPendingSwitchbackMessages(history, cursorSwitchbackWatermark(bridge));
  if (selection.pending.length === 0) {
    return false;
  }
  const current = bridge.loadSnapshot();
  const next = injectMessagesIntoCursorSnapshot(current, selection.pending);
  if (next === current) {
    setCursorSwitchbackWatermark(selection.coveredLength, bridge);
    return false;
  }
  capable.restoreState(next);
  setCursorSwitchbackWatermark(selection.coveredLength, bridge);
  bridge.storeSnapshot(next);
  return true;
}

/**
 * Wrap a cursor generate's streamed message so a cleanly exhausted stream
 * advances the switch-back watermark past the answered input (`historyLength
 * + 1`: the live input plus the assistant message the engine appends). The
 * advance never regresses, and aborted or failed streams leave the watermark
 * untouched so the next attempt re-selects the same slice.
 *
 * @param inner Streamed message produced by the cursor generate.
 * @param historyLength Engine history length when the generate started.
 */
export function trackCursorSwitchbackCompletion(
  inner: StreamedMessage,
  historyLength: number,
): StreamedMessage {
  const bridge = activeCursorBridge();
  return new SwitchbackTrackedMessage(inner, bridge, historyLength);
}

class SwitchbackTrackedMessage implements StreamedMessage {
  readonly id: string | null;

  constructor(
    private readonly inner: StreamedMessage,
    private readonly bridge: CursorBridge | undefined,
    private readonly historyLength: number,
  ) {
    this.id = inner.id;
  }

  get usage() {
    return this.inner.usage;
  }

  get finishReason() {
    return this.inner.finishReason;
  }

  get rawFinishReason() {
    return this.inner.rawFinishReason;
  }

  get traceId() {
    return this.inner.traceId;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    for await (const part of this.inner) {
      yield part;
    }
    if (this.bridge !== undefined) {
      const covered = this.historyLength + 1;
      if (covered > cursorSwitchbackWatermark(this.bridge)) {
        setCursorSwitchbackWatermark(covered, this.bridge);
      }
    }
  }
}
