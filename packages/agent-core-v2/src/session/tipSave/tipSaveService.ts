
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IEventBus } from '#/app/event/eventBus';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { tryAgentContextOf } from '#/agent/scopeContext/scopeContext';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { IAgentScopeHandle } from '#/_base/di/scope';

function contextForHandle(handle: IAgentScopeHandle): AgentContext {
  const ctx = tryAgentContextOf(handle);
  if (ctx !== undefined) return ctx;
  return { agentId: handle.id, generation: 0, space: undefined as any };
}
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  resolveSubagentBinding,
  wrapSubagentModelError,
} from '#/session/subagent/configSection';
import { readWorkspaceThenGlobalSlotBinding } from '#/session/subagent/slotBinding';

import { ISessionTipSaveService, TIP_SAVE_SLOT } from './tipSave';

export class SessionTipSaveService implements ISessionTipSaveService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ILogService private readonly log: ILogService,
  ) {}

  async start(): Promise<string> {
    const main = this.lifecycle.findAgentHandle ? this.lifecycle.findAgentHandle(MAIN_AGENT_ID) : (this.lifecycle as any).get(MAIN_AGENT_ID);
    if (main === undefined) {
      throw new Error(`Source agent "${MAIN_AGENT_ID}" does not exist`);
    }
    const own = main.accessor.get(IAgentProfileService)?.data();
    if (own?.modelAlias === undefined) {
      throw new Error('Caller agent has no model bound');
    }

    const slotBinding = await this.readSlotBinding();
    const binding = resolveSubagentBinding(
      this.config,
      this.flags,
      { modelAlias: own.modelAlias, thinkingLevel: own.thinkingLevel },
      undefined,
      undefined,
      slotBinding,
    );
    try {
      this.modelCatalog.get(binding.model);
      const child = await this.lifecycle.fork(contextForHandle(main), {
        binding: { model: binding.model, thinking: binding.thinking },
      });
      this.armReclaim(child.id);
      return child.id;
    } catch (error) {
      throw wrapSubagentModelError(
        error,
        binding.model,
        own.modelAlias,
        binding.source,
        undefined,
        TIP_SAVE_SLOT,
      );
    }
  }

  /**
   * Reclaim the one-shot child once its single turn has ended: subscribe to
   * the child's `turn.ended` (the same `IEventBus` channel
   * `AgentLifecycleService.subscribeInteractionBus` listens on) and remove
   * the child's agent scope. `remove` is idempotent and awaits the loop
   * settling, so completed, failed, and cancelled turns all reclaim the
   * same. The removal is deferred to a microtask so the whole `turn.ended`
   * fan-out — including the loop's trailing `error` publication and every
   * listener registered before this one (the session wiring that forwards
   * events to the host) — completes before the scope is torn down. The
   * child runs a single turn; any later turn.ended finds it already
   * removed.
   */
  private armReclaim(childId: string): void {
    const child = this.lifecycle.findAgentHandle ? this.lifecycle.findAgentHandle(childId) : (this.lifecycle as any).get(childId);
    child?.accessor.get(IEventBus)?.subscribe('turn.ended', () => {
      queueMicrotask(() => {
        if (!child) return;
        void this.lifecycle.remove(contextForHandle(child)).catch((error) => {
          this.log.warn('tip-save child reclaim failed', { agentId: childId, error });
        });
      });
    });
  }

  /**
   * Stored binding for the tip-save slot (`[subagent-slot.tip_save]` in
   * local.toml) — the same skip policy the `Agent` tool applies to profile
   * slots: a missing binding, an explicit `inherit: true`, or a stored alias
   * the model catalog no longer resolves drops the whole level (the last
   * with a log warning).
   */
  private async readSlotBinding(): Promise<
    { readonly model?: string; readonly thinking?: string } | undefined
  > {
    const binding = await readWorkspaceThenGlobalSlotBinding(
      this.sessionContext.cwd,
      TIP_SAVE_SLOT,
    );
    if (binding === undefined || binding.inherit === true) return undefined;
    if (binding.model !== undefined) {
      try {
        this.modelCatalog.get(binding.model);
      } catch (error) {
        this.log.warn('ignoring tip-save slot binding with unknown model alias', {
          slot: TIP_SAVE_SLOT,
          modelAlias: binding.model,
          error,
        });
        return undefined;
      }
    }
    return { model: binding.model, thinking: binding.thinkingEffort };
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTipSaveService,
  SessionTipSaveService,
  ScopeActivation.OnScopeCreated,
  'session-tip-save',
);
