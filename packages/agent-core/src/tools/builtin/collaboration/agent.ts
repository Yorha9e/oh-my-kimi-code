/**
 * AgentTool — collaboration tool for spawning task subagents.
 *
 * Unlike the built-in tools (Read/Write/Edit/Bash/Grep/Glob), this is a
 * "collaboration tool". It uses `SessionSubagentHost` (injected via the
 * constructor rather than through the Runtime) to create in-process subagent
 * loop instances.
 *
 * Foreground and background subagents both run through BackgroundManager.
 * Foreground calls wait for the task to finish unless it is detached through
 * the background-task RPC.
 *
 * `ToolResult.content` is textual; the structured output exposed by
 * `AgentToolOutputSchema` is only used for drift-guard and is not consumed at
 * runtime.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type {
  AskSubagentBindingCallback,
  IsModelAliasKnownCallback,
  ReadSubagentBindingCallback,
  ReadSubagentSlotBindingCallback,
} from '../../../agent/tool/subagent-binding';
import type { Logger } from '../../../logging';
import { ToolAccesses } from '../../../loop/tool-access';
import { isAbortError } from '../../../loop/errors';
import type {
  ExecutableToolContext,
  ExecutableToolOutput,
  ExecutableToolResult,
  ToolExecution,
} from '../../../loop/types';
import type { ResolvedAgentProfile } from '../../../profile';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  formatSubagentTimeoutDescription,
  type SessionSubagentHost,
  type SubagentHandle,
} from '../../../session/subagent-host';
import { stripSubagentModelParameter } from '../../../session/subagent-binding';
import { isUserCancellation } from '../../../utils/abort';
import { AgentBackgroundTask, type BackgroundManager } from '../../../agent/background';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import AGENT_BACKGROUND_DISABLED_DESCRIPTION from './agent-background-disabled.md?raw';
import AGENT_BACKGROUND_DESCRIPTION from './agent-background-enabled.md?raw';
import AGENT_DESCRIPTION_BASE from './agent.md?raw';

// ── AgentTool input ──────────────────────────────────────────────────

export const AgentToolInputSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return input;
    }
    const record = input as Record<string, unknown>;
    const normalized = { ...record };
    const hasResumeId =
      typeof normalized['resume'] === 'string' && normalized['resume'].trim().length > 0;
    const hasSubagentType =
      typeof normalized['subagent_type'] === 'string' && normalized['subagent_type'].length > 0;
    if (!hasSubagentType && !hasResumeId) {
      normalized['subagent_type'] = 'coder';
    } else if (!hasSubagentType) {
      delete normalized['subagent_type'];
    }
    return normalized;
  },
  z.object({
    prompt: z.string().describe('Full task prompt for the subagent'),
    description: z.string().describe('Short task description (3-5 words) for UI display'),
    subagent_type: z
      .string()
      .optional()
      .describe(
        'One of the available agent types (see "Available agent types" in this tool description). Defaults to "coder" when omitted.',
      ),
    model: z
      .enum(['primary', 'secondary'])
      .optional()
      .describe(
        'Model for the new subagent: "secondary" uses the configured secondary model (the default when one is set), "primary" uses the model you are running on. Only applies when spawning a new agent — a resumed agent keeps its bound model.',
      ),
    resume: z
      .string()
      .optional()
      .describe(
        'Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected. May be combined with binding_slot to switch the resumed agent to that slot\'s model — use it to recover progress when the original model is rate-limited (429) or refused by safety policy.',
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe(
        'If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.',
      ),
    binding_slot: z
      .string()
      .optional()
      .describe(
        'Named binding slot pre-configured by the user for this workspace (.kimi-code/local.toml under [subagent-slot.<name>]). Set ONLY when the user, the task, or a preset explicitly names a slot — pass the name through verbatim. Never invent slot names. On resume, the slot overrides the resumed agent\'s model.',
      ),
  }),
);

export type AgentToolInput = z.infer<typeof AgentToolInputSchema>;

// ── AgentTool output ─────────────────────────────────────────────────

export const AgentToolOutputSchema = z.object({
  result: z.string().describe('Aggregated text output from the subagent'),
  usage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cache_read: z.number().int().nonnegative().optional(),
      cache_write: z.number().int().nonnegative().optional(),
    })
    .describe('Cumulative token usage'),
});

export type AgentToolOutput = z.infer<typeof AgentToolOutputSchema>;

const BACKGROUND_AGENT_UNAVAILABLE =
  'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.';

// ── AgentTool class ──────────────────────────────────────────────────

const AGENT_TOOL_PARAMETERS = toInputJsonSchema(AgentToolInputSchema);
const AGENT_TOOL_PARAMETERS_NO_MODEL = stripSubagentModelParameter(AGENT_TOOL_PARAMETERS);

export class AgentTool implements BuiltinTool<AgentToolInput> {
  readonly name: string = 'Agent';
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly backgroundManager: BackgroundManager,
    subagents?: ResolvedAgentProfile['subagents'] | undefined,
    options?: {
      log?: Logger;
      allowBackground?: boolean | undefined;
      subagentTimeoutMs?: number | undefined;
      modelSelectionEnabled?: boolean | (() => boolean);
      readBinding?: ReadSubagentBindingCallback;
      readSlotBinding?: ReadSubagentSlotBindingCallback;
      askBinding?: AskSubagentBindingCallback;
      isModelAliasKnown?: IsModelAliasKnownCallback;
      subagentModelDescription?: string;
      showModelPreferences?: boolean;
      // Mirrors the `secondary-model` experiment: off (the default), the
      // no-op `model` parameter is stripped from the advertised schema so the
      // secondary-model concept never enters the prompt.
      modelChoiceEnabled?: boolean;
    },
  ) {
    const log = options?.log;
    this.allowBackground = options?.allowBackground ?? true;
    // `0` is preserved (not normalized): `0 ?? DEFAULT_SUBAGENT_TIMEOUT_MS`
    // stays `0`, and the BackgroundManager arms no timer for it.
    this.subagentTimeoutMs = options?.subagentTimeoutMs;
    const modelSelectionEnabled = options?.modelSelectionEnabled ?? false;
    this.isModelSelectionEnabled =
      typeof modelSelectionEnabled === 'function'
        ? modelSelectionEnabled
        : () => modelSelectionEnabled;
    this.readBinding = options?.readBinding;
    this.readSlotBinding = options?.readSlotBinding;
    this.askBinding = options?.askBinding;
    this.isModelAliasKnown = options?.isModelAliasKnown;
    this.parameters =
      options?.modelChoiceEnabled === true
        ? AGENT_TOOL_PARAMETERS
        : AGENT_TOOL_PARAMETERS_NO_MODEL;
    const typeLines = buildSubagentDescriptions(
      subagents,
      options?.showModelPreferences ?? false,
    );
    const baseDescription = `${AGENT_DESCRIPTION_BASE}\n\n${
      this.allowBackground ? AGENT_BACKGROUND_DESCRIPTION : AGENT_BACKGROUND_DISABLED_DESCRIPTION
    }`;
    const sections = [baseDescription];
    if (typeLines) {
      sections.push(`Available agent types (pass via subagent_type):\n${typeLines}`);
    }
    if (options?.subagentModelDescription !== undefined) {
      sections.push(options.subagentModelDescription);
    }
    this.description = sections.join('\n\n');
    this.log = log;
  }

  private readonly log?: Logger;
  private readonly allowBackground: boolean;
  private readonly subagentTimeoutMs?: number;
  private readonly isModelSelectionEnabled: () => boolean;
  private readonly readBinding?: ReadSubagentBindingCallback;
  private readonly readSlotBinding?: ReadSubagentSlotBindingCallback;
  private readonly askBinding?: AskSubagentBindingCallback;
  private readonly isModelAliasKnown?: IsModelAliasKnownCallback;

  /**
   * Effective workspace binding for a run. Spawn: a requested `bindingSlot`
   * resolves first (instance-level); an unconfigured or broken slot falls
   * through to the type binding. Type bindings read the stored binding;
   * when absent, asking is enabled, and an interactive ask callback exists,
   * ask the user once and persist the answer. When a stored binding
   * references a model alias missing from the user's models config,
   * interactively re-ask (repairing the binding) or — where asking is
   * unavailable — fall back with an explicit `warning`. Resume: only a
   * requested `bindingSlot` applies, as a one-off model override for the
   * resumed run (slot override > the child's sticky config, persisted into
   * the child config); type bindings and interactive asks are spawn-only,
   * and an unconfigured or broken slot keeps the child's original model
   * with an explicit `warning`. Returns `undefined` when the experiment is
   * disabled or when no binding applies (plain inheritance / plain sticky
   * resume).
   */
  private async resolveBinding(
    profileName: string,
    operation: 'spawn' | 'resume',
    allowAsk: boolean,
    bindingSlot?: string,
  ): Promise<
    | {
        readonly modelAlias?: string;
        readonly thinkingEffort?: string;
        readonly bindingSlot?: string;
        readonly warning?: string;
      }
    | undefined
  > {
    if (!this.isModelSelectionEnabled()) return undefined;
    if (operation === 'resume') {
      return this.resolveResumeSlotBinding(bindingSlot);
    }
    let warning: string | undefined;

    // Named binding slot requested: instance-level binding outranks the type
    // binding. An unconfigured or broken slot falls through to the type
    // chain (with a warning where asking is unavailable).
    if (bindingSlot !== undefined) {
      let slotBinding = await this.readSlotBinding?.(bindingSlot);
      if (slotBinding === undefined) {
        if (allowAsk && this.askBinding !== undefined) {
          slotBinding = await this.askBinding(profileName, { slot: bindingSlot });
        } else {
          warning =
            `warning: binding slot "${bindingSlot}" is not configured in this workspace; ` +
            `falling back to the subagent type binding. Configure it in ` +
            `.kimi-code/local.toml under [subagent-slot.${bindingSlot}].`;
        }
      } else if (
        slotBinding.inherit !== true &&
        slotBinding.model !== undefined &&
        this.isModelAliasKnown !== undefined &&
        !this.isModelAliasKnown(slotBinding.model)
      ) {
        const missingModel = slotBinding.model;
        if (allowAsk && this.askBinding !== undefined) {
          const repaired = await this.askBinding(profileName, { slot: bindingSlot, missingModel });
          if (repaired !== undefined) {
            slotBinding = repaired;
          } else {
            // Dismissed re-ask (e.g. `kimi -p` where the question channel
            // exists but is never answered): fall back with an explicit
            // warning rather than silently ignoring the broken slot.
            warning =
              `warning: binding slot "${bindingSlot}" references unknown model alias ` +
              `"${missingModel}"; falling back to the subagent type binding. Update it in ` +
              `.kimi-code/local.toml.`;
            slotBinding = undefined;
          }
        } else {
          warning =
            `warning: binding slot "${bindingSlot}" references unknown model alias ` +
            `"${missingModel}"; falling back to the subagent type binding. Update it in ` +
            `.kimi-code/local.toml.`;
          slotBinding = undefined;
        }
      }
      if (
        slotBinding !== undefined &&
        slotBinding.inherit !== true &&
        (slotBinding.model !== undefined || slotBinding.thinkingEffort !== undefined)
      ) {
        return {
          modelAlias: slotBinding.model,
          thinkingEffort: slotBinding.thinkingEffort,
          bindingSlot,
          warning,
        };
      }
    }

    let binding = await this.readBinding?.(profileName);
    if (binding === undefined) {
      if (allowAsk && this.askBinding !== undefined) {
        binding = await this.askBinding(profileName);
      }
    } else if (
      binding.inherit !== true &&
      binding.model !== undefined &&
      this.isModelAliasKnown !== undefined &&
      !this.isModelAliasKnown(binding.model)
    ) {
      const missingModel = binding.model;
      if (allowAsk && this.askBinding !== undefined) {
        const repaired = await this.askBinding(profileName, { missingModel });
        if (repaired !== undefined) {
          binding = repaired;
        } else {
          // Dismissed re-ask — including non-interactive sessions where the
          // question channel exists but can never be answered (e.g. `kimi
          // -p`). Inherit, but say so explicitly: a silently ignored broken
          // binding is worse than a warned one.
          warning =
            `warning: workspace binding for subagent type "${profileName}" references unknown ` +
            `model alias "${missingModel}"; inheriting the main agent model. Update it with ` +
            `/subagent-model set ${profileName} or in .kimi-code/local.toml.`;
          binding = undefined;
        }
      } else {
        warning =
          `warning: workspace binding for subagent type "${profileName}" references unknown ` +
          `model alias "${missingModel}"; inheriting the main agent model. Update it with ` +
          `/subagent-model set ${profileName} or in .kimi-code/local.toml.`;
        binding = undefined;
      }
    }
    if (binding === undefined || binding.inherit === true) {
      return warning === undefined ? undefined : { warning };
    }
    if (binding.model === undefined && binding.thinkingEffort === undefined) {
      return warning === undefined ? undefined : { warning };
    }
    return { modelAlias: binding.model, thinkingEffort: binding.thinkingEffort, warning };
  }

  /**
   * Binding-slot model override for a resume: recovering a subagent whose
   * model was rate-limited or refused by switching it to a slot's model.
   * Read-only — resume never asks to configure a slot, and type bindings do
   * not apply (the child keeps its sticky model). An unconfigured slot, a
   * slot without a model binding, or one referencing an unknown alias keeps
   * the child's original model and says so with an explicit `warning`.
   */
  private async resolveResumeSlotBinding(
    bindingSlot?: string,
  ): Promise<
    | {
        readonly modelAlias?: string;
        readonly thinkingEffort?: string;
        readonly bindingSlot?: string;
        readonly warning?: string;
      }
    | undefined
  > {
    if (bindingSlot === undefined) return undefined;
    const slotBinding = await this.readSlotBinding?.(bindingSlot);
    if (slotBinding === undefined) {
      return {
        warning:
          `warning: binding slot "${bindingSlot}" is not configured in this workspace; ` +
          `the resumed subagent keeps its original model. Configure it in ` +
          `.kimi-code/local.toml under [subagent-slot.${bindingSlot}].`,
      };
    }
    if (
      slotBinding.inherit === true ||
      (slotBinding.model === undefined && slotBinding.thinkingEffort === undefined)
    ) {
      return {
        warning:
          `warning: binding slot "${bindingSlot}" has no model binding; ` +
          `the resumed subagent keeps its original model. Set one with ` +
          `/subagent-model set slot ${bindingSlot} or in .kimi-code/local.toml.`,
      };
    }
    if (
      slotBinding.model !== undefined &&
      this.isModelAliasKnown !== undefined &&
      !this.isModelAliasKnown(slotBinding.model)
    ) {
      return {
        warning:
          `warning: binding slot "${bindingSlot}" references unknown model alias ` +
          `"${slotBinding.model}"; the resumed subagent keeps its original model. Update it in ` +
          `.kimi-code/local.toml.`,
      };
    }
    return {
      modelAlias: slotBinding.model,
      thinkingEffort: slotBinding.thinkingEffort,
      bindingSlot,
    };
  }

  async resolveExecution(args: AgentToolInput): Promise<ToolExecution> {
    let profileName = args.subagent_type?.length ? args.subagent_type : 'coder';
    const resumeAgentId = args.resume?.trim();
    const operation = resumeAgentId !== undefined && resumeAgentId.length > 0 ? 'resume' : 'spawn';
    if (resumeAgentId !== undefined && resumeAgentId.length > 0) {
      profileName = (await this.subagentHost.getProfileName?.(resumeAgentId)) ?? 'subagent';
    }
    // Read-only binding lookup for the approval label; the interactive
    // first-use ask happens later in execute().
    const binding = await this.resolveBinding(profileName, operation, false, args.binding_slot);
    const prefix = args.run_in_background === true ? 'Launching background' : 'Launching';
    return {
      description: `${prefix} ${profileName} agent: ${args.description}`,
      accesses: ToolAccesses.none(),
      display: {
        kind: 'agent_call',
        agent_name: subagentApprovalAgentName(profileName, binding?.modelAlias),
        prompt: args.prompt,
        background: args.run_in_background,
      },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, profileName),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: AgentToolInput,
    {
      toolCallId,
      signal,
    }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      signal.throwIfAborted();
      const runInBackground = args.run_in_background === true;
      const requestedProfileName = args.subagent_type?.length ? args.subagent_type : undefined;
      const resumeAgentId = args.resume?.trim();
      if (
        resumeAgentId !== undefined &&
        resumeAgentId.length > 0 &&
        requestedProfileName !== undefined
      ) {
        return {
          output: 'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.',
          isError: true,
        };
      }

      if (runInBackground && !this.allowBackground) {
        return {
          output: BACKGROUND_AGENT_UNAVAILABLE,
          isError: true,
        };
      }

      const controller = new AbortController();
      const abortBeforeRegister = (): void => {
        controller.abort(signal.reason);
      };
      if (!runInBackground) {
        signal.addEventListener('abort', abortBeforeRegister, { once: true });
      }

      const operation = resumeAgentId !== undefined && resumeAgentId.length > 0 ? 'resume' : 'spawn';
      // Workspace model binding (experiment-gated): applied mechanically at
      // spawn, where the first unbound spawn may ask the user once
      // interactively; on resume, a requested binding_slot acts as a one-off
      // model override over the child's sticky config (persisted into it).
      const binding = await this.resolveBinding(
        requestedProfileName ?? 'coder',
        operation,
        true,
        args.binding_slot,
      );
      const outputPrefix = [
        binding?.warning,
        binding?.bindingSlot === undefined ? undefined : `binding_slot: ${binding.bindingSlot}`,
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n');
      const withWarning = (result: ExecutableToolResult): ExecutableToolResult => {
        if (outputPrefix.length === 0) {
          return result;
        }
        const output: ExecutableToolOutput =
          typeof result.output === 'string'
            ? `${outputPrefix}\n${result.output}`
            : [{ type: 'text', text: outputPrefix }, ...result.output];
        return { ...result, output };
      };
      const runOptions = {
        parentToolCallId: toolCallId,
        prompt: args.prompt,
        description: args.description,
        modelAlias: binding?.modelAlias,
        thinkingEffort: binding?.thinkingEffort,
        runInBackground,
        signal: controller.signal,
      };
      let handle: SubagentHandle;
      try {
        handle =
          operation === 'resume'
            ? await this.subagentHost.resume(resumeAgentId!, runOptions)
            : await this.subagentHost.spawn({
                profileName: requestedProfileName ?? 'coder',
                modelChoice: args.model,
                ...runOptions,
              });
      } catch (error) {
        signal.removeEventListener('abort', abortBeforeRegister);
        this.log?.warn('subagent launch failed', {
          toolCallId,
          runInBackground,
          operation,
          agentId: resumeAgentId,
          subagentType: operation === 'spawn' ? requestedProfileName ?? 'coder' : undefined,
          error,
        });
        throw error;
      }

      let taskId: string;
      try {
        taskId = this.backgroundManager.registerTask(
          new AgentBackgroundTask(handle, args.description, this.subagentHost, controller),
          {
            detached: runInBackground,
            timeoutMs: this.subagentTimeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS,
            signal: runInBackground ? undefined : signal,
          },
        );
        signal.removeEventListener('abort', abortBeforeRegister);
      } catch (error) {
        controller.abort();
        void handle.completion.catch(() => {});
        signal.removeEventListener('abort', abortBeforeRegister);
        this.log?.warn('background agent task registration failed', {
          toolCallId,
          agentId: handle.agentId,
          subagentType: handle.profileName,
          error,
        });
        return {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }

      if (runInBackground) {
        return withWarning({
          output: formatBackgroundAgentResult(
            taskId,
            handle,
            args.description,
            this.allowBackground,
          ),
        });
      }

      const release = await this.backgroundManager.waitForForegroundRelease(taskId);
      if (release === 'detached') {
        return withWarning({
          output: formatBackgroundAgentResult(
            taskId,
            handle,
            args.description,
            this.allowBackground,
          ),
        });
      }
      return withWarning(await this.formatForegroundResult(taskId, handle));
    } catch (error) {
      return { output: `subagent error: ${launchErrorMessage(error, signal)}`, isError: true };
    }
  }

  private async formatForegroundResult(
    taskId: string,
    handle: SubagentHandle,
  ): Promise<ExecutableToolResult> {
    const info = this.backgroundManager.getTask(taskId);
    if (info?.status === 'completed') {
      return {
        output: formatForegroundAgentSuccess(
          handle,
          await this.backgroundManager.readOutput(taskId),
        ),
      };
    }
    const timedOut = info?.status === 'timed_out';
    const message =
      timedOut
        ? `Agent timed out after ${formatSubagentTimeoutDescription(this.subagentTimeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS)}.`
        : info?.stopReason === 'Interrupted by user'
          ? USER_INTERRUPTED_SUBAGENT_MESSAGE
          : info?.stopReason !== undefined
            ? info.stopReason
            : 'The subagent was stopped before it finished.';
    return {
      output: formatForegroundAgentFailure(handle, message, timedOut),
      isError: true,
    };
  }
}

const USER_INTERRUPTED_SUBAGENT_MESSAGE =
  'The user manually interrupted this subagent (and any sibling agents launched alongside it). This was a deliberate user action, not a system error, a timeout, or a capacity/concurrency limit. Do not retry automatically or speculate about why it failed — wait for the user\'s next instruction.';

function handleModelLines(handle: SubagentHandle): string[] {
  const lines: string[] = [];
  if (handle.modelAlias !== undefined) lines.push(`model: ${handle.modelAlias}`);
  if (handle.thinkingEffort !== undefined) lines.push(`thinking_effort: ${handle.thinkingEffort}`);
  return lines;
}

function formatBackgroundAgentResult(
  taskId: string,
  handle: SubagentHandle,
  description: string,
  allowBackground: boolean,
): string {
  return [
    `task_id: ${taskId}`,
    'status: running',
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    ...handleModelLines(handle),
    'automatic_notification: true',
    '',
    `description: ${description}`,
    '',
    allowBackground
      ? `next_step: The completion arrives automatically in a later turn — do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user. (If you have nothing to do until it finishes, run such tasks in the foreground next time.)`
      : 'next_step: The completion arrives automatically in a later turn.',
    `resume_hint: To continue or recover this same subagent later, call Agent(resume="${handle.agentId}", prompt="..."). The parameter is agent_id ("${handle.agentId}"), NOT task_id ("${taskId}") or source_id from a later <notification>. Recovery cases: a later <notification type="task.lost" | "task.failed" | "task.killed"> for this subagent — its conversation history is preserved across session restarts and resume will pick it up. If its model is rate-limited (429) or refused by safety policy, add binding_slot="<slot>" to resume it on that slot's model without losing context.`,
  ].join('\n');
}

function formatForegroundAgentSuccess(handle: SubagentHandle, result: string): string {
  return [
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    ...handleModelLines(handle),
    'status: completed',
    '',
    '[summary]',
    result,
  ].join('\n');
}

function formatForegroundAgentFailure(
  handle: SubagentHandle,
  message: string,
  timedOut: boolean,
): string {
  const lines = [
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    ...handleModelLines(handle),
    'status: failed',
    '',
    `subagent error: ${message}`,
  ];
  if (timedOut) {
    lines.push(
      `resume_hint: Continue with Agent(resume="${handle.agentId}", prompt="continue"). Use agent_id only; do not set subagent_type. The subagent retains its prior context; redo any unfinished tool call if its result was lost. If it was rate-limited (429) or refused by safety policy, add binding_slot="<slot>" to resume it on that slot's model.`,
    );
  }
  return lines.join('\n');
}

function launchErrorMessage(error: unknown, signal: AbortSignal): string {
  if (isUserCancellation(signal.reason)) return USER_INTERRUPTED_SUBAGENT_MESSAGE;
  if (isAbortError(error)) return 'The subagent was stopped before it finished.';
  return error instanceof Error ? error.message : String(error);
}

function buildSubagentDescriptions(
  subagents: ResolvedAgentProfile['subagents'],
  showModelPreferences: boolean,
): string {
  if (subagents === undefined) return '';
  return Object.entries(subagents)
    .map(([name, subagent]) => {
      const details = [subagent.description, subagent.whenToUse].filter(
        (part): part is string => part !== undefined && part.length > 0,
      );
      const header = details.length === 0 ? `- ${name}` : `- ${name}: ${details.join(' ')}`;
      const deniedExact = new Set(
        (subagent.disallowedTools ?? []).filter((tool) => !tool.startsWith('mcp__')),
      );
      const shownTools = subagent.tools.filter((tool) => !deniedExact.has(tool));
      const lines = [header];
      if (showModelPreferences && subagent.modelPreference !== undefined) {
        lines.push(`  Model preference: ${subagent.modelPreference}`);
      }
      if (shownTools.length > 0) lines.push(`  Tools: ${shownTools.join(', ')}`);
      if (subagent.disallowedTools !== undefined && subagent.disallowedTools.length > 0) {
        lines.push(`  Disabled: ${subagent.disallowedTools.join(', ')}`);
      }
      return lines.join('\n');
    })
    .join('\n');
}

// ── Approval-display helpers ─────────────────────────────────────────

/** Alias characters considered safe to render in the approval UI. */
const SAFE_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9._+/@:-]*$/;
const MAX_ALIAS_LENGTH = 160;

function subagentApprovalAgentName(agentName: string, modelAlias?: string): string {
  if (modelAlias === undefined) return agentName;
  const isSafe =
    modelAlias.length > 0 && modelAlias.length <= MAX_ALIAS_LENGTH && SAFE_ALIAS.test(modelAlias);
  const modelLabel = isSafe ? `model ${modelAlias}` : 'model inherited (alias hidden)';
  return `${agentName} · ${modelLabel}`;
}
