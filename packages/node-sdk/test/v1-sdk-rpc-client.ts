/**
 * v2-backed aliases for the pre-M6 harness factory names.
 *
 * The v1 (`@moonshot-ai/agent-core`) engine is gone; the v1-era suites in this
 * directory still construct their harness through `createKimiHarness` /
 * `SDKRpcClient`, so those names alias the v2 client (`createKimiHarnessV2` /
 * `SDKRpcClientV2`) here instead of being rewritten file by file. The
 * `v1-v2-parity` net itself was deleted along with the v1 engine.
 */
export {
  createKimiHarnessV2 as createKimiHarness,
  SDKRpcClientV2 as SDKRpcClient,
} from '#/index';
