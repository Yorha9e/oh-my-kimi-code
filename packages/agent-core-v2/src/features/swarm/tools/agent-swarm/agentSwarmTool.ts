import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { Error2, ErrorCodes } from '#/errors';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ISessionSwarmService, type SessionSwarmTask } from '#/features/swarm/session/sessionSwarm';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IModelCatalog } from '#/kosong/model/catalog';
import { ILogService } from '#/_base/log/log';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  FORK_EXPERIMENTAL_UNAVAILABLE,
  FORK_WITH_RESUME_UNAVAILABLE,
  forkIncompatibility,
  type SubagentSpawnPlan,
} from '#/session/subagent/spawn';
import { SUBAGENT_FORK_FLAG_ID, SUBAGENT_MODEL_SELECTION_FLAG_ID } from '#/session/subagent/flag';
import {
  buildSubagentModelDescriptions,
  exposesSubagentModelChoice,
  resolveSubagentTimeoutMs,
  stripSubagentForkParameter,
  stripSubagentModelParameter,
  stripSubagentBindingSlotParameter,
} from '#/session/subagent/configSection';
import {
  listSlotNames,
  readWorkspaceThenGlobalSlotBinding,
  readWorkspaceThenGlobalTypeBinding,
} from '#/session/subagent/slotBinding';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  AgentSwarmToolInputSchema,
  IAgentSwarmTool,
  MAX_AGENT_SWARM_SUBAGENTS,
  PROMPT_TEMPLATE_PLACEHOLDER,
  type AgentSwarmToolInput,
} from './agent-swarm';
import AGENT_SWARM_DESCRIPTION from './agent-swarm.md?raw';
import AGENT_SWARM_FORK_DESCRIPTION from './agent-swarm-fork.md?raw';

const DEFAULT_SUBAGENT_TYPE = 'coder';

const AGENT_SWARM_PARAMETERS = toInputJsonSchema(AgentSwarmToolInputSchema);
const AGENT_SWARM_PARAMETERS_NO_MODEL = stripSubagentModelParameter(AGENT_SWARM_PARAMETERS);

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
    const bindingSlotEnabled = this.flags.enabled(SUBAGENT_MODEL_SELECTION_FLAG_ID);
    const parameters = exposesSubagentModelChoice(this.config, this.flags)
      ? bindingSlotEnabled
        ? AGENT_SWARM_PARAMETERS
        : stripSubagentBindingSlotParameter(AGENT_SWARM_PARAMETERS)
      : bindingSlotEnabled
        ? AGENT_SWARM_PARAMETERS_NO_MODEL
        : stripSubagentBindingSlotParameter(AGENT_SWARM_PARAMETERS_NO_MODEL);
    return this.flags.enabled(SUBAGENT_FORK_FLAG_ID)
      ? parameters
      : stripSubagentForkParameter(parameters);
  }

  private readonly callerAgentId: string;

  constructor(
    @ISessionSwarmService private readonly swarmService: ISessionSwarmService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentSwarmService private readonly swarmMode: IAgentSwarmService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ILogService private readonly log: ILogService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  get description(): string {
    let description = AGENT_SWARM_DESCRIPTION;
    if (this.flags.enabled(SUBAGENT_FORK_FLAG_ID)) {
      description += `\n\n${AGENT_SWARM_FORK_DESCRIPTION}`;
    }
    const modelLines = buildSubagentModelDescriptions(
      this.config,
      this.flags,
      this.profile.data().modelAlias,
      this.modelCatalog,
    );
    return modelLines === undefined ? description : `${description}\n\n${modelLines}`;
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
    const fork = args.fork === true;
    if (fork && !this.flags.enabled(SUBAGENT_FORK_FLAG_ID)) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, FORK_EXPERIMENTAL_UNAVAILABLE);
    }
    if (fork && Object.keys(args.resume_agent_ids ?? {}).length > 0) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, FORK_WITH_RESUME_UNAVAILABLE);
    }
    let plan: SubagentSpawnPlan | undefined;
    let resumeOnlyWarning: string | undefined;
    if ((args.items?.length ?? 0) > 0) {
      if (fork) {
        const incompatible = forkIncompatibility(
          { subagent_type: args.subagent_type, model: args.model },
          this.profile.data(),
        );
        if (incompatible !== undefined) {
          throw new Error2(ErrorCodes.VALIDATION_FAILED, incompatible);
        }
      }
      const profileName = normalizeOptionalString(args.subagent_type) ?? DEFAULT_SUBAGENT_TYPE;
      const bindingSlot = normalizeOptionalString(args.binding_slot);
      await this.catalog.ready;
      const targetProfile = this.catalog.get(profileName);
      if (targetProfile === undefined) {
        throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Unknown agent type: "${profileName}"`, {
          details: { profileName },
        });
      }
      const explicitModel = args.model;
      const toolSlotBinding = await this.resolveToolSlotBinding(bindingSlot, explicitModel);
      const requestedModel =
        explicitModel ?? (toolSlotBinding === undefined ? targetProfile.modelPreference : undefined);
      const slotBinding =
        toolSlotBinding?.model !== undefined
          ? undefined
          : await this.readProfileSlotBinding(targetProfile, requestedModel);
      const typeBinding =
        toolSlotBinding?.model !== undefined
          ? undefined
          : await this.readProfileTypeBinding(targetProfile, requestedModel);
      plan = await this.subagents.planSpawn({
        callerAgentId: this.callerAgentId,
        profileName,
        model: explicitModel,
        fork,
        bindingSlot,
        slotBinding,
        typeBinding,
        toolSlotBinding,
      });
    } else if (
      args.binding_slot !== undefined &&
      this.flags.enabled(SUBAGENT_MODEL_SELECTION_FLAG_ID)
    ) {
      resumeOnlyWarning =
        `warning: binding_slot "${args.binding_slot}" has no effect because this AgentSwarm call ` +
        `only resumes existing subagents without spawning new ones from items; resumed ` +
        `subagents keep their own models.`;
    }
    const profileName = plan?.profileName ?? DEFAULT_SUBAGENT_TYPE;
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
        plan: plan!,
      };
    });
    const results = await this.swarmService.run({
      callerAgentId: this.callerAgentId,
      tasks,
    });
    const rendered = renderSwarmResults(
      results.map(({ task, ...result }) => ({ spec: task.data, ...result })),
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
   * filesystem.
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
   * `binding_slot` tool argument): resolved only when no explicit model
   * choice exists and the subagent-model-selection flag is on. A missing slot
   * or a stored alias the model catalog no longer resolves raises a clear
   * tool error (listing the available slots / attributing the alias) — never
   * a silent fall-through to the caller's model. `inherit: true` or an empty
   * entry drops the level so the chain below (type binding etc.) applies.
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
    const listing =
      available.length === 0
        ? 'no [subagent-slot.*] entries are configured'
        : `available: ${available.join(', ')}`;
    return new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `Unknown binding slot "${slot}" (${listing})`,
      { details: { slot, availableSlots: available } },
    );
  }

  private slotUnknownAliasError(slot: string, model: string): Error2 {
    return new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `Binding slot "${slot}" references model "${model}", which is not configured in the model catalog`,
      { details: { slot, model } },
    );
  }
}

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
