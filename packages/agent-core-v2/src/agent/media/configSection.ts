import { z } from 'zod';

import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

import { IMAGE_MAX_EDGE_ENV, IMAGE_READ_BYTE_BUDGET_ENV } from './image-compress';

export { IMAGE_MAX_EDGE_ENV, IMAGE_READ_BYTE_BUDGET_ENV };

export const IMAGE_SECTION = 'image';

export const ImageConfigSchema = z.object({
  maxEdgePx: z.number().int().min(1).optional(),
  readByteBudget: z.number().int().min(1).optional(),
});

export type ImageConfig = z.infer<typeof ImageConfigSchema>;

function parsePositiveInt(raw: string): number | undefined {
  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export const imageEnvBindings: EnvBindings<ImageConfig> = envBindings(ImageConfigSchema, {
  maxEdgePx: { env: IMAGE_MAX_EDGE_ENV, parse: parsePositiveInt },
  readByteBudget: { env: IMAGE_READ_BYTE_BUDGET_ENV, parse: parsePositiveInt },
});

export const stripImageEnv = stripEnvBoundFields(imageEnvBindings);

registerConfigSection(IMAGE_SECTION, ImageConfigSchema, {
  defaultValue: {},
  env: imageEnvBindings,
  stripEnv: stripImageEnv,
});
