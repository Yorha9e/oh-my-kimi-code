import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IEventBus } from '#/app/event/eventBus';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { readWorkspaceThenGlobalSlotBinding } from '#/session/subagent/slotBinding';
import { ISessionTipSaveService, TIP_SAVE_SLOT } from '#/session/tipSave/tipSave';
import { SessionTipSaveService } from '#/session/tipSave/tipSaveService';

vi.mock('#/session/subagent/slotBinding', () => ({
  readWorkspaceThenGlobalSlotBinding: vi.fn(async () => undefined),
}));

const readSlotBinding = vi.mocked(readWorkspaceThenGlobalSlotBinding);

describe('SessionTipSaveService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let fork: ReturnType<typeof vi.fn>;
  let remove: ReturnType<typeof vi.fn>;
  let subscribe: ReturnType<typeof vi.fn>;
  let getAgent: ReturnType<typeof vi.fn>;
  let modelGet: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    subscribe = vi.fn(() => ({ dispose: vi.fn() }));
    const child = {
      id: 'agent-tip-save-1',
      accessor: {
        get: (id: unknown) => {
          if (id === IEventBus) return { subscribe };
          return undefined;
        },
      },
    };
    fork = vi.fn(async () => child);
    remove = vi.fn(async () => {});
    modelGet = vi.fn(() => ({ id: 'k2' }));
    warn = vi.fn();
    readSlotBinding.mockReset();
    readSlotBinding.mockResolvedValue(undefined);

    const main = {
      id: MAIN_AGENT_ID,
      accessor: {
        get: (id: unknown) => {
          if (id === IAgentProfileService) {
            return { data: () => ({ modelAlias: 'k2', thinkingLevel: 'off' }) };
          }
          return undefined;
        },
      },
    };
    getAgent = vi.fn((id: string) => (id === MAIN_AGENT_ID ? main : child));
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      fork,
      get: getAgent,
      remove,
    } as unknown as IAgentLifecycleService);
    ix.stub(IConfigService, {
      _serviceBrand: undefined,
      get: vi.fn(),
    } as unknown as IConfigService);
    ix.stub(IFlagService, {
      _serviceBrand: undefined,
      enabled: vi.fn(() => false),
    } as unknown as IFlagService);
    ix.stub(IModelCatalog, {
      _serviceBrand: undefined,
      get: modelGet,
    } as unknown as IModelCatalog);
    ix.stub(ISessionContext, { cwd: '/tmp/proj-a' } as unknown as ISessionContext);
    ix.stub(ILogService, { _serviceBrand: undefined, warn } as unknown as ILogService);
    ix.set(ISessionTipSaveService, new SyncDescriptor(SessionTipSaveService));
  });
  afterEach(() => disposables.dispose());

  it('forks main with the caller model when no slot or secondary binding is configured', async () => {
    const svc = ix.get(ISessionTipSaveService);
    const id = await svc.start();

    expect(id).toBe('agent-tip-save-1');
    expect(fork).toHaveBeenCalledWith('main', {
      binding: { model: 'k2', thinking: 'off' },
    });
    expect(readSlotBinding).toHaveBeenCalledWith('/tmp/proj-a', TIP_SAVE_SLOT);
  });

  it('binds the slot model when [subagent-slot.tip_save] is configured', async () => {
    readSlotBinding.mockResolvedValue({ model: 'cheap-model', thinkingEffort: 'low' });
    const svc = ix.get(ISessionTipSaveService);
    await svc.start();

    expect(fork).toHaveBeenCalledWith('main', {
      binding: { model: 'cheap-model', thinking: 'low' },
    });
  });

  it('keeps every tool on the child (no veto listener is installed)', async () => {
    // The lifecycle stub's accessor only answers IAgentProfileService; any
    // attempt to reach a tool-executor veto would throw here, so a passing
    // start() proves the service installs no tool denial on the child.
    const svc = ix.get(ISessionTipSaveService);
    const id = await svc.start();

    expect(id).toBe('agent-tip-save-1');
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it('drops the slot level on inherit: true and falls back to the caller model', async () => {
    readSlotBinding.mockResolvedValue({ model: 'cheap-model', inherit: true });
    const svc = ix.get(ISessionTipSaveService);
    await svc.start();

    expect(fork).toHaveBeenCalledWith('main', {
      binding: { model: 'k2', thinking: 'off' },
    });
  });

  it('drops the slot level when the slot model alias is unknown to the catalog', async () => {
    readSlotBinding.mockResolvedValue({ model: 'ghost-model' });
    modelGet.mockImplementation((id: string) => {
      if (id === 'ghost-model') throw new Error(`Unknown model "${id}"`);
      return { id };
    });
    const svc = ix.get(ISessionTipSaveService);
    await svc.start();

    expect(warn).toHaveBeenCalledWith(
      'ignoring tip-save slot binding with unknown model alias',
      expect.objectContaining({ slot: TIP_SAVE_SLOT, modelAlias: 'ghost-model' }),
    );
    expect(fork).toHaveBeenCalledWith('main', {
      binding: { model: 'k2', thinking: 'off' },
    });
  });

  it('removes the child scope after its turn ends', async () => {
    const svc = ix.get(ISessionTipSaveService);
    await svc.start();

    expect(subscribe).toHaveBeenCalledWith('turn.ended', expect.any(Function));
    const onTurnEnded = subscribe.mock.calls[0]?.[1] as (event: { type: 'turn.ended' }) => void;
    onTurnEnded({ type: 'turn.ended' } as never);

    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith('agent-tip-save-1');
    });
  });

  it('does not reclaim the child while no turn has ended', async () => {
    const svc = ix.get(ISessionTipSaveService);
    await svc.start();

    await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps reclaiming the child when the turn fails or is cancelled', async () => {
    const svc = ix.get(ISessionTipSaveService);
    await svc.start();

    const onTurnEnded = subscribe.mock.calls[0]?.[1] as (event: { type: 'turn.ended' }) => void;
    const assertRemoved = (): void => {
      expect(remove).toHaveBeenCalledWith('agent-tip-save-1');
    };
    for (const reason of ['failed', 'cancelled'] as const) {
      remove.mockClear();
      onTurnEnded({ type: 'turn.ended', reason } as never);
      await vi.waitFor(assertRemoved);
    }
  });
});
