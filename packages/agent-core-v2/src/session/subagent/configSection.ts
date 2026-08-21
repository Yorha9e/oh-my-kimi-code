/**
 * `subagent` domain — subagent config-section schema, env binding, and
 * timeout / model resolution.
 *
 * Owns the `[subagent]` configuration section (`timeout_ms` on disk) together
 * with the `KIMI_SUBAGENT_TIMEOUT_MS` env override (precedence: env >
 * config.toml > 2h default; `0` means no timeout). While
 * the env var is set, `stripEnvBoundFields` restores the env-free raw value
 * before persistence, so the override never leaks into `config.toml`. Per-run
 * timeouts resolve through `resolveSubagentTimeoutMs`, and the timeout
 * message renders with `formatSubagentTimeoutDescription`.
 *
 * The model half of the spawn binding is the secondary model pool (the
 * `[secondary_model]` section on disk): when its experiment is enabled, newly
 * spawned subagents bind to the pool's `default_model` (or a pool alias picked
 * per spawn via the Agent/AgentSwarm `model` parameter) instead of inheriting
 * the caller's model. `force = true` removes the choice entirely. Without a
 * pool, spawning behavior is unchanged (subagents inherit the caller's model).
 *
 * OMKC extension — three more binding levels slot into the chain between the
 * `[agent_types]` and secondary layers, both read from local.toml by the
 * `slotBinding` module and passed into `resolveSubagentBinding` as pure data
 * (the caller drops the level on `inherit: true` or an unknown alias before
 * it ever reaches the resolver): first the named slot — a profile declaring
 * `slot` in its frontmatter binds `[subagent-slot.<slot>]` with
 * `source: 'slot'`, and a slot setting only `thinking_effort` keeps the model
 * on the chain below while the slot's thinking level wins; then the v1
 * per-type layer — `[subagent.<type>]` from the same files (workspace first,
 * global fallback) with `source: 'local_type'`, sitting below the named slot
 * exactly like v1's `workspace slot > workspace type` order. The full chain is
 * explicit choice > tool binding_slot > profile modelPreference >
 * [agent_types] > slot > local type > secondary pool > caller, where the tool
 * binding_slot is an instance-level named slot passed through the Agent /
 * AgentSwarm tool args (`binding_slot`) that outranks the type binding like
 * v1's instance-level slot, and the profile's `model_preference` frontmatter
 * resolves like an explicit choice but sits below the tool slot (a tool slot
 * must not be suppressed by a declared preference). Spawn reporting reads the
 * display-facing alias from `subagentDisplayModel`. Self-registered at module
 * load via `registerConfigSection`.
 */

import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import { isPlainObject } from '#/app/config/toml';
import type { IFlagService } from '#/app/flag/flag';
import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import {
  camelToSnake,
  cloneRecord,
  setDefined,
  transformPlainObject,
} from '#/app/config/toml';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { IModelCatalog } from '#/kosong/model/catalog';
import type { ModelOverride } from '#/kosong/model/model';
import { ModelOverrideSchema } from '#/app/kosongConfig/configSection';

import { SECONDARY_MODEL_FLAG_ID } from './flag';

export const SUBAGENT_SECTION = 'subagent';
export const SECONDARY_MODEL_SECTION = 'secondaryModel';

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
});

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

export const SecondaryModelConfigSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  models: z.record(z.string(), z.string()).optional(),
  force: z.boolean().optional(),
  model: z.string().min(1).optional(),
  maxContextSize: z.number().int().min(1).optional(),
  maxInputSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  offEffort: z.string().optional(),
});

export type SecondaryModelConfig = z.infer<typeof SecondaryModelConfigSchema>;

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const SUBAGENT_TIMEOUT_ENV = 'KIMI_SUBAGENT_TIMEOUT_MS';

function parseTimeoutMsEnv(raw: string): number | undefined {
  // Empty / whitespace-only values count as unset (v1 parity:
  // `Number('') === 0` would otherwise arm the no-timeout timer).
  if (raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  // `0` means no timeout (v1 parity): the value arms no per-task timer.
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export const subagentEnvBindings: EnvBindings<SubagentConfig> = envBindings(
  SubagentConfigSchema,
  {
    timeoutMs: { env: SUBAGENT_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
  },
);

export const stripSubagentEnv = stripEnvBoundFields(subagentEnvBindings);

registerConfigSection(SUBAGENT_SECTION, SubagentConfigSchema, {
  defaultValue: { timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS },
  env: subagentEnvBindings,
  stripEnv: stripSubagentEnv,
});

// `agentTypes` - per-type subagent model binding ([agent_types.<type>] on
// disk): `model` (a [models] entry id), `thinking` (a binding-layer effort
// level), and any `ModelOverride` field as a patch. resolveSubagentBinding
// checks the per-type entry before the secondary model and the caller's model
// when no explicit choice is made; patch-bearing entries bind a synthesized
// derived entry (`__agent_type_<type>__`) via `agentTypesOverlay`. Record keys
// are user-defined type names preserved verbatim through the toml transforms.
export const AGENT_TYPES_SECTION = 'agentTypes';

export const AgentTypeBindingSchema = ModelOverrideSchema.extend({
  model: z.string().min(1).optional(),
  thinking: z.string().optional(), // binding-layer thinking, not a ModelOverride field
});

export type AgentTypeBinding = z.infer<typeof AgentTypeBindingSchema>;

export const AgentTypesConfigSchema = z.record(z.string(), AgentTypeBindingSchema);

export type AgentTypesConfig = z.infer<typeof AgentTypesConfigSchema>;

// Derived-id convention for per-type patch entries: `__agent_type_<type>__`.
// The id is reserved (never user-configured on disk); `agentTypesOverlay`
// synthesizes it into the effective `models` view and strips it on write.
export const AGENT_TYPE_DERIVED_PREFIX = '__agent_type_';
export const AGENT_TYPE_DERIVED_SUFFIX = '__';

export function agentTypeDerivedModelId(type: string): string {
  return `${AGENT_TYPE_DERIVED_PREFIX}${type}${AGENT_TYPE_DERIVED_SUFFIX}`;
}

export function isAgentTypeDerivedModelId(id: string): boolean {
  return (
    id.startsWith(AGENT_TYPE_DERIVED_PREFIX) && id.endsWith(AGENT_TYPE_DERIVED_SUFFIX)
  );
}

/** Inverse of {@link agentTypeDerivedModelId}: the type name behind a derived id. */
export function agentTypeFromDerivedModelId(id: string): string | undefined {
  if (!isAgentTypeDerivedModelId(id)) return undefined;
  return id.slice(AGENT_TYPE_DERIVED_PREFIX.length, -AGENT_TYPE_DERIVED_SUFFIX.length);
}

// The patch half of a per-type binding (every field except `model` /
// `thinking`); undefined when no patch field is set.
export function agentTypePatch(
  binding: AgentTypeBinding | undefined,
): ModelOverride | undefined {
  if (binding === undefined) return undefined;
  const { model: _model, thinking: _thinking, ...patch } = binding;
  return Object.keys(patch).length > 0 ? (patch as ModelOverride) : undefined;
}

// Preserve record keys (subagent type names) while converting each entry's
// inner field names via the standard snake→camel transform.
export const agentTypesFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const out: Record<string, unknown> = {};
  for (const [typeName, entry] of Object.entries(rawSnake)) {
    out[typeName] = isPlainObject(entry) ? transformPlainObject(entry) : entry;
  }
  return out;
};

// Preserve record keys while converting each entry's inner field names back
// to snake_case, merging over the raw on-disk sub-record to preserve unknown
// keys through a round-trip.
export const agentTypesToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const rawSub = cloneRecord(rawSnake);
  const out: Record<string, unknown> = {};
  for (const [typeName, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      out[typeName] = entry;
      continue;
    }
    const merged = cloneRecord(rawSub[typeName]);
    for (const [key, field] of Object.entries(entry)) {
      setDefined(merged, camelToSnake(key), field);
    }
    out[typeName] = merged;
  }
  return out;
};

registerConfigSection(AGENT_TYPES_SECTION, AgentTypesConfigSchema, {
  defaultValue: {},
  fromToml: agentTypesFromToml,
  toToml: agentTypesToToml,
});

registerConfigSection(SECONDARY_MODEL_SECTION, SecondaryModelConfigSchema);

export function resolveSubagentTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.timeoutMs ??
    DEFAULT_SUBAGENT_TIMEOUT_MS
  );
}

export const PRIMARY_SUBAGENT_MODEL_CHOICE = 'primary';

export interface SubagentModelPool {
  readonly defaultModel?: string;
  readonly models: Record<string, string>;
}

export function resolveSubagentModelPool(config: IConfigService): SubagentModelPool | undefined {
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  if (section?.models !== undefined) {
    return { defaultModel: section.defaultModel, models: section.models };
  }
  if (section?.defaultModel !== undefined) {
    return { defaultModel: section.defaultModel, models: { [section.defaultModel]: '' } };
  }
  if (section?.model !== undefined) {
    return { defaultModel: section.model, models: { [section.model]: '' } };
  }
  return undefined;
}

export const SECONDARY_MODEL_FORCE_REQUIRES_DEFAULT_MESSAGE =
  '[secondary_model].default_model is required when [secondary_model].force is set';

export const SECONDARY_MODEL_FORCE_EXCLUDES_MODELS_MESSAGE =
  '[secondary_model].force cannot be combined with [secondary_model].models: the pool table only exists to offer the main agent a choice, and force removes that choice';

export function isSubagentModelForced(config: IConfigService): boolean {
  return config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION)?.force === true;
}

export function exposesSubagentModelChoice(config: IConfigService, flags: IFlagService): boolean {
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) return false;
  if (isSubagentModelForced(config)) return false;
  return resolveSubagentModelPool(config) !== undefined;
}

export const SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE =
  '[secondary_model].default_model is required when [secondary_model].models is configured';

export const SECONDARY_MODEL_PRIMARY_MODEL_RESERVED_MESSAGE = `[secondary_model.models] key "${PRIMARY_SUBAGENT_MODEL_CHOICE}" is reserved: it always binds the caller's own model. Rename the pool entry.`;

export function assertValidSubagentModelPool(
  pool: SubagentModelPool,
  modelCatalog: IModelCatalog,
): void {
  if (Object.hasOwn(pool.models, PRIMARY_SUBAGENT_MODEL_CHOICE)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_PRIMARY_MODEL_RESERVED_MESSAGE, {
      details: {
        section: SECONDARY_MODEL_SECTION,
        field: 'models',
        model: PRIMARY_SUBAGENT_MODEL_CHOICE,
      },
    });
  }
  const aliases = Object.keys(pool.models);
  if (pool.defaultModel === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE, {
      details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
    });
  }
  if (!Object.hasOwn(pool.models, pool.defaultModel)) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `[secondary_model].default_model "${pool.defaultModel}" is not a [secondary_model.models] key. Available models: ${aliases.join(', ')}.`,
      { details: { model: pool.defaultModel, availableModels: aliases } },
    );
  }
  for (const alias of aliases) {
    try {
      modelCatalog.get(alias);
    } catch (error) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `[secondary_model.models] entry "${alias}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, details: { model: alias } },
      );
    }
  }
}

export function assertValidSubagentModelConfig(
  config: IConfigService,
  flags: IFlagService,
  modelCatalog: IModelCatalog,
): void {
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) return;
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  if (section?.force === true) {
    if (section.models !== undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_EXCLUDES_MODELS_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'force' },
      });
    }
    if (section.defaultModel === undefined && section.model === undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_REQUIRES_DEFAULT_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
      });
    }
  }
  const pool = resolveSubagentModelPool(config);
  if (pool !== undefined) assertValidSubagentModelPool(pool, modelCatalog);
}

export function cascadeSubagentModelPool(
  section: SecondaryModelConfig | undefined,
  survivingModels: Record<string, unknown>,
  renamedAliases: ReadonlyMap<string, string> = new Map(),
): SecondaryModelConfig | null | undefined {
  if (section === undefined) return undefined;
  const remap = (alias: string): string => renamedAliases.get(alias) ?? alias;
  const nextDefault = section.defaultModel === undefined ? undefined : remap(section.defaultModel);
  const nextLegacyDefault = section.model === undefined ? undefined : remap(section.model);
  const effectiveDefault = nextDefault ?? nextLegacyDefault;
  if (effectiveDefault !== undefined && !(effectiveDefault in survivingModels)) return null;

  let changed = nextDefault !== section.defaultModel || nextLegacyDefault !== section.model;
  let nextPool: Record<string, string> | undefined;
  if (section.models !== undefined) {
    nextPool = {};
    for (const [alias, description] of Object.entries(section.models)) {
      const key = remap(alias);
      if (!(key in survivingModels)) {
        changed = true;
        continue;
      }
      if (key !== alias) changed = true;
      nextPool[key] = description;
    }
    if (Object.keys(nextPool).length === 0) {
      nextPool = undefined;
      changed = true;
    }
  }
  if (!changed) return undefined;
  return { ...section, defaultModel: nextDefault, model: nextLegacyDefault, models: nextPool };
}
export type SubagentModelChoice = AgentModelPreference;

/** 'primary' | 'secondary' — symbolic model preferences for subagent spawns. */
export type AgentModelPreference = 'primary' | 'secondary';

/** Where a resolved subagent model binding came from. */
export type SubagentBindingSource = 'agent_types' | 'slot' | 'local_type' | 'secondary' | 'own';

/** A resolved subagent model binding, with provenance for error attribution. */
export interface SubagentBinding {
  readonly model: string;
  readonly thinking?: string;
  readonly displayModel: string;
  readonly source?: SubagentBindingSource;
}

export function resolveSubagentBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: SubagentModelChoice,
  profileType?: string,
  slotBinding?: { readonly model?: string; readonly thinking?: string },
  typeBinding?: { readonly model?: string; readonly thinking?: string },
  toolSlotBinding?: { readonly model?: string; readonly thinking?: string },
  modelPreference?: SubagentModelChoice,
): SubagentBinding {
  // Explicit 'primary': always the caller's model, skipping all config.
  if (requested === 'primary') {
    return {
      model: own.modelAlias,
      thinking: own.thinkingLevel,
      displayModel: subagentDisplayModel(config, own.modelAlias),
      source: 'own',
    };
  }

  // Tool-level binding_slot (an instance-level named slot passed through the
  // Agent / AgentSwarm tool args): sits between an explicit model choice and
  // the profile model preference, mirroring v1's "instance-level slot outranks
  // the type binding" order. The caller digested the slot — a missing slot or
  // an unknown alias already raised a tool error, and `inherit: true` / an
  // empty entry dropped the level — so a `model` here is authoritative.
  if (requested === undefined && toolSlotBinding?.model !== undefined) {
    return {
      model: toolSlotBinding.model,
      thinking: toolSlotBinding.thinking,
      displayModel: subagentDisplayModel(config, toolSlotBinding.model),
      source: 'slot',
    };
  }

  // Tool-level slot with thinking only: the model keeps resolving down the
  // chain (model preference → agent_types → profile slot → local type →
  // secondary → own) while the slot's thinking wins — the same
  // independent-thinking rule the profile slot follows below.
  if (
    requested === undefined &&
    toolSlotBinding?.model === undefined &&
    toolSlotBinding?.thinking !== undefined
  ) {
    const fallback = resolveSubagentBinding(
      config,
      flags,
      own,
      undefined,
      profileType,
      slotBinding,
      typeBinding,
      undefined,
      modelPreference,
    );
    return {
      model: fallback.model,
      thinking: toolSlotBinding.thinking,
      displayModel: fallback.displayModel,
      source: fallback.source,
    };
  }

  // Profile model preference (`model_preference` in the agent profile's
  // frontmatter): resolves like the explicit tool choice ('primary' → the
  // caller's model, 'secondary' → the secondary model) but sits BELOW the tool
  // binding_slot and ABOVE the [agent_types] layer — a tool slot must not be
  // silently suppressed just because the profile declares a preference.
  if (requested === undefined && modelPreference !== undefined) {
    if (modelPreference === 'primary') {
      return {
        model: own.modelAlias,
        thinking: own.thinkingLevel,
        displayModel: subagentDisplayModel(config, own.modelAlias),
        source: 'own',
      };
    }
    return resolveSecondaryOrOwn(config, flags, own);
  }

  // No explicit choice: check the per-type binding first.
  if (requested === undefined && profileType !== undefined) {
    const agentTypes = config.get<AgentTypesConfig | undefined>(AGENT_TYPES_SECTION);
    const perType = agentTypes?.[profileType];
    if (perType?.model !== undefined) {
      const patch = agentTypePatch(perType);
      // A patch-bearing entry binds the synthesized derived entry
      // (`__agent_type_<type>__`); a pointer-only entry binds the pointed
      // entry directly - identical to the pre-patch behavior. The binding-
      // layer `thinking` always wins over a patch `default_effort`: it is
      // the explicit spawn-time level, while `default_effort` only affects
      // the derived entry's natural-resolution fallback.
      //
      // Mirror `agentTypesOverlay`'s chain guard: the overlay refuses to
      // synthesize a derived entry whose base is itself a derived id, so a
      // patch-bearing entry pointing at `__agent_type_*__` binds the pointed
      // (already-derived) entry directly instead of producing a dangling id.
      const synthesize = patch !== undefined && !isAgentTypeDerivedModelId(perType.model);
      return {
        model: synthesize ? agentTypeDerivedModelId(profileType) : perType.model,
        thinking: perType.thinking,
        // The derived `__agent_type_<type>__` id means nothing to a user;
        // report the entry's base alias, mirroring `subagentDisplayModel`.
        displayModel: subagentDisplayModel(config, perType.model),
        source: 'agent_types',
      };
    }
  }

  // No explicit choice: the profile's declared slot
  // (`[subagent-slot.<slot>]` in local.toml, read by the `slotBinding`
  // module). The caller passes digested data — `inherit: true` or an
  // unknown alias already dropped the whole level.
  if (requested === undefined && slotBinding?.model !== undefined) {
    return {
      model: slotBinding.model,
      thinking: slotBinding.thinking,
      displayModel: subagentDisplayModel(config, slotBinding.model),
      source: 'slot',
    };
  }

  // Slot with thinking only: the model keeps resolving down the chain
  // (local type → secondary → own) while the slot's thinking level wins,
  // with `source` tracking the model's actual layer — mirroring v1's
  // independent thinking chain.
  if (
    requested === undefined &&
    slotBinding?.model === undefined &&
    slotBinding?.thinking !== undefined
  ) {
    const fallback = resolveSubagentBinding(
      config,
      flags,
      own,
      undefined,
      undefined,
      undefined,
      typeBinding,
    );
    return {
      model: fallback.model,
      thinking: slotBinding.thinking,
      displayModel: fallback.displayModel,
      source: fallback.source,
    };
  }

  // No explicit choice: the v1 per-type layer (`[subagent.<type>]` in the
  // same local.toml files, workspace first with a global fallback), sitting
  // below the named slot exactly like v1's `workspace slot > workspace
  // type` order. Same digested-data contract as the slot ring.
  if (requested === undefined && typeBinding?.model !== undefined) {
    return {
      model: typeBinding.model,
      thinking: typeBinding.thinking,
      displayModel: subagentDisplayModel(config, typeBinding.model),
      source: 'local_type',
    };
  }

  // Local type with thinking only: the model keeps resolving down the chain
  // (secondary → own) while the type's thinking level wins — mirroring the
  // slot's independent-thinking rule, exactly like v1's per-type layer.
  if (
    requested === undefined &&
    typeBinding?.model === undefined &&
    typeBinding?.thinking !== undefined
  ) {
    const fallback = resolveSubagentBinding(config, flags, own, undefined, undefined, undefined);
    return {
      model: fallback.model,
      thinking: typeBinding.thinking,
      displayModel: fallback.displayModel,
      source: fallback.source,
    };
  }

  // Explicit non-primary alias or undefined fallback: the secondary model
  // pool (official semantics — force short-circuits, default_model binds).
  return resolveSecondaryOrOwn(config, flags, own);
}

function resolveSecondaryOrOwn(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
): SubagentBinding {
  const enabled = flags.enabled(SECONDARY_MODEL_FLAG_ID);
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  if (enabled && section?.force === true) {
    if (section.models !== undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_EXCLUDES_MODELS_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'force' },
      });
    }
    const forcedModel = section.defaultModel ?? section.model;
    if (forcedModel === undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_REQUIRES_DEFAULT_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
      });
    }
    return {
      model: forcedModel,
      displayModel: subagentDisplayModel(config, forcedModel),
      source: 'secondary',
    };
  }
  const pool = enabled ? resolveSubagentModelPool(config) : undefined;
  if (pool === undefined) {
    return {
      model: own.modelAlias,
      thinking: own.thinkingLevel,
      displayModel: subagentDisplayModel(config, own.modelAlias),
      source: 'own',
    };
  }
  const choice = pool.defaultModel;
  if (choice === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE, {
      details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
    });
  }
  if (!Object.hasOwn(pool.models, choice)) {
    const available = [...Object.keys(pool.models), PRIMARY_SUBAGENT_MODEL_CHOICE];
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Invalid model "${choice}". Available models: ${available.join(', ')}.`,
      { details: { model: choice, availableModels: available } },
    );
  }
  return {
    model: choice,
    displayModel: subagentDisplayModel(config, choice),
    source: 'secondary',
  };
}

export function subagentDisplayModel(
  config: IConfigService,
  boundAlias: string,
): string {
  return boundAlias;
}

/**
 * Display-facing alias for a resolved subagent binding, resolving the
 * per-type derived id (`__agent_type_<type>__`) back to its base alias
 * (`[agent_types.<type>].model`) before deferring to `subagentDisplayModel`
 * for the secondary convention. OMKC extension: the per-type binding layer's
 * derived-id convention is unknown to the official resolver, so spawn
 * reporting on this path resolves it flag-independently, exactly like
 * `subagentDisplayModel` does for `SECONDARY_DERIVED_MODEL_ID`.
 */
export function subagentBindingDisplayModel(
  config: IConfigService,
  boundAlias: string,
): string {
  const agentType = agentTypeFromDerivedModelId(boundAlias);
  if (agentType !== undefined) {
    const perType = config.get<AgentTypesConfig | undefined>(AGENT_TYPES_SECTION)?.[agentType];
    if (perType?.model !== undefined) return perType.model;
  }
  return subagentDisplayModel(config, boundAlias);
}

export function buildSubagentModelDescriptions(
  config: IConfigService,
  flags: IFlagService,
  callerModelAlias: string | undefined,
  modelCatalog: IModelCatalog,
): string | undefined {
  if (!exposesSubagentModelChoice(config, flags)) return undefined;
  if (callerModelAlias === undefined) return undefined;
  const pool = resolveSubagentModelPool(config)!;
  const lines = ['Available models (pass via model):'];
  const defaultModel = pool.defaultModel;
  const markersFor = (alias: string): string => {
    const markers: string[] = [];
    if (alias === defaultModel) markers.push('[default]');
    if (alias === callerModelAlias) markers.push('[main model]');
    const capability = resolvedCapabilities(modelCatalog, alias);
    if (capability !== undefined) {
      markers.push(`capabilities: ${advertisedCapabilityFlags(capability)}`);
    }
    return markers.length === 0 ? '' : ` ${markers.join('; ')}`;
  };
  if (defaultModel !== undefined && Object.hasOwn(pool.models, defaultModel)) {
    lines.push(
      formatPoolLine(`${defaultModel}${markersFor(defaultModel)}`, pool.models[defaultModel]!),
    );
  }
  for (const [alias, description] of Object.entries(pool.models)) {
    if (alias === defaultModel) continue;
    lines.push(formatPoolLine(`${alias}${markersFor(alias)}`, description));
  }
  const callerInPool =
    callerModelAlias !== undefined && Object.hasOwn(pool.models, callerModelAlias);
  lines.push(
    `- ${PRIMARY_SUBAGENT_MODEL_CHOICE}${callerInPool ? ` (${callerModelAlias})` : ''}: the main model you are running on, bound with your current thinking level; use it for hard, quality-sensitive subagent tasks`,
  );
  return lines.join('\n');
}

const ADVERTISED_CAPABILITY_FLAGS = [
  'image_in',
  'video_in',
  'audio_in',
  'thinking',
  'tool_use',
  'dynamically_loaded_tools',
] as const satisfies readonly (keyof ModelCapability)[];

function advertisedCapabilityFlags(capability: ModelCapability): string {
  const names = ADVERTISED_CAPABILITY_FLAGS.filter((flag) => capability[flag] === true);
  return names.length === 0 ? 'none' : names.join(', ');
}

function resolvedCapabilities(
  modelCatalog: IModelCatalog,
  model: string,
): ModelCapability | undefined {
  try {
    return modelCatalog.get(model).capabilities;
  } catch {
    return undefined;
  }
}

function formatPoolLine(label: string, description: string): string {
  return description === '' ? `- ${label}` : `- ${label}: ${description}`;
}

export function stripSubagentModelParameter(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters['properties'];
  if (!isPlainObject(properties) || !('model' in properties)) return parameters;
  const nextProperties = { ...properties };
  delete nextProperties['model'];
  const next: Record<string, unknown> = { ...parameters, properties: nextProperties };
  const required = parameters['required'];
  if (Array.isArray(required) && required.includes('model')) {
    next['required'] = required.filter((entry) => entry !== 'model');
  }
  return next;
}

export function stripSubagentBindingSlotParameter(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters['properties'];
  if (!isPlainObject(properties) || !('binding_slot' in properties)) return parameters;
  const nextProperties = { ...properties };
  delete nextProperties['binding_slot'];
  const next: Record<string, unknown> = { ...parameters, properties: nextProperties };
  const required = parameters['required'];
  if (Array.isArray(required) && required.includes('binding_slot')) {
    next['required'] = required.filter((entry) => entry !== 'binding_slot');
  }
  return next;
}

export function stripSubagentForkParameter(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters['properties'];
  if (!isPlainObject(properties) || !('fork' in properties)) return parameters;
  const nextProperties = { ...properties };
  delete nextProperties['fork'];
  const next: Record<string, unknown> = { ...parameters, properties: nextProperties };
  const required = parameters['required'];
  if (Array.isArray(required) && required.includes('fork')) {
    next['required'] = required.filter((entry) => entry !== 'fork');
  }
  return next;
}

export function wrapSubagentModelError(
  error: unknown,
  boundModel: string,
  callerModelAlias: string | undefined,
  source?: SubagentBindingSource,
  profileType?: string,
  slotName?: string,
): unknown {
  if (boundModel === callerModelAlias) return error;
  if (!isError2(error) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  if (error.details?.['model'] !== boundModel) return error;

  if (source === 'agent_types' && profileType !== undefined) {
    const displayModel = isAgentTypeDerivedModelId(boundModel)
      ? `the derived entry "${boundModel}" (synthesized from [agent_types.${profileType}])`
      : `"${boundModel}"`;
    return new Error2(
      error.code,
      `${error.message} (model ${displayModel} comes from [agent_types.${profileType}].model — check that it names a valid [models] entry)`,
      {
        cause: error,
        name: error.name,
        details: {
          ...error.details,
          boundModel,
          agentTypeConfig: {
            section: `agentTypes.${profileType}.model`,
          },
        },
      },
    );
  }

  if (source === 'slot' && slotName !== undefined) {
    return new Error2(
      error.code,
      `${error.message} (model "${boundModel}" comes from [subagent-slot.${slotName}].model in local.toml — check that it names a valid [models] entry)`,
      {
        cause: error,
        name: error.name,
        details: {
          ...error.details,
          boundModel,
          slotBindingConfig: {
            section: `subagent-slot.${slotName}.model`,
            file: 'local.toml',
          },
        },
      },
    );
  }

  if (source === 'local_type' && profileType !== undefined) {
    return new Error2(
      error.code,
      `${error.message} (model "${boundModel}" comes from [subagent.${profileType}].model in local.toml — check that it names a valid [models] entry)`,
      {
        cause: error,
        name: error.name,
        details: {
          ...error.details,
          boundModel,
          typeBindingConfig: {
            section: `subagent.${profileType}.model`,
            file: 'local.toml',
          },
        },
      },
    );
  }

  return new Error2(
    error.code,
    `${error.message} (secondary model "${boundModel}" comes from [secondary_model.models] / default_model — check that it names a valid [models] entry)`,
    {
      cause: error,
      name: error.name,
      details: {
        ...error.details,
        secondaryModel: boundModel,
        secondaryModelConfig: {
          section: 'secondary_model',
        },
      },
    },
  );
}

export function formatSubagentTimeoutDescription(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) {
    const h = ms / (60 * 60 * 1000);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  if (ms % (60 * 1000) === 0) {
    const m = ms / (60 * 1000);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  if (ms % 1000 === 0) {
    const s = ms / 1000;
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  return `${ms} ms`;
}