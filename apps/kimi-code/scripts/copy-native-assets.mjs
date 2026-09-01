import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');
const source = resolve(repoRoot, 'packages/pi-tui/native');
const target = resolve(appRoot, 'native');

// pi-tui ships platform-specific native helpers only for darwin/win32;
// Linux has no native helper, so there is nothing to copy for it.
const PLATFORMS = ['darwin', 'win32'];

async function assertPrebuilds(platform) {
  const dir = resolve(source, platform, 'prebuilds');
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new Error(
      `pi-tui native prebuilds were not found at ${dir}. Build or restore packages/pi-tui first.`,
    );
  }
  return dir;
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const platform of PLATFORMS) {
  const srcPrebuilds = await assertPrebuilds(platform);
  const dstPrebuilds = resolve(target, platform, 'prebuilds');
  await cp(srcPrebuilds, dstPrebuilds, { recursive: true });
}

console.log(`Copied pi-tui native prebuilds to ${target}`);

// @cursor/sdk is bundled into dist/main.mjs, but its webpack runtime loads
// numbered chunks (`import("./" + id + ".js")`, e.g. 986.js) relative to the
// entry file at runtime. Ship those chunk files next to main.mjs so the
// loader resolves inside the installed package instead of 404-ing.
const kosongRequire = createRequire(resolve(repoRoot, 'packages/kosong/package.json'));
const sdkEntry = kosongRequire.resolve('@cursor/sdk');
const sdkEsmDir = resolve(dirname(sdkEntry).replace(/dist[\\/]cjs([\\/])?$/, 'dist/esm$1') ?? dirname(sdkEntry));
const distDir = resolve(appRoot, 'dist');
await mkdir(distDir, { recursive: true });
let chunkCount = 0;
for (const file of await readdir(sdkEsmDir)) {
  if (!/^\d+\.js$/.test(file)) continue;
  await cp(resolve(sdkEsmDir, file), resolve(distDir, file));
  chunkCount++;
}
console.log(`Copied ${chunkCount} @cursor/sdk chunks to ${distDir}`);
