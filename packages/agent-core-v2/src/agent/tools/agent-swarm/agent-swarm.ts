/**
 * `tools` domain — `IAgentSwarmTool` contract (the `AgentSwarm` tool).
 *
 * Public contract of the `AgentSwarm` collaboration tool: the input zod
 * schema the model-facing parameters are derived from, the tool-owned
 * constants the schema is built around (prompt template placeholder, maximum
 * subagent count), and the `IAgentSwarmTool` DI decorator that the
 * implementation registers against via `registerAgentToolService`. Bound at
 * Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';
export const MAX_AGENT_SWARM_SUBAGENTS = 128;

export const AgentSwarmToolInputSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .describe('Short description for the whole swarm.'),
    subagent_type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.',
      ),
    prompt_template: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.`,
      ),
    items: z
      .array(z.string().trim().min(1))
      .max(MAX_AGENT_SWARM_SUBAGENTS)
      .optional()
      .describe(
        `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one new subagent.`,
      ),
    resume_agent_ids: z
      .record(z.string().trim().min(1), z.string().trim().min(1))
      .optional()
      .describe(
        'Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.',
      ),
    model: z
      .enum(['secondary', 'primary'])
      .optional()
      .describe(
        'Which model to run the item-spawned subagents on: "secondary" = the configured secondary model; "primary" = the main model you are running on (for hard, quality-sensitive tasks). This explicit choice overrides the selected agent type\'s model_preference; without either, secondary is the default when configured. Only effective when a secondary model is configured; otherwise subagents inherit your model. Resumed subagents always keep their own model.',
      ),
    binding_slot: z
      .string()
      .optional()
      .describe(
        'Named binding slot pre-configured by the user for this workspace (.kimi-code/local.toml under [subagent-slot.<name>]); applied to every subagent spawned from items in this batch. Set ONLY when the user, the task, or a preset explicitly names a slot — pass the name through verbatim; never invent slot names. An unconfigured slot name, or a slot referencing a model that is not configured, is reported as an error — subagents never silently inherit another model.',
      ),
  })
  .strict();

export type AgentSwarmToolInput = z.infer<typeof AgentSwarmToolInputSchema>;


export interface IAgentSwarmTool extends AgentTool<AgentSwarmToolInput> { readonly _serviceBrand: undefined }
export const IAgentSwarmTool = createDecorator<IAgentSwarmTool>('agentSwarmTool');
