/**
 * `tools` domain — `AgentSwarmTool` implementation (the `AgentSwarm`
 * tool).
 *
 * Launches a batch of child agents (an ordinary Agent scope each) through the
 * session swarm coordinator (`ISessionSwarmService`) and renders the
 * per-subagent XML result. Reads persisted swarm item labels through the
 * Session-scoped coordinator so later `resume_agent_ids` calls relabel
 * resumed subagents like v1. When the caller has a model bound, the tool
 * resolves the explicit or target-profile model preference up front via
 * `resolveSubagentBinding` (against `IConfigService`, `IFlagService`,
 * `ISessionAgentProfileCatalog`, and the caller's `IAgentProfileService`) and
 * threads it through the swarm tasks; otherwise binding is left to the
 * service, which keeps its own "no model bound" check and inherit-caller
 * fallback — the slot name/alias itself is still validated in that case, so
 * an unconfigured slot raises a clear tool error even without a caller
 * model. A `binding_slot` tool argument (an instance-level named slot)
 * sits between the explicit choice and the profile's model preference,
 * applied to every item-spawned subagent in the batch — a missing slot or an
 * unknown alias raises a clear tool error instead of silently inheriting; a
 * resume-only batch (no items) reports the slot as a warning rather than
 * silently ignoring it, since resumed members keep their own models. A target profile
 * declaring `slot` in its frontmatter binds
 * `[subagent-slot.<slot>]` from local.toml — read once up front like the
 * model preference itself, and dropped (with a log warning) on
 * `inherit: true` or an alias the model catalog no longer resolves. The
 * advertised `model` parameter lists the secondary/primary pair via
 * `buildSubagentModelDescriptions`, suffixing each line with the entry's
 * capability flags resolved through `IModelCatalog`. Swarm mode is entered
 * through `IAgentSwarmService`; the caller's agent id comes from
 * `IAgentScopeContext`. Pure tool — owns no scoped state.
 *
 * Registered via the module-level `registerAgentToolService(IAgentSwarmTool,
 * AgentSwarmTool)` at the bottom of this file — the same "import = register"
 * pattern used by every agent tool. Bound at Agent scope.
 */

import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/kosong/model/catalog';
import { ISessionSwarmService, type SessionSwarmTask } from '#/session/swarm/sessionSwarm';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import {
  subagentAllowlistFor,
  subagentTypeNotAllowedMessage,
} from '#/app/agentProfileCatalog/profile-shared';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import {
  buildSubagentModelDescriptions,
  resolveSubagentBinding,
  resolveSubagentTimeoutMs,
  stripSubagentBindingSlotParameter,
  stripSubagentModelParameter,
  wrapSubagentModelError,
  type SubagentBinding,
} from '#/session/subagent/configSection';
import {
  SECONDARY_MODEL_FLAG_ID,
  SUBAGENT_MODEL_SELECTION_FLAG_ID,
} from '#/session/subagent/flag';
import {
  listSlotNames,
  readWorkspaceThenGlobalSlotBinding,
  readWorkspaceThenGlobalTypeBinding,
} from '#/session/subagent/slotBinding';
import { ILogService } from '#/_base/log/log';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { type AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  AgentSwarmToolInputSchema,
  IAgentSwarmTool,
  MAX_AGENT_SWARM_SUBAGENTS,
  PROMPT_TEMPLATE_PLACEHOLDER,
  type AgentSwarmToolInput,
} from './agent-swarm';
import AGENT_SWARM_DESCRIPTION from './agent-swarm.md?raw';

const DEFAULT_SUBAGENT_TYPE = 'coder';

const AGENT_SWARM_PARAMETERS = toInputJsonSchema(AgentSwarmToolInputSchema);
const AGENT_SWARM_PARAMETERS_NO_MODEL = stripSubagentModelParameter(AGENT_SWARM_PARAMETERS);
const AGENT_SWARM_PARAMETERS_NO_BINDING_SLOT = stripSubagentBindingSlotParameter(
  AGENT_SWARM_PARAMETERS,
);
const AGENT_SWARM_PARAMETERS_NO_MODEL_NO_BINDING_SLOT = stripSubagentBindingSlotParameter(
  AGENT_SWARM_PARAMETERS_NO_MODEL,
);

interface AgentSwarmSpawnSpec {
  readonly kind: 'spawn';
  readonly index: number;
  readonly item: string;
  readonly prompt: string;
}

interface AgentSwarmResumeSpec {
  readonly kind: 'resume';
  readonly index: number;
  readonly agentId: string;
  readonly item?: string;
  readonly prompt: string;
}

type AgentSwarmSpec = AgentSwarmSpawnSpec | AgentSwarmResumeSpec;

interface SwarmRunResult {
  readonly spec: AgentSwarmSpec;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly error?: string;
}

export class AgentSwarmTool implements IAgentSwarmTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'AgentSwarm' as const;

  get parameters(): Record<string, unknown> {
    const secondaryEnabled = this.flags.enabled(SECONDARY_MODEL_FLAG_ID);
    const bindingSlotEnabled = this.flags.enabled(SUBAGENT_MODEL_SELECTION_FLAG_ID);
    if (secondaryEnabled && bindingSlotEnabled) return AGENT_SWARM_PARAMETERS;
    if (secondaryEnabled) return AGENT_SWARM_PARAMETERS_NO_BINDING_SLOT;
    if (bindingSlotEnabled) return AGENT_SWARM_PARAMETERS_NO_MODEL;
    return AGENT_SWARM_PARAMETERS_NO_MODEL_NO_BINDING_SLOT;
  }

  private readonly callerAgentId: string;

  constructor(
    @ISessionSwarmService private readonly swarmService: ISessionSwarmService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentSwarmService private readonly swarmMode: IAgentSwarmService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ILogService private readonly log: ILogService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  get description(): string {
    const modelLines = buildSubagentModelDescriptions(
      this.config,
      this.flags,
      this.profile.data().modelAlias,
      this.modelCatalog,
    );
    return modelLines === undefined
      ? AGENT_SWARM_DESCRIPTION
      : `${AGENT_SWARM_DESCRIPTION}\n\n${modelLines}`;
  }

  resolveExecution(args: AgentSwarmToolInput): ToolExecution {
    const agentCount = (args.items?.length ?? 0) + Object.keys(args.resume_agent_ids ?? {}).length;
    return {
      accesses: ToolAccesses.all(),
      description: `Launching agent swarm: ${args.description}`,
      display: {
        kind: 'agent_call',
        agent_name: `swarm (${agentCount} subagents)`,
        prompt: args.description,
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: AgentSwarmToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      this.swarmMode.enter('tool');
      const result = await this.runSwarm(args, context.signal, context.toolCallId);
      return {
        output: result,
      };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private async runSwarm(
    args: AgentSwarmToolInput,
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<string> {
    const profileName = normalizeOptionalString(args.subagent_type) ?? DEFAULT_SUBAGENT_TYPE;
    const bindingSlot = normalizeOptionalString(args.binding_slot);
    let binding: SubagentBinding | undefined;
    let resumeOnlyWarning: string | undefined;
    if ((args.items?.length ?? 0) > 0) {
      await this.catalog.ready;
      const own = this.profile.data();
      const allowlist = subagentAllowlistFor(this.catalog, own);
      if (allowlist !== undefined && !allowlist.includes(profileName)) {
        throw new Error2(
          ErrorCodes.AGENT_TYPE_NOT_ALLOWED,
          subagentTypeNotAllowedMessage(profileName, allowlist),
          { details: { profileName, allowlist } },
        );
      }
      const targetProfile = this.catalog.get(profileName);
      if (targetProfile === undefined) {
        throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Unknown agent type: "${profileName}"`, {
          details: { profileName },
        });
      }
      // Slot existence/alias validation runs even when the caller has no model
      // to bind: an unconfigured slot name is a contract error ("reported as an
      // error" in the parameter description), never something to silently drop.
      const explicitModel = args.model;
      const toolSlotBinding = await this.resolveToolSlotBinding(bindingSlot, explicitModel);
      if (own.modelAlias !== undefined) {
        // The profile's modelPreference is demoted below the tool binding_slot:
        // it applies only when no explicit choice and no tool slot binding are
        // in play, so a declared preference never suppresses a tool slot. When
        // the tool slot already resolved a model, the profile-slot and per-type
        // layers below can never win — skip their local.toml reads entirely
        // (and their dangling-alias warnings along with them).
        const requestedModel =
          explicitModel ??
          (toolSlotBinding === undefined ? targetProfile.modelPreference : undefined);
        const slotBinding =
          toolSlotBinding?.model !== undefined
            ? undefined
            : await this.readProfileSlotBinding(targetProfile, requestedModel);
        const typeBinding =
          toolSlotBinding?.model !== undefined
            ? undefined
            : await this.readProfileTypeBinding(targetProfile, requestedModel);
        binding = resolveSubagentBinding(
          this.config,
          this.flags,
          { modelAlias: own.modelAlias, thinkingLevel: own.thinkingLevel },
          explicitModel,
          profileName,
          slotBinding,
          typeBinding,
          toolSlotBinding,
          targetProfile.modelPreference,
        );
      }
    } else if (
      bindingSlot !== undefined &&
      this.flags.enabled(SUBAGENT_MODEL_SELECTION_FLAG_ID)
    ) {
      // Resume-only batch: binding_slot binds item-spawned subagents only, so
      // it has no target here — say so instead of silently ignoring it.
      // Resumed members keep their own models (v1 parity), so no override.
      resumeOnlyWarning =
        `warning: binding_slot "${bindingSlot}" has no effect because this AgentSwarm call ` +
        `only resumes existing subagents without spawning new ones from items; resumed ` +
        `subagents keep their own models.`;
    }
    const timeoutMs = resolveSubagentTimeoutMs(this.config);
    const specs = await createAgentSwarmSpecs(args, (agentId) =>
      this.swarmService.getSwarmItem({ callerAgentId: this.callerAgentId, agentId }),
    );
    const tasks: SessionSwarmTask<AgentSwarmSpec>[] = specs.map((spec) => {
      const descriptionName = spec.kind === 'resume' ? 'resume' : profileName;
      const common = {
        data: spec,
        profileName: spec.kind === 'resume' ? 'subagent' : profileName,
        parentToolCallId: toolCallId,
        prompt: spec.prompt,
        description: childDescription(args.description, spec.index, descriptionName),
        swarmIndex: spec.index,
        runInBackground: false,
        swarmItem: spec.item,
        signal,
        timeout: timeoutMs,
      };
      if (spec.kind === 'resume') {
        return {
          ...common,
          kind: 'resume' as const,
          resumeAgentId: spec.agentId,
        };
      }
      return {
        ...common,
        kind: 'spawn' as const,
        binding,
      };
    });
    const results = await this.swarmService.run({
      callerAgentId: this.callerAgentId,
      tasks,
    });
    const rendered = renderSwarmResults(
      results.map(({ task, ...result }) => ({ spec: task.data as AgentSwarmSpec, ...result })),
    );
    return resumeOnlyWarning === undefined ? rendered : `${resumeOnlyWarning}\n${rendered}`;
  }

  /**
   * Stored binding for the target profile's declared slot (frontmatter
   * `slot`, `[subagent-slot.<slot>]` in local.toml) — the spawn level
   * between the per-type binding and the secondary/caller chain, with v1
   * `readProfileSlotBinding`'s skip policy: a missing binding, an explicit
   * `inherit: true`, or a stored alias the model catalog no longer resolves
   * drops the whole level (the last with a log warning). Only read when no
   * explicit model choice exists — an explicit choice never touches the
   * filesystem. Read once up front, like the model preference itself.
   */
  private async readProfileSlotBinding(
    profile: AgentProfile,
    requestedModel: string | undefined,
  ): Promise<{ readonly model?: string; readonly thinking?: string } | undefined> {
    if (requestedModel !== undefined || profile.slot === undefined) return undefined;
    const binding = await readWorkspaceThenGlobalSlotBinding(this.workspace.workDir, profile.slot);
    if (binding === undefined || binding.inherit === true) return undefined;
    if (binding.model !== undefined && !this.isModelAliasKnown(binding.model)) {
      this.log.warn('ignoring slot binding with unknown model alias', {
        slot: profile.slot,
        modelAlias: binding.model,
      });
      return undefined;
    }
    return { model: binding.model, thinking: binding.thinkingEffort };
  }

  /**
   * Stored per-type binding (`[subagent.<type>]` in local.toml, keyed by the
   * profile name) — the v1 workspace-local type layer sitting below the
   * named slot in the spawn chain, with the same skip policy as
   * `readProfileSlotBinding`: a missing binding, an explicit `inherit:
   * true`, or a stored alias the model catalog no longer resolves drops the
   * whole level (the last with a log warning). Only read when no explicit
   * model choice exists — an explicit choice never touches the filesystem.
   */
  private async readProfileTypeBinding(
    profile: AgentProfile,
    requestedModel: string | undefined,
  ): Promise<{ readonly model?: string; readonly thinking?: string } | undefined> {
    if (requestedModel !== undefined) return undefined;
    const binding = await readWorkspaceThenGlobalTypeBinding(this.workspace.workDir, profile.name);
    if (binding === undefined || binding.inherit === true) return undefined;
    if (binding.model !== undefined && !this.isModelAliasKnown(binding.model)) {
      this.log.warn('ignoring per-type binding with unknown model alias', {
        type: profile.name,
        modelAlias: binding.model,
      });
      return undefined;
    }
    return { model: binding.model, thinking: binding.thinkingEffort };
  }

  private isModelAliasKnown(model: string): boolean {
    try {
      this.modelCatalog.get(model);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Tool-level binding_slot (an instance-level named slot passed through the
   * `binding_slot` tool argument): resolved once per batch when no explicit
   * model choice exists and the subagent-model-selection flag is on. A
   * missing slot or a stored alias the model catalog no longer resolves
   * raises a clear tool error (listing the available slots / attributing the
   * alias) — never a silent fall-through to the caller's model. `inherit:
   * true` or an empty entry drops the level so the chain below applies.
   */
  private async resolveToolSlotBinding(
    bindingSlot: string | undefined,
    explicitModel: string | undefined,
  ): Promise<{ readonly model?: string; readonly thinking?: string } | undefined> {
    if (bindingSlot === undefined || explicitModel !== undefined) return undefined;
    if (!this.flags.enabled(SUBAGENT_MODEL_SELECTION_FLAG_ID)) return undefined;
    const binding = await readWorkspaceThenGlobalSlotBinding(this.workspace.workDir, bindingSlot);
    if (binding === undefined) {
      throw await this.slotNotConfiguredError(bindingSlot);
    }
    if (binding.inherit === true) return undefined;
    if (binding.model === undefined && binding.thinkingEffort === undefined) return undefined;
    if (binding.model !== undefined && !this.isModelAliasKnown(binding.model)) {
      throw this.slotUnknownAliasError(bindingSlot, binding.model);
    }
    return { model: binding.model, thinking: binding.thinkingEffort };
  }

  private async slotNotConfiguredError(slot: string): Promise<Error2> {
    const available = await listSlotNames(this.workspace.workDir);
    const availableText =
      available.length === 0
        ? 'none configured'
        : available
            .map((entry) => (entry.source === 'global' ? `${entry.name} (global)` : entry.name))
            .join(', ');
    return new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Binding slot "${slot}" is not configured. Available slots: ${availableText}. ` +
        `Configure it in .kimi-code/local.toml under [subagent-slot.${slot}].`,
      { details: { slot, available: available.map((entry) => entry.name) } },
    );
  }

  private slotUnknownAliasError(slot: string, model: string): Error2 {
    const cause = new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Model "${model}" is not configured in config.toml.`,
      { details: { model } },
    );
    const wrapped = wrapSubagentModelError(
      cause,
      model,
      this.profile.data().modelAlias,
      'slot',
      undefined,
      slot,
    );
    return isError2(wrapped) ? wrapped : cause;
  }
}

registerAgentToolService(IAgentSwarmTool, AgentSwarmTool, { name: 'AgentSwarm', domain: 'swarm' });

async function createAgentSwarmSpecs(
  args: AgentSwarmToolInput,
  getResumeItem: (agentId: string) => Promise<string | undefined>,
): Promise<AgentSwarmSpec[]> {
  const resumeEntries = Object.entries(args.resume_agent_ids ?? {}).map(([agentId, prompt]) => ({
    agentId: agentId.trim(),
    prompt: prompt.trim(),
  }));
  const items = (args.items ?? []).map((item) => item.trim());
  const itemCount = items.length;
  const resumeCount = resumeEntries.length;
  const totalCount = resumeCount + itemCount;
  if (!hasMinimumAgentSwarmInputs(itemCount, resumeCount)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      'AgentSwarm requires at least 2 items unless resume_agent_ids is provided.',
    );
  }
  if (totalCount > MAX_AGENT_SWARM_SUBAGENTS) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `AgentSwarm supports at most ${String(MAX_AGENT_SWARM_SUBAGENTS)} subagents.`,
      { details: { total: totalCount, max: MAX_AGENT_SWARM_SUBAGENTS } },
    );
  }
  const promptTemplate = normalizeOptionalString(args.prompt_template);
  if (items.length > 0 && promptTemplate === undefined) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      'prompt_template is required when items are provided.',
    );
  }
  if (promptTemplate !== undefined && !promptTemplate.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `prompt_template must include the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.`,
      { details: { placeholder: PROMPT_TEMPLATE_PLACEHOLDER } },
    );
  }

  const seenPrompts = new Map<string, number>();
  const specs: AgentSwarmSpec[] = [];
  for (const entry of resumeEntries) {
    specs.push({
      kind: 'resume',
      index: specs.length + 1,
      agentId: entry.agentId,
      item: await getResumeItem(entry.agentId),
      prompt: entry.prompt,
    });
  }
  if (items.length > 0) {
    const itemPromptTemplate = promptTemplate!;
    items.forEach((item, index) => {
      const prompt = itemPromptTemplate.split(PROMPT_TEMPLATE_PLACEHOLDER).join(item);
      const previousIndex = seenPrompts.get(prompt);
      if (previousIndex !== undefined) {
        throw new Error2(
          ErrorCodes.VALIDATION_FAILED,
          `Duplicate subagent prompts from items ${String(previousIndex)} and ${String(index + 1)}. AgentSwarm requires distinct subagents.`,
          { details: { previousIndex, index: index + 1 } },
        );
      }
      seenPrompts.set(prompt, index + 1);
      specs.push({
        kind: 'spawn',
        index: specs.length + 1,
        item,
        prompt,
      });
    });
  }
  return specs;
}

function hasMinimumAgentSwarmInputs(itemCount: number, resumeCount: number): boolean {
  return resumeCount > 0 || itemCount >= 2;
}

function childDescription(swarmDescription: string, index: number, profileName: string): string {
  return `${swarmDescription} #${String(index)} (${profileName})`;
}

function renderSwarmResults(results: readonly SwarmRunResult[]): string {
  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const aborted = results.filter((result) => result.status === 'aborted').length;
  const shouldRenderResumeHint =
    results.some((result) => result.status !== 'completed') &&
    results.some((result) => result.agentId !== undefined);
  const lines = [
    '<agent_swarm_result>',
    `<summary>${renderSwarmSummary(completed, failed, aborted)}</summary>`,
  ];

  if (shouldRenderResumeHint) {
    lines.push(
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
    );
  }

  for (const result of results) {
    const agentId = result.agentId === undefined ? '' : ` agent_id="${result.agentId}"`;
    const mode = result.spec.kind === 'resume' ? ' mode="resume"' : '';
    const item = result.spec.item === undefined ? '' : ` item="${escapeXmlAttribute(result.spec.item)}"`;
    const state = result.state === undefined ? '' : ` state="${result.state}"`;
    const body = result.status === 'completed' ? (result.result ?? '') : (result.error ?? 'unknown error');
    lines.push(
      `<subagent${mode}${agentId}${item}${state} outcome="${result.status}">${body}</subagent>`,
    );
  }

  lines.push('</agent_swarm_result>');
  return lines.join('\n');
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function renderSwarmSummary(completed: number, failed: number, aborted = 0): string {
  const parts: string[] = [];
  if (completed > 0) parts.push(`completed: ${String(completed)}`);
  if (failed > 0) parts.push(`failed: ${String(failed)}`);
  if (aborted > 0) parts.push(`aborted: ${String(aborted)}`);
  return parts.join(', ');
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
