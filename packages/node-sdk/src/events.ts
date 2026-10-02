import type { AgentEvent } from '@moonshot-ai/agent-core-v2/events';

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
 * (`KimiErrorCode` from `#/errors`) — a different registry from the engine's
 * `ErrorCode` (the SDK holds ten `session.*` codes the engine registry
 * lacks), so the public `Event` substitutes this member for the engine's
 * `ErrorEvent` via the `Exclude` below and consumers keep the field types
 * the pre-rewrite surface exposed.
 */
interface SdkErrorEvent {
  readonly type: 'error';
  readonly code: KimiErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
}

type EngineWireEvent = Exclude<AgentEvent, { readonly type: 'error' }> | SdkErrorEvent;

type LocalWireEvent =
  | BackgroundTaskStartedEvent
  | BackgroundTaskTerminatedEvent
  | SessionStatusChangedEvent
  | SessionWorkChangedEvent;

type AssertNever<T extends never> = T;
// oxlint-disable-next-line eslint/no-unused-vars -- the failing constraint IS the assertion.
type OverlappingLocalWireEvent = AssertNever<Extract<LocalWireEvent, AgentEvent>>;

/**
 * What the SDK stream actually delivers: the v2 engine's wire union (its
 * `error` member swapped for {@link SdkErrorEvent} to keep the public
 * error-code width) plus the SDK-local v1-edge spellings, stamped with the
 * stream's `agentId` / `sessionId`.
 */
export type Event = (EngineWireEvent | LocalWireEvent) & {
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
