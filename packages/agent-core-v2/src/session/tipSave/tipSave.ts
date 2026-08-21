
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
