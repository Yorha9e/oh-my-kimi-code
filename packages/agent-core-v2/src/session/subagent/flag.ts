/**
 * `subagent` domain — registers the subagent experimental flags
 * (`secondary-model`, `subagent-model-selection`, `subagent_fork`) into
 * `flag`.
 *
 * `secondary-model` gates secondary-model selection for newly spawned
 * subagents, including the agent-facing model choices and startup validation
 * warning. Off by default; enable via `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL`,
 * the master `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config
 * section. `subagent-model-selection` gates the TUI's binding-management
 * surfaces (the `/subagent-model` command reads the flag over RPC) and the
 * tool-level `binding_slot` parameter — the Agent / AgentSwarm tools strip it
 * from their advertised schemas and ignore it at spawn and resume while the
 * flag is off, mirroring v1's gating of the tool argument. The local.toml
 * profile-slot and per-type bindings are NOT gated by this flag: they are
 * applied mechanically at spawn even while the flag is off — a deliberate,
 * test-pinned v2 divergence, since v1 gates those bindings too
 * (subagent-host.ts:505,533). Released in the
 * community edition: on by default, disable via
 * `KIMI_CODE_EXPERIMENTAL_SUBAGENT_MODEL_SELECTION` or the config section.
 * `subagent_fork` gates the `fork` parameter on the Agent / AgentSwarm tools
 * (a subagent seeded with the caller's conversation history); off by default.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SECONDARY_MODEL_FLAG_ID = 'secondary-model';
export const SECONDARY_MODEL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL';

export const secondaryModelFlag: FlagDefinitionInput = {
  id: SECONDARY_MODEL_FLAG_ID,
  title: 'Secondary model for subagents',
  description:
    'Let newly spawned subagents use a separately configured secondary model by default, with an explicit primary-model override for quality-sensitive tasks.',
  env: SECONDARY_MODEL_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(secondaryModelFlag);

export const SUBAGENT_MODEL_SELECTION_FLAG_ID = 'subagent-model-selection';
export const SUBAGENT_MODEL_SELECTION_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SUBAGENT_MODEL_SELECTION';

export const subagentModelSelectionFlag: FlagDefinitionInput = {
  id: SUBAGENT_MODEL_SELECTION_FLAG_ID,
  title: 'Subagent model selection',
  description:
    'Bind configured model aliases and thinking efforts to subagent types per workspace (.kimi-code/local.toml); bindings are applied mechanically at spawn.',
  env: SUBAGENT_MODEL_SELECTION_FLAG_ENV,
  default: true,
  surface: 'core',
};

registerFlagDefinition(subagentModelSelectionFlag);

export const SUBAGENT_FORK_FLAG_ID = 'subagent_fork';
export const SUBAGENT_FORK_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK';

export const subagentForkFlag: FlagDefinitionInput = {
  id: SUBAGENT_FORK_FLAG_ID,
  title: 'Fork context for subagents',
  description:
    "Let the Agent and AgentSwarm tools start a subagent with a snapshot of the calling agent's conversation history via the fork parameter.",
  env: SUBAGENT_FORK_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(subagentForkFlag);
