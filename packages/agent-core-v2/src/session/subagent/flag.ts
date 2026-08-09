/**
 * `subagent` domain — registers the subagent experimental flags
 * (`secondary-model`, `subagent-model-selection`) into `flag`.
 *
 * `secondary-model` gates secondary-model selection for newly spawned
 * subagents, including the agent-facing model choices and startup validation
 * warning. Off by default; enable via `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL`,
 * the master `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config
 * section. `subagent-model-selection` gates the TUI's binding-management
 * surfaces (the `/subagent-model` command reads the flag over RPC); the
 * binding mechanism itself is always applied at spawn. Released in the
 * community edition: on by default, disable via
 * `KIMI_CODE_EXPERIMENTAL_SUBAGENT_MODEL_SELECTION` or the config section.
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
