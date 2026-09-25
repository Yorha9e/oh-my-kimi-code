import type {
  AgentEvent as EngineAgentEvent,
  AssistantDeltaEvent,
  CompactionBlockedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
  ConfigChangedEvent,
  ConfigWarningEvent,
  CapabilityChangedEvent,
  CronFiredEvent,
  ErrorEvent,
  GoalUpdatedEvent,
  HookResultEvent,
  ModelCatalogChangedEvent,
  McpServerStatusEvent,
  PluginChangedEvent,
  PluginCommandActivatedEvent,
  PromptAbortedEvent,
  PromptCompletedEvent,
  PromptSteeredEvent,
  PromptSubmittedEvent,
  SessionCreatedEvent,
  SessionMetaUpdatedEvent,
  SkillActivatedEvent,
  ShellCompletedEvent,
  ShellOutputEvent,
  ShellStartedEvent,
  SubagentCompletedEvent,
  SubagentFailedEvent,
  SubagentSpawnedEvent,
  SubagentStartedEvent,
  SubagentSuspendedEvent,
  TaskStartedEvent,
  TaskTerminatedEvent,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolListUpdatedEvent,
  ToolProgressEvent,
  ToolResultEvent,
  TurnEndedEvent,
  TurnStartedEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepRetryingEvent,
  TurnStepStartedEvent,
  AgentStatusUpdatedEvent,
  WorkspaceCreatedEvent,
  WorkspaceDeletedEvent,
  WorkspaceUpdatedEvent,
} from '@moonshot-ai/agent-core-v2/events';
import type { WarningEvent } from '@moonshot-ai/agent-core-v2/agent/profile/profileService';

import type {
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
} from '#/interaction';
import type { BackgroundTaskInfo } from '#/task';
import type { KimiErrorCode } from '#/errors';

export type {
  AgentStatusUpdatedEvent,
  AssistantDeltaEvent,
  CompactionBlockedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
  ConfigChangedEvent,
  ConfigWarningEvent,
  CapabilityChangedEvent,
  CronFiredEvent,
  ErrorEvent,
  GoalUpdatedEvent,
  HookResultEvent,
  ModelCatalogChangedEvent,
  McpServerStatusEvent,
  PluginChangedEvent,
  PluginCommandActivatedEvent,
  PromptAbortedEvent,
  PromptCompletedEvent,
  PromptSteeredEvent,
  PromptSubmittedEvent,
  SessionCreatedEvent,
  SessionMetaUpdatedEvent,
  SkillActivatedEvent,
  ShellCompletedEvent,
  ShellOutputEvent,
  ShellStartedEvent,
  SubagentCompletedEvent,
  SubagentFailedEvent,
  SubagentSpawnedEvent,
  SubagentStartedEvent,
  SubagentSuspendedEvent,
  TaskStartedEvent,
  TaskTerminatedEvent,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolListUpdatedEvent,
  ToolProgressEvent,
  TurnEndedEvent,
  TurnStartedEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepRetryingEvent,
  TurnStepStartedEvent,
  WorkspaceCreatedEvent,
  WorkspaceDeletedEvent,
  WorkspaceUpdatedEvent,
  ToolResultEvent,
} from '@moonshot-ai/agent-core-v2/events';
export type { WarningEvent } from '@moonshot-ai/agent-core-v2/agent/profile/profileService';

export type { KimiErrorPayload } from '#/errors';

export { MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE } from '@moonshot-ai/agent-core-v2/agent/mcp/tools/auth';

/**
 * Legacy-spelling task lifecycle events. The v2 engine emits `task.started` /
 * `task.terminated`, but the SDK event stream renames them at the v1 edge
 * (`v2/event-mapper.ts`) so consumers see the pre-v2 wire spelling on both
 * engines; the v2 `Event` union only carries the `task.*` members, so the two
 * renamed variants are unioned in here to keep the public `Event` type honest
 * with what the stream actually delivers.
 */
export interface BackgroundTaskStartedEvent {
  readonly type: 'background.task.started';
  readonly info: BackgroundTaskInfo;
}

export interface BackgroundTaskTerminatedEvent {
  readonly type: 'background.task.terminated';
  readonly info: BackgroundTaskInfo;
}

/**
 * Session lifecycle facts emitted by the v1 core only (the v2 engine has no
 * emission site for either — `agent.activity.updated` replaced them on the v2
 * path). Kept in the `Event` union while the v1 client exists so its stream
 * stays exhaustively typed; removed together with v1 in M6.
 */
export interface SessionStatusChangedEvent {
  readonly type: 'event.session.status_changed';
  readonly status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';
  readonly previous_status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';
  readonly current_prompt_id?: string;
}

export interface SessionWorkChangedEvent {
  readonly type: 'event.session.work_changed';
  readonly busy: boolean;
  /** Main-agent turn liveness, excluding background and sub-agent work. */
  readonly main_turn_active?: boolean;
  /** Highest-priority pending interaction for clients without a session subscription. */
  readonly pending_interaction?: 'none' | 'approval' | 'question';
  /** Outcome of the MAIN agent's most recent turn, when one has ended since
   *  activation (see `Session.last_turn_reason`). */
  readonly last_turn_reason?: 'completed' | 'cancelled' | 'failed';
}

/**
 * The SDK's `error` event carries the SDK's public error protocol
 * (`KimiErrorCode` from `#/errors`), which is wider than the engine's own
 * code registry — the engine's class type is kept for the completeness
 * assert only, the wire member below is what consumers see.
 */
interface SdkErrorEvent {
  readonly type: 'error';
  readonly code: KimiErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
}

/**
 * The v2 engine's `Event2` payloads declare their wire `type` only on the
 * class static (`static readonly type`), so the engine union's members carry
 * `type: string` and do not discriminate. The SDK's public `Event` re-attaches
 * each member's literal through this map — the values are exactly the engine
 * union's members (asserted below), the keys the literals the stream delivers.
 */
interface EngineEventMap {
  readonly 'error': SdkErrorEvent;
  readonly 'warning': WarningEvent;
  readonly 'agent.status.updated': AgentStatusUpdatedEvent;
  readonly 'session.meta.updated': SessionMetaUpdatedEvent;
  readonly 'event.session.created': SessionCreatedEvent;
  readonly 'event.workspace.created': WorkspaceCreatedEvent;
  readonly 'event.workspace.updated': WorkspaceUpdatedEvent;
  readonly 'event.workspace.deleted': WorkspaceDeletedEvent;
  readonly 'event.config.changed': ConfigChangedEvent;
  readonly 'event.config.warning': ConfigWarningEvent;
  readonly 'event.model_catalog.changed': ModelCatalogChangedEvent;
  readonly 'event.plugin.changed': PluginChangedEvent;
  readonly 'event.capability.changed': CapabilityChangedEvent;
  readonly 'goal.updated': GoalUpdatedEvent;
  readonly 'skill.activated': SkillActivatedEvent;
  readonly 'plugin_command.activated': PluginCommandActivatedEvent;
  readonly 'turn.started': TurnStartedEvent;
  readonly 'turn.ended': TurnEndedEvent;
  readonly 'turn.step.started': TurnStepStartedEvent;
  readonly 'turn.step.completed': TurnStepCompletedEvent;
  readonly 'turn.step.retrying': TurnStepRetryingEvent;
  readonly 'turn.step.interrupted': TurnStepInterruptedEvent;
  readonly 'assistant.delta': AssistantDeltaEvent;
  readonly 'hook.result': HookResultEvent;
  readonly 'thinking.delta': ThinkingDeltaEvent;
  readonly 'tool.call.delta': ToolCallDeltaEvent;
  readonly 'tool.call.started': ToolCallStartedEvent;
  readonly 'tool.progress': ToolProgressEvent;
  readonly 'shell.output': ShellOutputEvent;
  readonly 'shell.started': ShellStartedEvent;
  readonly 'shell.completed': ShellCompletedEvent;
  readonly 'tool.result': ToolResultEvent;
  readonly 'tool.list.updated': ToolListUpdatedEvent;
  readonly 'mcp.server.status': McpServerStatusEvent;
  readonly 'subagent.spawned': SubagentSpawnedEvent;
  readonly 'subagent.started': SubagentStartedEvent;
  readonly 'subagent.suspended': SubagentSuspendedEvent;
  readonly 'subagent.completed': SubagentCompletedEvent;
  readonly 'subagent.failed': SubagentFailedEvent;
  readonly 'compaction.started': CompactionStartedEvent;
  readonly 'compaction.blocked': CompactionBlockedEvent;
  readonly 'compaction.cancelled': CompactionCancelledEvent;
  readonly 'compaction.completed': CompactionCompletedEvent;
  readonly 'task.started': TaskStartedEvent;
  readonly 'task.terminated': TaskTerminatedEvent;
  readonly 'cron.fired': CronFiredEvent;
  readonly 'prompt.submitted': PromptSubmittedEvent;
  readonly 'prompt.completed': PromptCompletedEvent;
  readonly 'prompt.aborted': PromptAbortedEvent;
  readonly 'prompt.steered': PromptSteeredEvent;
}

// Every engine union member must appear as a map value (and nothing else) —
// a new/renamed engine event fails here instead of silently dropping out of
// the SDK's `Event`. `error` is mapped to the SDK-local `SdkErrorEvent`
// above, so the engine's own class type is unioned in for the check.
type AssertNever<T extends never> = T;
// oxlint-disable-next-line eslint/no-unused-vars -- the failing constraint IS the assertion.
type UnmappedEngineEvent = AssertNever<
  Exclude<EngineAgentEvent, EngineEventMap[keyof EngineEventMap] | ErrorEvent>
>;

/**
 * The engine hands subscribers in-process `Event2` instances (own `time`,
 * prototype `serialize`) and nests some payloads under a `payload` envelope,
 * while the SDK stream delivers plain wire objects with the envelope fields
 * flattened — drop the instance-only members and unwrap the envelope so the
 * public type matches what `receiveEvent` actually delivers on both engines.
 */
type Wire<T> = Omit<T, 'time' | 'serialize' | 'payload'> &
  (T extends { readonly payload: infer P } ? P : unknown);

type DiscriminatedEngineEvent = {
  [K in keyof EngineEventMap]: Wire<EngineEventMap[K]> & { readonly type: K };
}[keyof EngineEventMap];

type LocalWireEvent =
  | BackgroundTaskStartedEvent
  | BackgroundTaskTerminatedEvent
  | SessionStatusChangedEvent
  | SessionWorkChangedEvent;

export type Event = (DiscriminatedEngineEvent | LocalWireEvent) & {
  agentId: string;
  sessionId: string;
};

// Turn and step lifecycle events plus the turn-ending reason enum.
export type { TurnEndReason } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
export type { UsageStatus } from '@moonshot-ai/agent-core-v2/agent/usage/usage';

// Tool-call events and incremental progress payloads.
export type { ToolUpdate } from '@moonshot-ai/agent-core-v2/tool/toolContract';
export type { McpOAuthAuthorizationUrlUpdateData } from '@moonshot-ai/agent-core-v2/agent/mcp/tools/auth';
export type { ToolCallRequest, ToolCallResponse } from '#/interaction';

// MCP tool-list and server status payloads.
export type {
  ToolListUpdatedReason,
  McpServerStatusPayload,
} from '@moonshot-ai/agent-core-v2/agent/mcp/mcpEvents';

// Approval reverse-RPC request and response/display payloads.
export type {
  ApprovalRequest,
  ApprovalDecision,
  ApprovalScope,
  ApprovalResponse,
  ToolInputDisplay,
} from '#/interaction';

// Question reverse-RPC request and answer payloads.
export type {
  QuestionRequest,
  QuestionItem,
  QuestionOption,
  QuestionAnswerMethod,
  QuestionAnswers,
  QuestionResponse,
  QuestionResult,
} from '#/interaction';

export type { CompactionResult } from '@moonshot-ai/agent-core-v2/agent/fullCompaction/types';

export type MaybePromise<T> = T | Promise<T>;

export type ApprovalHandler = (request: ApprovalRequest) => MaybePromise<ApprovalResponse>;

export type QuestionHandler = (request: QuestionRequest) => MaybePromise<QuestionResult>;
