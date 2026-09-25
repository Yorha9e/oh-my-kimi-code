import type { WarningEvent } from '#/agent/profile/profileService';
import type { ToolResultEventPayload } from '#/agent/toolExecutor/toolExecutorEvents';

export interface ToolResultEvent extends Omit<ToolResultEventPayload, 'agentId'> {
  readonly type: 'tool.result';
}

export type AgentEvent = WarningEvent | ToolResultEvent;

export type Event = AgentEvent & { agentId: string; sessionId: string };
