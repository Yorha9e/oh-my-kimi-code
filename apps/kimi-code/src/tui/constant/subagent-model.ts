/**
 * Subagent types that ship as built-in agent profiles (the
 * `packages/agent-core/src/profile/default/*.yaml` profiles, excluding the
 * base `agent` profile). The SDK exposes no registry of known subagent types,
 * so the settings panel unions this set with the types that already carry a
 * binding in the workspace.
 */
export const BUILTIN_SUBAGENT_TYPES = [
  'coder',
  'critic',
  'explore',
  'orchestrator',
  'plan',
  'synthesizer',
] as const;
