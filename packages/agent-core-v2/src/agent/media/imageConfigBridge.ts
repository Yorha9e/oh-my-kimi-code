import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { MAX_IMAGE_EDGE_PX, READ_IMAGE_BYTE_BUDGET } from '#/agent/media/image-compress';

import { IMAGE_SECTION, type ImageConfig } from './configSection';

export interface IImageConfigBridge {
  readonly _serviceBrand: undefined;
  maxEdgePx(): number;
  readByteBudget(): number;
}

export const IImageConfigBridge: ServiceIdentifier<IImageConfigBridge> =
  createDecorator<IImageConfigBridge>('imageConfigBridge');

export class ImageConfigBridge implements IImageConfigBridge {
  declare readonly _serviceBrand: undefined;

  constructor(@IConfigService private readonly config: IConfigService) {}

  maxEdgePx(): number {
    return positiveIntOr(this.config.get<ImageConfig>(IMAGE_SECTION)?.maxEdgePx, MAX_IMAGE_EDGE_PX);
  }

  readByteBudget(): number {
    return positiveIntOr(
      this.config.get<ImageConfig>(IMAGE_SECTION)?.readByteBudget,
      READ_IMAGE_BYTE_BUDGET,
    );
  }
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

registerScopedService(
  LifecycleScope.App,
  IImageConfigBridge,
  ImageConfigBridge,
  ScopeActivation.OnScopeCreated,
  'media',
);
