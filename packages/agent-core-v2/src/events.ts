import type { KimiErrorPayload } from '#/_base/errors/serialize';
import type { CompactionBlockedEvent, CompactionCancelledEvent, CompactionCompletedEvent, CompactionStartedEvent } from '#/agent/fullCompaction/compactionOps';
import type { AssistantDeltaEvent, ThinkingDeltaEvent, ToolCallDeltaEvent, TurnStartedEvent, TurnStepCompletedEvent, TurnStepInterruptedEvent, TurnStepStartedEvent } from '#/agent/loop/turnEvents';
import type { TurnEndedEvent } from '#/agent/loop/turnOps';
import type { McpServerStatusEvent, ToolListUpdatedEvent } from '#/agent/mcp/mcpEvents';
import type { PluginCommandActivatedEvent } from '#/agent/pluginCommand/pluginCommand';
import type { WarningEvent } from '#/agent/profile/profileService';
import type { PromptSubmittedEvent } from '#/agent/prompt/promptOps';
import type { PromptAbortedEvent, PromptCompletedEvent, PromptSteeredEvent } from '#/agent/prompt/promptService';
import type { ShellCompletedEvent, ShellOutputEvent, ShellStartedEvent } from '#/agent/shellCommand/shellCommandService';
import type { SkillActivatedEvent } from '#/agent/skill/skillOps';
import type { TurnStepRetryingEvent } from '#/agent/stepRetry/stepRetryService';
import type { TaskStartedEvent, TaskTerminatedEvent } from '#/agent/task/taskOps';
import type { ToolCallStartedEvent, ToolProgressEvent, ToolResultEventPayload } from '#/agent/toolExecutor/toolExecutorEvents';
import type { AgentStatusUpdatedEvent } from '#/agent/usage/usageEvents';
import type { CapabilityChangedEvent } from '#/app/capability/capabilityEvents';
import type { ConfigChangedEvent, ConfigWarningEvent } from '#/app/config/configEvents';
import type { ModelCatalogChangedEvent } from '#/app/kosongConfig/discovery';
import type { PluginChangedEvent } from '#/app/plugin/pluginEvents';
import type { WorkspaceCreatedEvent, WorkspaceDeletedEvent, WorkspaceUpdatedEvent } from '#/app/workspace/workspaceEvents';
import type { HookResultEvent } from '#/features/externalHooks/agent/agentExternalHooksService';
import type { GoalUpdatedEvent } from '#/features/goal/goalOps';
import type { SubagentSuspendedEvent } from '#/features/swarm/session/sessionSwarmService';
import type { CronFiredEvent } from '#/session/cron/cronOps';
import type { SessionMetaUpdatedEvent } from '#/session/sessionMetadata/sessionMetaEvents';
import type { SubagentCompletedEvent, SubagentFailedEvent, SubagentSpawnedEvent, SubagentStartedEvent } from '#/session/subagent/mirrorAgentRun';
import type { SessionCreatedEvent } from '#/workspace/sessionLifecycle/sessionLifecycleEvents';

export type { KimiErrorPayload } from '#/_base/errors/serialize';
export type { CompactionBlockedEvent, CompactionCancelledEvent, CompactionCompletedEvent, CompactionStartedEvent } from '#/agent/fullCompaction/compactionOps';
export type { AssistantDeltaEvent, ThinkingDeltaEvent, ToolCallDeltaEvent, TurnStartedEvent, TurnStepCompletedEvent, TurnStepInterruptedEvent, TurnStepStartedEvent } from '#/agent/loop/turnEvents';
export type { TurnEndedEvent } from '#/agent/loop/turnOps';
export type { McpServerStatusEvent, ToolListUpdatedEvent } from '#/agent/mcp/mcpEvents';
export type { PluginCommandActivatedEvent } from '#/agent/pluginCommand/pluginCommand';
export type { WarningEvent } from '#/agent/profile/profileService';
export type { PromptSubmittedEvent } from '#/agent/prompt/promptOps';
export type { PromptAbortedEvent, PromptCompletedEvent, PromptSteeredEvent } from '#/agent/prompt/promptService';
export type { ShellCompletedEvent, ShellOutputEvent, ShellStartedEvent } from '#/agent/shellCommand/shellCommandService';
export type { SkillActivatedEvent } from '#/agent/skill/skillOps';
export type { TurnStepRetryingEvent } from '#/agent/stepRetry/stepRetryService';
export type { TaskStartedEvent, TaskTerminatedEvent } from '#/agent/task/taskOps';
export type { ToolCallStartedEvent, ToolProgressEvent, ToolResultEventPayload } from '#/agent/toolExecutor/toolExecutorEvents';
export type { AgentStatusUpdatedEvent } from '#/agent/usage/usageEvents';
export type { CapabilityChangedEvent } from '#/app/capability/capabilityEvents';
export type { ConfigChangedEvent, ConfigWarningEvent } from '#/app/config/configEvents';
export type { ModelCatalogChangedEvent } from '#/app/kosongConfig/discovery';
export type { PluginChangedEvent } from '#/app/plugin/pluginEvents';
export type { WorkspaceCreatedEvent, WorkspaceDeletedEvent, WorkspaceUpdatedEvent } from '#/app/workspace/workspaceEvents';
export type { HookResultEvent } from '#/features/externalHooks/agent/agentExternalHooksService';
export type { GoalUpdatedEvent } from '#/features/goal/goalOps';
export type { SubagentSuspendedEvent } from '#/features/swarm/session/sessionSwarmService';
export type { CronFiredEvent } from '#/session/cron/cronOps';
export type { SessionMetaUpdatedEvent } from '#/session/sessionMetadata/sessionMetaEvents';
export type { SubagentCompletedEvent, SubagentFailedEvent, SubagentSpawnedEvent, SubagentStartedEvent } from '#/session/subagent/mirrorAgentRun';
export type { SessionCreatedEvent } from '#/workspace/sessionLifecycle/sessionLifecycleEvents';

export interface ErrorEvent extends KimiErrorPayload {
  readonly type: 'error';
}

export interface ToolResultEvent extends Omit<ToolResultEventPayload, 'agentId'> {
  readonly type: 'tool.result';
}

export type AgentEvent =
  | ErrorEvent
  | WarningEvent
  | AgentStatusUpdatedEvent
  | SessionMetaUpdatedEvent
  | SessionCreatedEvent
  | WorkspaceCreatedEvent
  | WorkspaceUpdatedEvent
  | WorkspaceDeletedEvent
  | ConfigChangedEvent
  | ConfigWarningEvent
  | ModelCatalogChangedEvent
  | PluginChangedEvent
  | CapabilityChangedEvent
  | GoalUpdatedEvent
  | SkillActivatedEvent
  | PluginCommandActivatedEvent
  | TurnStartedEvent
  | TurnEndedEvent
  | TurnStepStartedEvent
  | TurnStepCompletedEvent
  | TurnStepRetryingEvent
  | TurnStepInterruptedEvent
  | AssistantDeltaEvent
  | HookResultEvent
  | ThinkingDeltaEvent
  | ToolCallDeltaEvent
  | ToolCallStartedEvent
  | ToolProgressEvent
  | ShellOutputEvent
  | ShellStartedEvent
  | ShellCompletedEvent
  | ToolResultEvent
  | ToolListUpdatedEvent
  | McpServerStatusEvent
  | SubagentSpawnedEvent
  | SubagentStartedEvent
  | SubagentSuspendedEvent
  | SubagentCompletedEvent
  | SubagentFailedEvent
  | CompactionStartedEvent
  | CompactionBlockedEvent
  | CompactionCancelledEvent
  | CompactionCompletedEvent
  | TaskStartedEvent
  | TaskTerminatedEvent
  | CronFiredEvent
  | PromptSubmittedEvent
  | PromptCompletedEvent
  | PromptAbortedEvent
  | PromptSteeredEvent;

export type Event = AgentEvent & { agentId: string; sessionId: string };
