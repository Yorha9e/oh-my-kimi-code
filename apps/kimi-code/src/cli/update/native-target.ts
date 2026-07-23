/**
 * Native release target identification for the community single-file
 * executables. Mirrors `scripts/native/paths.mjs` (`targetTriple` /
 * `executableName`) and the `omkc-<target>.zip` asset naming produced by
 * `scripts/native/package.mjs`, so the updater always asks a release for
 * exactly the artifact the build pipeline uploaded.
 */

export const NATIVE_MANIFEST_ASSET_NAME = 'manifest.json';

/**
 * `<platform>-<arch>` target triple, e.g. `win32-x64` or `darwin-arm64`.
 * `KIMI_CODE_BUILD_TARGET` overrides detection for custom builds — same
 * escape hatch as the native build scripts.
 */
export function nativeTargetTriple(
  platform: NodeJS.Platform,
  arch: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return env['KIMI_CODE_BUILD_TARGET'] ?? `${platform}-${arch}`;
}

export function nativeExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'omkc.exe' : 'omkc';
}

export function nativeAssetFileName(target: string): string {
  return `omkc-${target}.zip`;
}

export function nativeChecksumAssetFileName(target: string): string {
  return `${nativeAssetFileName(target)}.sha256`;
}
