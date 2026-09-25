import type { CompactionBlocked, CompactionCancelled, CompactionCompleted, CompactionStarted } from '#/agent/fullCompaction/compactionOps';
import type { AssistantDelta, ThinkingDelta, ToolCallDelta, TurnStarted, TurnStepCompleted, TurnStepInterrupted, TurnStepStarted } from '#/agent/loop/turnEvents';
import type { TurnEnded } from '#/agent/loop/turnOps';
import type { AgentErrorEvent, McpServerStatus, ToolListUpdated } from '#/agent/mcp/mcpEvents';
import type { PluginCommandActivated } from '#/agent/pluginCommand/pluginCommand';
import type { WarningEvent } from '#/agent/profile/profileService';
import type { PromptAccepted } from '#/agent/prompt/promptOps';
import type { PromptAborted, PromptCompleted, PromptSteered } from '#/agent/prompt/promptService';
import type { ShellCompleted, ShellOutput, ShellStarted } from '#/agent/shellCommand/shellCommandService';
import type { SkillActivated } from '#/agent/skill/skillOps';
import type { TurnStepRetrying } from '#/agent/stepRetry/stepRetryService';
import type { TaskStarted, TaskTerminated } from '#/agent/task/taskOps';
import type { ToolCallStarted, ToolProgress, ToolResultEventPayload } from '#/agent/toolExecutor/toolExecutorEvents';
import type { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import type { CapabilityChanged } from '#/app/capability/capabilityEvents';
import type { ConfigChanged, ConfigWarning } from '#/app/config/configEvents';
import type { ModelCatalogChanged } from '#/app/kosongConfig/discovery';
import type { PluginChanged } from '#/app/plugin/pluginEvents';
import type { WorkspaceCreated, WorkspaceDeleted, WorkspaceUpdated } from '#/app/workspace/workspaceEvents';
import type { HookResult } from '#/features/externalHooks/agent/agentExternalHooksService';
import type { GoalUpdated } from '#/features/goal/goalOps';
import type { SubagentSuspended } from '#/features/swarm/session/sessionSwarmService';
import type { CronFired } from '#/session/cron/cronOps';
import type { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';
import type { SubagentCompleted, SubagentFailed, SubagentSpawned, SubagentStarted } from '#/session/subagent/mirrorAgentRun';
import type { SessionCreated } from '#/workspace/sessionLifecycle/sessionLifecycleEvents';

export interface ToolResultEvent extends Omit<ToolResultEventPayload, 'agentId'> {
  readonly type: 'tool.result';
}

export type AgentEvent =
  | AgentErrorEvent
  | WarningEvent
  | AgentStatusUpdated
  | SessionMetaUpdated
  | SessionCreated
  | WorkspaceCreated
  | WorkspaceUpdated
  | WorkspaceDeleted
  | ConfigChanged
  | ConfigWarning
  | ModelCatalogChanged
  | PluginChanged
  | CapabilityChanged
  | GoalUpdated
  | SkillActivated
  | PluginCommandActivated
  | TurnStarted
  | TurnEnded
  | TurnStepStarted
  | TurnStepCompleted
  | TurnStepRetrying
  | TurnStepInterrupted
  | AssistantDelta
  | HookResult
  | ThinkingDelta
  | ToolCallDelta
  | ToolCallStarted
  | ToolProgress
  | ShellOutput
  | ShellStarted
  | ShellCompleted
  | ToolResultEvent
  | ToolListUpdated
  | McpServerStatus
  | SubagentSpawned
  | SubagentStarted
  | SubagentSuspended
  | SubagentCompleted
  | SubagentFailed
  | CompactionStarted
  | CompactionBlocked
  | CompactionCancelled
  | CompactionCompleted
  | TaskStarted
  | TaskTerminated
  | CronFired
  | PromptAccepted
  | PromptCompleted
  | PromptAborted
  | PromptSteered;

export type ErrorEvent = AgentErrorEvent;
export type AgentStatusUpdatedEvent = AgentStatusUpdated;
export type SessionMetaUpdatedEvent = SessionMetaUpdated;
export type SessionCreatedEvent = SessionCreated;
export type WorkspaceCreatedEvent = WorkspaceCreated;
export type WorkspaceUpdatedEvent = WorkspaceUpdated;
export type WorkspaceDeletedEvent = WorkspaceDeleted;
export type ConfigChangedEvent = ConfigChanged;
export type ConfigWarningEvent = ConfigWarning;
export type ModelCatalogChangedEvent = ModelCatalogChanged;
export type PluginChangedEvent = PluginChanged;
export type CapabilityChangedEvent = CapabilityChanged;
export type GoalUpdatedEvent = GoalUpdated;
export type SkillActivatedEvent = SkillActivated;
export type PluginCommandActivatedEvent = PluginCommandActivated;
export type TurnStartedEvent = TurnStarted;
export type TurnEndedEvent = TurnEnded;
export type TurnStepStartedEvent = TurnStepStarted;
export type TurnStepCompletedEvent = TurnStepCompleted;
export type TurnStepRetryingEvent = TurnStepRetrying;
export type TurnStepInterruptedEvent = TurnStepInterrupted;
export type AssistantDeltaEvent = AssistantDelta;
export type HookResultEvent = HookResult;
export type ThinkingDeltaEvent = ThinkingDelta;
export type ToolCallDeltaEvent = ToolCallDelta;
export type ToolCallStartedEvent = ToolCallStarted;
export type ToolProgressEvent = ToolProgress;
export type ShellOutputEvent = ShellOutput;
export type ShellStartedEvent = ShellStarted;
export type ShellCompletedEvent = ShellCompleted;
export type ToolListUpdatedEvent = ToolListUpdated;
export type McpServerStatusEvent = McpServerStatus;
export type SubagentSpawnedEvent = SubagentSpawned;
export type SubagentStartedEvent = SubagentStarted;
export type SubagentSuspendedEvent = SubagentSuspended;
export type SubagentCompletedEvent = SubagentCompleted;
export type SubagentFailedEvent = SubagentFailed;
export type CompactionStartedEvent = CompactionStarted;
export type CompactionBlockedEvent = CompactionBlocked;
export type CompactionCancelledEvent = CompactionCancelled;
export type CompactionCompletedEvent = CompactionCompleted;
export type TaskStartedEvent = TaskStarted;
export type TaskTerminatedEvent = TaskTerminated;
export type CronFiredEvent = CronFired;
export type PromptSubmittedEvent = PromptAccepted;
export type PromptCompletedEvent = PromptCompleted;
export type PromptAbortedEvent = PromptAborted;
export type PromptSteeredEvent = PromptSteered;

export type Event = AgentEvent & { agentId: string; sessionId: string };
