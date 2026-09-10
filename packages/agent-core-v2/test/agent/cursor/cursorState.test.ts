import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createEmptyCursorSnapshot } from '@moonshot-ai/kosong';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import {
  _clearScopedRegistryForTests,
  registerScopedService,
  ScopeActivation,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair, TestInstantiationService } from '#/_base/di/test';
import { BugIndicatingError } from '#/_base/errors/errors';
import { resetUnexpectedErrorHandler, setUnexpectedErrorHandler } from '#/_base/errors/unexpectedError';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import {
  CursorCheckpointUpdated,
  CursorStateService,
  ICursorStateService,
  cursorCheckpointUpdatedSchema,
  cursorSnapshotSchema,
  type CursorProviderSnapshot,
} from '#/agent/cursor/cursorState';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { LifecycleScope } from '#/app/scopes';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2, Event2Class } from '#/app/event/event2';
import { CompactionCompleted } from '#/agent/fullCompaction/compactionOps';
import { EventBusService } from '#/app/event/eventBusService';
import type { ChatProvider, StreamedMessage } from '#/kosong/contract/provider';
import { APIStatusError } from '#/kosong/contract/errors';
import type { Message, StreamedMessagePart } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import { emptyUsage } from '#/kosong/contract/usage';
import type { Model } from '#/kosong/model/catalog';
import type { ModelRequestEvent } from '#/kosong/model/modelRequester';
import { ModelRequesterImpl } from '#/kosong/model/modelRequesterImpl';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import {
  cursorHydrateProvider,
  storeCursorSnapshot,
} from '#/kosong/provider/bases/cursor/cursorBridge';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import { registerProtocolBase } from '#/kosong/protocol/protocolBase';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { defineState } from '#/state/state';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';

function makeSnapshot(tag: string): CursorProviderSnapshot {
  return {
    protocolVersion: 1,
    blobStore: { [`${tag}-blob-a`]: 'YmxvYi1h', [`${tag}-blob-b`]: 'YmxvYi1i' },
    turnIds: [`${tag}-blob-a`],
    promptMessageIds: [`${tag}-blob-b`],
    rootPromptIds: [],
    latestStateBlobId: null,
    conversationId: `agent-${tag}`,
    lastRunId: `run-${tag}-1`,
    lastUsage: { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 1 },
  };
}

function emptySnapshot(): CursorProviderSnapshot {
  return {
    protocolVersion: 1,
    blobStore: {},
    turnIds: [],
    promptMessageIds: [],
    rootPromptIds: [],
    latestStateBlobId: null,
    conversationId: null,
    lastRunId: null,
    lastUsage: null,
  };
}

const noopBlob: IAgentBlobService = {
  _serviceBrand: undefined,
  offloadParts: async (parts) => parts,
  loadParts: async (parts) => parts,
  isBlobRef: () => false,
};

function stubWireJournal(journal: WireRecord[]): IWireService {
  return {
    _serviceBrand: undefined,
    seal: async () => {},
    appendRecord: (record) => {
      journal.push(record);
    },
    readJournal: async function* () {
      for (const record of journal) yield record;
    },
    flush: async () => {},
  };
}

const stubBus: IEventBus = {
  _serviceBrand: undefined,
  publish: () => {},
  subscribe: ((..._args: readonly unknown[]) => toDisposable(() => {})) as IEventBus['subscribe'],
};

interface CursorTestContainer {
  readonly store: DisposableStore;
  readonly dispatcher: () => IEventDispatcher;
  readonly states: () => IAgentStateService;
  readonly cursor: () => ICursorStateService;
  readonly scope: () => IAgentScopeContext;
  readonly bus: () => IEventBus;
}

function createCursorTestContainer(journal: WireRecord[], bus?: IEventBus): CursorTestContainer {
  const store = new DisposableStore();
  const container = store.add(new TestInstantiationService());
  container.set(IEventBus, bus ?? new SyncDescriptor(EventBusService));
  container.set(IAgentBlobService, noopBlob);
  container.set(
    IAgentScopeContext,
    makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' }),
  );
  container.set(IWireService, stubWireJournal(journal));
  container.set(IAgentStateService, new AgentStateService());
  container.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
  container.set(ICursorStateService, new SyncDescriptor(CursorStateService));
  return {
    store,
    dispatcher: () => container.get(IEventDispatcher),
    states: () => container.get(IAgentStateService),
    cursor: () => container.get(ICursorStateService),
    scope: () => container.get(IAgentScopeContext),
    bus: () => container.get(IEventBus),
  };
}

describe('CursorStateService', () => {
  let disposables: DisposableStore;
  let journal: WireRecord[];
  let active: CursorTestContainer;

  beforeEach(() => {
    disposables = new DisposableStore();
    journal = [];
    active = createCursorTestContainer(journal);
    disposables.add(active.store);
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('folds a checkpoint into current and appends the durable record', () => {
    const first = makeSnapshot('one');
    active.cursor().fold(first);

    expect(active.cursor().current()).toEqual(first);
    expect(journal).toEqual([
      {
        type: 'cursor.checkpoint_updated',
        agentId: 'main',
        snapshot: first,
        time: expect.any(Number),
      },
    ]);
  });

  it('keeps the latest fold and rebuilds it on restore', async () => {
    const first = makeSnapshot('one');
    const second = makeSnapshot('two');
    active.cursor().fold(first);
    active.cursor().fold(second);
    expect(active.cursor().current()).toEqual(second);
    const records = [...journal];

    const replayJournal = [...records];
    const replayed = createCursorTestContainer(replayJournal);
    disposables.add(replayed.store);
    const replayedOwner = replayed.cursor();
    await replayed.dispatcher().restore();

    expect(replayedOwner.current()).toEqual(second);
    expect(replayJournal).toEqual(records);
  });

  it('returns defensive copies from current', () => {
    const first = makeSnapshot('one');
    active.cursor().fold(first);

    const seen = active.cursor().current();
    seen.turnIds.push('intruder');
    seen.blobStore['evil'] = 'ZXZpbA==';
    if (seen.lastUsage !== null) seen.lastUsage.output = 999;

    expect(active.cursor().current()).toEqual(first);
  });

  it('rejects owner construction once restore has run', async () => {
    const fresh = createCursorTestContainer([]);
    disposables.add(fresh.store);
    await fresh.dispatcher().restore();

    expect(() => fresh.cursor()).toThrow(BugIndicatingError);
  });

  it('rejects a late key contribution with the restore-phase guard', async () => {
    await active.dispatcher().restore();
    const lateKey = defineState('cursor.test.late', () => 0)
      .replayable({ schema: z.number() })
      .on(CursorCheckpointUpdated, (state) => state);

    expect(() => active.states().contributeState(lateKey)).toThrow(BugIndicatingError);
  });

  it('accepts the provider snapshot factory through the snapshot schemas', () => {
    const sample = createEmptyCursorSnapshot();

    expect(cursorSnapshotSchema.safeParse(sample).success).toBe(true);
    expect(
      cursorCheckpointUpdatedSchema.safeParse({ agentId: 'main', snapshot: sample }).success,
    ).toBe(true);
  });

  it('skips a schema-mismatched checkpoint on restore and keeps the default state', async () => {
    const replayed = createCursorTestContainer([
      {
        type: 'cursor.checkpoint_updated',
        agentId: 'main',
        snapshot: { ...makeSnapshot('corrupt'), protocolVersion: 999 },
        time: Date.now(),
      },
    ]);
    disposables.add(replayed.store);
    const owner = replayed.cursor();
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => {
      unexpected.push(error);
    });
    try {
      await replayed.dispatcher().restore();
    } finally {
      resetUnexpectedErrorHandler();
    }

    expect(owner.current()).toEqual(emptySnapshot());
    expect(unexpected).toHaveLength(1);
  });

  it('skips a checkpoint with a mismatched agentId on restore', async () => {
    const replayed = createCursorTestContainer([
      {
        type: 'cursor.checkpoint_updated',
        agentId: 'other',
        snapshot: makeSnapshot('foreign'),
        time: Date.now(),
      },
    ]);
    disposables.add(replayed.store);
    const owner = replayed.cursor();
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => {
      unexpected.push(error);
    });
    try {
      await replayed.dispatcher().restore();
    } finally {
      resetUnexpectedErrorHandler();
    }

    expect(owner.current()).toEqual(emptySnapshot());
    expect(unexpected).toHaveLength(1);
  });
});

class FakeCursorProvider implements ChatProvider {
  readonly name = 'cursor-fake';
  readonly modelName = 'cursor-fake-model';
  readonly thinkingEffort = null;
  restored: CursorProviderSnapshot | null = null;
  failNext = false;

  constructor(private state: CursorProviderSnapshot) {}

  restoreState(snapshot: CursorProviderSnapshot): void {
    this.restored = snapshot;
    this.state = structuredClone(snapshot);
  }

  snapshotState(): CursorProviderSnapshot {
    return structuredClone(this.state);
  }

  async generate(
    _systemPrompt: string,
    _tools: Tool[],
    _history: Message[],
  ): Promise<StreamedMessage> {
    if (this.failNext) throw new Error('cursor fake generate failed');
    this.state = {
      ...this.state,
      blobStore: { ...this.state.blobStore, 'blob-generated': 'Z2VuZXJhdGVk' },
      turnIds: [...this.state.turnIds, 'blob-generated'],
    };
    return {
      id: 'fake-stream',
      usage: emptyUsage(),
      finishReason: 'completed',
      rawFinishReason: 'stop',
      async *[Symbol.asyncIterator]() {
        yield { type: 'text', text: 'hello' } as StreamedMessagePart;
      },
    };
  }
}

let injectedProvider: FakeCursorProvider | null = null;
const seenConfigHydrates: Array<((provider: ChatProvider) => void) | undefined> = [];

registerProtocolBase({
  id: 'cursor',
  createChatProvider: (context) => {
    seenConfigHydrates.push(context.config.hydrate);
    if (injectedProvider === null) throw new Error('no fake cursor provider injected');
    context.config.hydrate?.(injectedProvider);
    return injectedProvider;
  },
});

function cursorTestModel(): Model {
  return {
    id: 'cursor-test',
    name: 'cursor-fake-model',
    aliases: [],
    protocol: 'cursor',
    headers: {},
    capabilities: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 128000,
    },
    maxContextSize: 128000,
    alwaysThinking: false,
    providerType: 'cursor',
    providerName: 'cursor-test-provider',
    authProvider: {
      canRefresh: false,
      getAuth: () => Promise.resolve({ apiKey: 'test-key' }),
    },
  };
}

async function collectEvents(stream: AsyncIterable<ModelRequestEvent>): Promise<ModelRequestEvent[]> {
  const events: ModelRequestEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('cursor persistence wiring (scoped)', () => {
  let host: ReturnType<typeof createScopedTestHost>;
  let session: ReturnType<ReturnType<typeof createScopedTestHost>['child']>;
  let journal: WireRecord[];

  function agentSeeds(scopeJournal: WireRecord[]) {
    return [
      stubPair(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' })),
      stubPair(IWireService, stubWireJournal(scopeJournal)),
      stubPair(IEventBus, stubBus),
      stubPair(IAgentBlobService, noopBlob),
    ];
  }

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Session,
      ISessionStateService,
      SessionStateService,
      ScopeActivation.OnScopeCreated,
      'cursor-test',
    );
    registerScopedService(
      LifecycleScope.Agent,
      IAgentStateService,
      AgentStateService,
      ScopeActivation.OnScopeCreated,
      'cursor-test',
    );
    registerScopedService(
      LifecycleScope.Agent,
      IEventDispatcher,
      EventDispatcherService,
      ScopeActivation.OnScopeCreated,
      'cursor-test',
    );
    registerScopedService(
      LifecycleScope.Agent,
      ICursorStateService,
      CursorStateService,
      ScopeActivation.OnScopeCreated,
      'cursor-test',
    );
    registerScopedService(
      LifecycleScope.App,
      IProtocolAdapterRegistry,
      ProtocolAdapterRegistry,
      ScopeActivation.OnScopeCreated,
      'cursor-test',
    );
    journal = [];
    injectedProvider = null;
    seenConfigHydrates.length = 0;
    host = createScopedTestHost();
    session = host.child(LifecycleScope.Session, 's1');
  });

  afterEach(() => {
    host.dispose();
  });

  it('replays the checkpoint into a fresh provider before its first request and folds the result', async () => {
    const first = host.childOf(session, LifecycleScope.Agent, 'main', agentSeeds(journal));
    first.accessor.get(ICursorStateService).fold(makeSnapshot('one'));
    const stored = [...journal];
    first.dispose();

    const resumed = host.childOf(session, LifecycleScope.Agent, 'resumed', agentSeeds(journal));
    const owner = resumed.accessor.get(ICursorStateService);
    await resumed.accessor.get(IEventDispatcher).restore();
    expect(owner.current()).toEqual(makeSnapshot('one'));

    const fake = new FakeCursorProvider(emptySnapshot());
    injectedProvider = fake;
    const hydrate = vi.fn(cursorHydrateProvider);
    const stored2: CursorProviderSnapshot[] = [];
    const registry = host.app.accessor.get(IProtocolAdapterRegistry);
    const requester = new ModelRequesterImpl(cursorTestModel(), registry, {
      hydrate,
      onSnapshot: (snapshot) => {
        stored2.push(snapshot);
        storeCursorSnapshot(snapshot);
      },
    });

    const events = await collectEvents(
      requester.request({ systemPrompt: 'sys', tools: [], messages: [] }),
    );
    expect(events.some((event) => event.type === 'finish')).toBe(true);
    expect(hydrate).toHaveBeenCalledWith(fake);
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(fake.restored).toEqual(makeSnapshot('one'));
    expect(seenConfigHydrates.at(-1)).toBe(hydrate);
    expect(stored2).toHaveLength(1);
    expect(owner.current()).toEqual(stored2[0]);
    expect(owner.current().turnIds).toContain('blob-generated');
    expect(journal.length).toBeGreaterThan(stored.length);
  });

  it('skips the snapshot hook when the request fails', async () => {
    const agent = host.childOf(session, LifecycleScope.Agent, 'main', agentSeeds(journal));
    const owner = agent.accessor.get(ICursorStateService);
    owner.fold(makeSnapshot('one'));
    const stored = journal.length;

    const fake = new FakeCursorProvider(emptySnapshot());
    fake.failNext = true;
    injectedProvider = fake;
    const stored2: CursorProviderSnapshot[] = [];
    const registry = host.app.accessor.get(IProtocolAdapterRegistry);
    const requester = new ModelRequesterImpl(cursorTestModel(), registry, {
      hydrate: cursorHydrateProvider,
      onSnapshot: (snapshot) => {
        stored2.push(snapshot);
        storeCursorSnapshot(snapshot);
      },
    });

    await expect(
      collectEvents(requester.request({ systemPrompt: 'sys', tools: [], messages: [] })),
    ).rejects.toThrow();
    expect(stored2).toHaveLength(0);
    expect(owner.current()).toEqual(makeSnapshot('one'));
    expect(journal).toHaveLength(stored);
  });

  it('restores the parent bridge once a nested agent disposes', async () => {
    const parent = host.childOf(session, LifecycleScope.Agent, 'parent', agentSeeds(journal));
    const parentOwner = parent.accessor.get(ICursorStateService);
    parentOwner.fold(makeSnapshot('parent'));
    const child = host.childOf(session, LifecycleScope.Agent, 'child', agentSeeds(journal));
    const childOwner = child.accessor.get(ICursorStateService);
    childOwner.fold(makeSnapshot('child'));

    const nested = new FakeCursorProvider(emptySnapshot());
    injectedProvider = nested;
    const registry = host.app.accessor.get(IProtocolAdapterRegistry);
    const nestedRequester = new ModelRequesterImpl(cursorTestModel(), registry, {
      hydrate: cursorHydrateProvider,
      onSnapshot: storeCursorSnapshot,
    });
    const nestedEvents = await collectEvents(
      nestedRequester.request({ systemPrompt: 'sys', tools: [], messages: [] }),
    );
    expect(nestedEvents.some((event) => event.type === 'finish')).toBe(true);
    expect(nested.restored).toEqual(makeSnapshot('child'));

    child.dispose();

    const revived = new FakeCursorProvider(emptySnapshot());
    cursorHydrateProvider(revived);
    expect(revived.restored).toEqual(makeSnapshot('parent'));
    storeCursorSnapshot(makeSnapshot('parent-next'));
    expect(parentOwner.current()).toEqual(makeSnapshot('parent-next'));
  });

  it('completes the request when the snapshot hook throws', async () => {
    const agent = host.childOf(session, LifecycleScope.Agent, 'main', agentSeeds(journal));
    agent.accessor.get(ICursorStateService).fold(makeSnapshot('one'));

    const fake = new FakeCursorProvider(emptySnapshot());
    injectedProvider = fake;
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => {
      unexpected.push(error);
    });
    try {
      const registry = host.app.accessor.get(IProtocolAdapterRegistry);
      const requester = new ModelRequesterImpl(cursorTestModel(), registry, {
        hydrate: cursorHydrateProvider,
        onSnapshot: () => {
          throw new Error('snapshot hook failed');
        },
      });

      const events = await collectEvents(
        requester.request({ systemPrompt: 'sys', tools: [], messages: [] }),
      );
      expect(events.some((event) => event.type === 'finish')).toBe(true);
    } finally {
      resetUnexpectedErrorHandler();
    }
    expect(unexpected).toHaveLength(1);
  });

  it('completes the request when reading the provider snapshot throws', async () => {
    const agent = host.childOf(session, LifecycleScope.Agent, 'main', agentSeeds(journal));
    agent.accessor.get(ICursorStateService).fold(makeSnapshot('one'));

    const fake = new FakeCursorProvider(emptySnapshot());
    injectedProvider = fake;
    vi.spyOn(fake, 'snapshotState').mockImplementation(() => {
      throw new Error('snapshot read failed');
    });
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => {
      unexpected.push(error);
    });
    try {
      const registry = host.app.accessor.get(IProtocolAdapterRegistry);
      const requester = new ModelRequesterImpl(cursorTestModel(), registry, {
        hydrate: cursorHydrateProvider,
        onSnapshot: storeCursorSnapshot,
      });

      const events = await collectEvents(
        requester.request({ systemPrompt: 'sys', tools: [], messages: [] }),
      );
      expect(events.some((event) => event.type === 'finish')).toBe(true);
    } finally {
      resetUnexpectedErrorHandler();
    }
    expect(unexpected).toHaveLength(1);
  });

  it('folds the snapshot exactly once when a 401 retry succeeds', async () => {
    const agent = host.childOf(session, LifecycleScope.Agent, 'main', agentSeeds(journal));
    const owner = agent.accessor.get(ICursorStateService);
    owner.fold(makeSnapshot('one'));

    const fake = new FakeCursorProvider(emptySnapshot());
    injectedProvider = fake;
    let attempts = 0;
    const generate = fake.generate.bind(fake);
    fake.generate = async (systemPrompt, tools, history) => {
      attempts += 1;
      if (attempts === 1) throw new APIStatusError(401, 'unauthorized');
      return generate(systemPrompt, tools, history);
    };
    const folded: CursorProviderSnapshot[] = [];
    const registry = host.app.accessor.get(IProtocolAdapterRegistry);
    const requester = new ModelRequesterImpl(
      {
        ...cursorTestModel(),
        authProvider: {
          canRefresh: true,
          getAuth: () => Promise.resolve({ apiKey: 'test-key' }),
        },
      },
      registry,
      {
        hydrate: cursorHydrateProvider,
        onSnapshot: (snapshot) => {
          folded.push(snapshot);
          storeCursorSnapshot(snapshot);
        },
      },
    );

    const events = await collectEvents(
      requester.request({ systemPrompt: 'sys', tools: [], messages: [] }),
    );
    expect(attempts).toBe(2);
    expect(events.some((event) => event.type === 'finish')).toBe(true);
    expect(folded).toHaveLength(1);
  });
});

function captureCompactionBus(): {
  bus: IEventBus;
  fire: (event: CompactionCompleted) => void;
} {
  const handlers: Array<(event: CompactionCompleted) => void> = [];
  const bus = {
    _serviceBrand: undefined,
    publish: () => {},
    subscribe: ((typeOrHandler: unknown, handler?: unknown) => {
      const type =
        typeof typeOrHandler === 'string'
          ? typeOrHandler
          : (typeOrHandler as Event2Class).type;
      if (type === CompactionCompleted.type && typeof handler === 'function') {
        handlers.push(handler as (event: CompactionCompleted) => void);
      }
      return toDisposable(() => {});
    }) as IEventBus['subscribe'],
  } as IEventBus;
  return {
    bus,
    fire: (event) => {
      for (const handler of [...handlers]) handler(event);
    },
  };
}

describe('CursorStateService compaction linkage', () => {
  let disposables: DisposableStore;
  let journal: WireRecord[];
  let active: CursorTestContainer;

  beforeEach(() => {
    disposables = new DisposableStore();
    journal = [];
    active = createCursorTestContainer(journal);
    disposables.add(active.store);
  });

  afterEach(() => {
    disposables.dispose();
  });

  function activateAgent(): void {
    (active.bus() as EventBusService).activateAgent(active.scope().agentContext);
  }

  function compactionOf(summary: string): CompactionCompleted {
    return new CompactionCompleted({
      agentId: 'main',
      result: { summary, compactedCount: 4, tokensBefore: 100, tokensAfter: 20 },
    });
  }

  it('folds a compacted snapshot when compaction completes on a cursor session', async () => {
    const before = makeSnapshot('one');
    active.cursor().fold(before);
    activateAgent();

    await active.dispatcher().dispatch(compactionOf('discussed widgets'));

    const current = active.cursor().current();
    expect(current.conversationId).toBe(before.conversationId);
    expect(current.turnIds).toEqual([]);
    expect(current.promptMessageIds).toHaveLength(1);
    expect(current.latestStateBlobId).toBeNull();
    expect(current.lastRunId).toBeNull();
    expect(current.lastUsage).toEqual(before.lastUsage);
    expect(current.rootPromptIds).toEqual(before.rootPromptIds);
    const summaryId = current.promptMessageIds[0]!;
    const parsed: unknown = JSON.parse(
      Buffer.from(current.blobStore[summaryId]!, 'base64').toString('utf8'),
    );
    expect(parsed).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '[Previous conversation summary]:\ndiscussed widgets' }],
    });
    expect(Object.keys(current.blobStore).sort()).toEqual(
      [...before.rootPromptIds, summaryId].sort(),
    );
    expect(
      journal.filter((record) => record.type === 'cursor.checkpoint_updated'),
    ).toHaveLength(2);
  });

  it('leaves a non-cursor session untouched when compaction completes', async () => {
    activateAgent();

    await active.dispatcher().dispatch(compactionOf('discussed widgets'));

    expect(active.cursor().current()).toEqual(emptySnapshot());
    expect(journal).toHaveLength(0);
  });

  it('ignores compaction completed for another agent', () => {
    const capture = captureCompactionBus();
    const foreign = createCursorTestContainer(journal, capture.bus);
    disposables.add(foreign.store);
    foreign.cursor().fold(makeSnapshot('one'));
    const stored = journal.length;

    capture.fire(
      new CompactionCompleted({
        agentId: 'other',
        result: { summary: 'foreign summary', compactedCount: 2, tokensBefore: 50, tokensAfter: 10 },
      }),
    );

    expect(foreign.cursor().current()).toEqual(makeSnapshot('one'));
    expect(journal).toHaveLength(stored);
  });

  it('replays the compacted snapshot on restore', async () => {
    const before = makeSnapshot('one');
    active.cursor().fold(before);
    activateAgent();
    await active.dispatcher().dispatch(compactionOf('discussed widgets'));
    const records = [...journal];

    const replayed = createCursorTestContainer([...records]);
    disposables.add(replayed.store);
    const replayedOwner = replayed.cursor();
    await replayed.dispatcher().restore();

    expect(replayedOwner.current()).toEqual(active.cursor().current());
  });
});
