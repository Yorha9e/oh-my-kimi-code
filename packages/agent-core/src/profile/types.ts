import type { Environment } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { SkillRegistry } from '../agent/skill/types';

export const RawSubagentProfileSchema = z.object({
  description: z.string().optional(),
  modelAlias: z.string().optional(),
  thinkingEffort: z.string().optional(),
});

export type RawSubagentProfile = z.infer<typeof RawSubagentProfileSchema>;

/**
 * Symbolic model preference a profile declares for subagent spawning: the
 * `Agent` / `AgentSwarm` tools use it as the default for their `model`
 * parameter when the call does not pass one explicitly.
 */
export const AgentModelPreferenceSchema = z.enum(['primary', 'secondary']);

export type AgentModelPreference = z.infer<typeof AgentModelPreferenceSchema>;

export const RawAgentProfileSchema = z.object({
  extends: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  systemPromptPath: z.string().optional(),
  systemPromptTemplate: z.string().optional(),
  promptVars: z.record(z.string(), z.string()).optional(),
  // Exact builtin/user tool names, plus optional MCP glob patterns
  // (`mcp__*`, `mcp__github__*`) that gate which MCP tools the profile sees.
  tools: z.array(z.string()).optional(),
  whenToUse: z.string().optional(),
  subagents: z.record(z.string(), RawSubagentProfileSchema).optional(),
  modelPreference: AgentModelPreferenceSchema.optional(),
});

export type RawAgentProfile = z.infer<typeof RawAgentProfileSchema>;

/**
 * Runtime context supplied to a system prompt renderer.
 *
 * Captures everything determined at render time rather than at profile-load
 * time: the OS/shell, working directory, AGENTS.md instructions, available
 * skills, and so on. Loaders return renderers; callers invoke them with
 * the live context whenever a concrete prompt is needed.
 */
export interface SystemPromptContext {
  readonly osEnv: Environment;
  readonly cwd: string;
  readonly now?: string | Date;
  readonly cwdListing?: string;
  readonly agentsMd?: string;
  readonly skills?: SkillRegistry | string;
  readonly pluginSections?: string;
  readonly additionalDirsInfo?: string;
  readonly roleAdditional?: string;
}

export type SystemPromptRenderer = (context: SystemPromptContext) => string;

export interface ResolvedAgentProfile {
  name: string;
  description?: string;
  systemPrompt: SystemPromptRenderer;
  tools: string[];
  /**
   * Denylist with the same matching rules as `tools` (exact builtin/user
   * names plus `mcp__…` glob patterns), applied on top of the `tools`
   * allowlist when the profile takes effect.
   */
  disallowedTools?: string[];
  whenToUse?: string;
  /**
   * Optional model/thinking overrides bound at the owner's `subagents` entry.
   * `undefined` means the subagent inherits the parent agent's settings.
   */
  modelAlias?: string;
  thinkingEffort?: string;
  subagents?: Record<string, ResolvedAgentProfile>;
  /**
   * Merged prompt vars (template substitutions) the system-prompt renderer
   * closes over. Exposed so callers can read already-resolved values such as
   * `roleAdditional` without re-parsing the source profile.
   */
  promptVars?: Record<string, string>;
  modelPreference?: AgentModelPreference;
  /**
   * Named binding slot declared in the agent-file frontmatter (OMKC
   * extension): the shared spawn path binds the child to the stored
   * `[subagent-slot.<slot>]` binding when no per-run override or type
   * binding applies. Builtin profiles leave it unset.
   */
  slot?: string;
}
