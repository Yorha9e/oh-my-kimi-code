/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentEvent2 } from '#/app/event/event2';
import {
  clearCursorBridge,
  setCursorBridge,
  type CursorBridge,
} from '#/kosong/provider/bases/cursor/cursorBridge';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { defineState, type DeepReadonly } from '#/state/state';

/**
 * Persistable snapshot of the cursor native provider's protocol state. Every
 * server-issued blob id and payload a continuation needs is stored verbatim,
 * so a restored provider answers the server's blob hydrate from the same
 * bytes the snapshotted run had seen.
 */
export interface CursorProviderSnapshot {
  protocolVersion: 1;
  blobStore: Record<string, string>;
  turnIds: string[];
  promptMessageIds: string[];
  rootPromptIds: string[];
  latestStateBlobId: string | null;
  conversationId: string | null;
  lastRunId: string | null;
  lastUsage: {
    inputOther: number;
    output: number;
    inputCacheRead: number;
    inputCacheCreation: number;
  } | null;
}

const cursorUsageSchema = z.object({
  inputOther: z.number(),
  output: z.number(),
  inputCacheRead: z.number(),
  inputCacheCreation: z.number(),
});

/**
 * Wire schema for a cursor provider snapshot, shared by the durable
 * checkpoint record and the replayable `cursorNative` state key.
 */
export const cursorSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  blobStore: z.record(z.string(), z.string()),
  turnIds: z.array(z.string()),
  promptMessageIds: z.array(z.string()),
  rootPromptIds: z.array(z.string()),
  latestStateBlobId: z.string().nullable(),
  conversationId: z.string().nullable(),
  lastRunId: z.string().nullable(),
  lastUsage: cursorUsageSchema.nullable(),
});

/**
 * Wire schema for the durable cursor checkpoint record pairing an agent with
 * its full provider snapshot.
 */
export const cursorCheckpointUpdatedSchema = z.object({
  agentId: z.string(),
  snapshot: cursorSnapshotSchema,
});

/**
 * Durable checkpoint carrying a full cursor provider snapshot. Folding it
 * replaces the `cursorNative` state wholesale; the wire record is what makes
 * the protocol state survive process restarts through dispatcher replay.
 */
export class CursorCheckpointUpdated extends AgentEvent2<{
  agentId: string;
  snapshot: CursorProviderSnapshot;
}> {
  static override readonly type = 'cursor.checkpoint_updated';
  static override readonly durable = true;
  static override readonly schema = cursorCheckpointUpdatedSchema;
}
export interface CursorCheckpointUpdated {
  readonly agentId: string;
  readonly snapshot: CursorProviderSnapshot;
}

/**
 * Agent-scope replayable key holding the latest cursor provider snapshot.
 * World-time protocol pointers are intentionally not undoable: conversation
 * undo rewinds history, never the server-side blob references.
 */
export const cursorStateKey = defineState('cursorNative', (): CursorProviderSnapshot => ({
  protocolVersion: 1,
  blobStore: {},
  turnIds: [],
  promptMessageIds: [],
  rootPromptIds: [],
  latestStateBlobId: null,
  conversationId: null,
  lastRunId: null,
  lastUsage: null,
}))
  .replayable({ schema: cursorSnapshotSchema })
  .on(CursorCheckpointUpdated, (_s, e) => copyCursorSnapshot(e.snapshot));

function copyCursorSnapshot(
  snapshot: DeepReadonly<CursorProviderSnapshot>,
): CursorProviderSnapshot {
  return {
    protocolVersion: snapshot.protocolVersion,
    blobStore: { ...snapshot.blobStore },
    turnIds: [...snapshot.turnIds],
    promptMessageIds: [...snapshot.promptMessageIds],
    rootPromptIds: [...snapshot.rootPromptIds],
    latestStateBlobId: snapshot.latestStateBlobId,
    conversationId: snapshot.conversationId,
    lastRunId: snapshot.lastRunId,
    lastUsage: snapshot.lastUsage === null ? null : { ...snapshot.lastUsage },
  };
}

/**
 * Owner service for the `cursorNative` replayable key. Each agent holds its
 * own snapshot behind a stacked bridge registration: the innermost live
 * agent drives provider hydration and receives folded snapshots, and
 * disposing it reveals the parent registration underneath.
 */
export interface ICursorStateService {
  readonly _serviceBrand: undefined;
  /** Dispatch a durable checkpoint replacing the stored snapshot. */
  fold(snapshot: CursorProviderSnapshot): void;
  /** Latest snapshot, defensively copied. */
  current(): CursorProviderSnapshot;
}

export const ICursorStateService: ServiceIdentifier<ICursorStateService> =
  createDecorator<ICursorStateService>('cursorStateService');

export class CursorStateService extends Service implements ICursorStateService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {
    super();
    this.agentState.contributeState(cursorStateKey);
    const bridge: CursorBridge = {
      loadSnapshot: () => this.current(),
      storeSnapshot: (snapshot) => {
        this.fold(snapshot);
      },
    };
    setCursorBridge(bridge);
    this._register(
      toDisposable(() => {
        clearCursorBridge(bridge);
      }),
    );
  }

  fold(snapshot: CursorProviderSnapshot): void {
    void this.dispatcher.dispatch(
      new CursorCheckpointUpdated({
        agentId: this.scopeContext.agentId,
        snapshot: copyCursorSnapshot(snapshot),
      }),
    );
  }

  current(): CursorProviderSnapshot {
    return copyCursorSnapshot(this.agentState.get(cursorStateKey));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  ICursorStateService,
  CursorStateService,
  ScopeActivation.OnScopeCreated,
  'cursor',
);
