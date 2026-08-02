/**
 * `tipSave` domain — background tip-saving child agent contract.
 *
 * A tip-save agent is a fork of the main agent used to summarize the current
 * discussion into moamcp Project Tips: it inherits the parent's profile and
 * full context, keeps every tool enabled (unlike `btw`, no tool veto is
 * installed — the child must be able to call the `moa_tip_create` MCP tool),
 * and runs a single background turn whose plain-text report is surfaced to
 * the user by the host. The host sends the summarization prompt itself; this
 * service only materializes the bound fork.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/** Named binding slot for the tip-save child model (`[subagent-slot.tip_save]`). */
export const TIP_SAVE_SLOT = 'tip_save';

export interface ISessionTipSaveService {
  readonly _serviceBrand: undefined;

  /** Fork the main agent with the resolved model binding and return the child id. */
  start(): Promise<string>;
}

export const ISessionTipSaveService: ServiceIdentifier<ISessionTipSaveService> =
  createDecorator<ISessionTipSaveService>('sessionTipSaveService');
