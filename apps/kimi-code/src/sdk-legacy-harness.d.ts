import type { createKimiHarnessV2 } from '@moonshot-ai/kimi-code-sdk';

/**
 * Compatibility alias for the pre-v2 `createKimiHarness` export that the CLI
 * call sites still import. The SDK now ships only `createKimiHarnessV2` (the
 * same implementation the legacy name used to point at), so bind the legacy
 * name to it at the type level instead of touching every call site. Remove
 * this file once the app imports the V2 name everywhere (or once the SDK
 * re-exports the legacy name).
 */
declare module '@moonshot-ai/kimi-code-sdk' {
  export const createKimiHarness: typeof createKimiHarnessV2;
}
