export {
  detectTarget,
  extractRgFromZip,
  findExistingRg,
  getShareBinRgPath,
  rgUnavailableMessage,
  verifyArchiveChecksum,
  type EnsureRgPathOptions,
  type RgProbe,
  type RgResolution,
  type RgResolutionSource,
} from '#/os/backends/node-local/tools/rgLocator';
import {
  ensureRgPath as ensureHostRgPath,
  type EnsureRgPathOptions,
  type RgProbe,
  type RgResolution,
} from '#/os/backends/node-local/tools/rgLocator';

export function ensureRgPath(
  probe: RgProbe,
  options: EnsureRgPathOptions = {},
): Promise<RgResolution> {
  return ensureHostRgPath(probe, {
    shareDir: options.shareDir,
    signal: options.signal,
    allowCachedFallback: options.allowCachedFallback,
    preferProbe: true,
    download: false,
  });
}
