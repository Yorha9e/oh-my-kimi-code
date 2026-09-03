import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    name: 'agent-core-v2',
    include: ['test/**/*.{test,e2e,integration}.ts'],
    setupFiles: ['test/setup.ts'],
    alias: {
      immer: fileURLToPath(
        new URL('../../node_modules/.pnpm/immer@11.1.11/node_modules/immer/dist/immer.mjs', import.meta.url),
      ),
      semver: fileURLToPath(
        new URL('../../node_modules/.pnpm/semver@7.7.4/node_modules/semver/index.js', import.meta.url),
      ),
      '#/session/btw/btw': fileURLToPath(
        new URL('./src/features/btw/btw.ts', import.meta.url),
      ),
      '#/session/btw/btwService': fileURLToPath(
        new URL('./src/features/btw/btwService.ts', import.meta.url),
      ),
    },
  },
});