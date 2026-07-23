import { z } from 'zod';

import { getUpdateStateFile } from '#/utils/paths';
import { readJsonFile, writeJsonFile } from '#/utils/persistence';

import { emptyUpdateCache, type ReleaseAsset, type UpdateCache } from './types';

const ReleaseAssetSchema: z.ZodType<ReleaseAsset> = z
  .object({
    name: z.string().min(1),
    url: z.string().min(1),
  })
  .strict();

// Stays `.strict()` (we own this file). A cache from the old CDN channel
// (or a corrupt file) fails the literal/shape check and falls back to an
// empty cache, triggering a fresh release check. Malformed asset entries
// are dropped individually so one bad entry cannot discard a known
// `latest` version.
const UpdateCacheSchema: z.ZodType<UpdateCache> = z
  .object({
    source: z.literal('github'),
    checkedAt: z.string().min(1).nullable(),
    latest: z.string().min(1).nullable(),
    tag: z.string().min(1).nullable(),
    releaseUrl: z.string().min(1).nullable(),
    assets: z.preprocess((value) => {
      if (!Array.isArray(value)) return [];
      return value.filter((entry) => ReleaseAssetSchema.safeParse(entry).success);
    }, z.array(ReleaseAssetSchema).readonly()),
  })
  .strict();

export async function readUpdateCache(
  filePath: string = getUpdateStateFile(),
): Promise<UpdateCache> {
  try {
    return await readJsonFile(filePath, UpdateCacheSchema, emptyUpdateCache());
  } catch {
    return emptyUpdateCache();
  }
}

export async function writeUpdateCache(
  value: UpdateCache,
  filePath: string = getUpdateStateFile(),
): Promise<void> {
  await writeJsonFile(filePath, UpdateCacheSchema, value);
}
