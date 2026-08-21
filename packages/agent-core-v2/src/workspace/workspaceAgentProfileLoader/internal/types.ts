import type { SkippedAgentFile } from '#/app/agentProfileCatalog/agentProfileContribution';
import type { AgentModelPreference } from '#/session/subagent/configSection';

export type { SkippedAgentFile } from '#/app/agentProfileCatalog/agentProfileContribution';

export type AgentFileSource = 'plugin' | 'project' | 'user' | 'extra' | 'explicit';

export interface AgentFileRoot {
  readonly path: string;
  readonly source: AgentFileSource;
}

export interface AgentFileDefinition {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly override: boolean;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly modelPreference?: AgentModelPreference;
  /**
   * OMKC extension: named binding slot (`[subagent-slot.<name>]`) the profile
   * declares for spawn-time model binding. Parsed and carried on the profile;
   * v2 spawn resolution lands in a later iteration.
   */
  readonly slot?: string;
  readonly prompt: string;
  readonly path: string;
  readonly source: AgentFileSource;
}

export interface AgentFileDiscoveryResult {
  readonly agents: readonly AgentFileDefinition[];
  readonly skipped: readonly SkippedAgentFile[];
  readonly scannedRoots: readonly string[];
}
