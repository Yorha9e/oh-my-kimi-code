/**
 * `subagent` domain — subagent config-section schema, env binding, and
 * timeout / model resolution.
 *
 * Owns the `[subagent]` configuration section (`timeout_ms` on disk) together
 * with the `KIMI_SUBAGENT_TIMEOUT_MS` env override (precedence: env >
 * config.toml > 2h default). While
 * the env var is set, `stripEnvBoundFields` restores the env-free raw value
 * before persistence, so the override never leaks into `config.toml`. Per-run
 * timeouts resolve through `resolveSubagentTimeoutMs`, and the timeout
 * message renders with `formatSubagentTimeoutDescription`.
 *
 * The model half of the spawn binding is the secondary model (the
 * `[secondary_model]` section on disk): when its
 * experiment is enabled and the model is set, newly spawned subagents bind to
 * it by default instead of inheriting the caller's model, and the
 * `Agent`/`AgentSwarm` tools let the parent model pick per spawn via their
 * `model` parameter. When unset, spawning behavior is unchanged (subagents
 * inherit the caller's model). A recipe with patch fields binds the
 * synthesized derived entry (`SECONDARY_DERIVED_MODEL_ID`); a pointer-only
 * recipe binds the pointed entry directly. `default_effort` is passed as the
 * explicit subagent thinking; without it the subagent resolves thinking
 * naturally (global thinking config → the bound model's default effort)
 * rather than inheriting the caller's level. Both tools resolve spawn
 * bindings through `resolveSubagentBinding`, advertise the pair via
 * `buildSubagentModelDescriptions` (each line suffixed with the entry's
 * resolved capability flags, so the parent can route multimodal or
 * thinking-heavy subagent tasks instead of guessing from the model id),
 * and wrap spawn failures with
 * `wrapSubagentModelError`; while the experiment is off they also strip the
 * no-op `model` parameter from their advertised schemas via
 * `stripSubagentModelParameter`.
 *
 * One more binding level slots into the chain between the per-type and
 * secondary layers: a profile declaring `slot` in its frontmatter binds
 * `[subagent-slot.<slot>]` from local.toml (read by the `slotBinding`
 * module), passed into `resolveSubagentBinding` as pure data with
 * `source: 'slot'`; the caller drops the level on `inherit: true` or an
 * unknown alias before it ever reaches the resolver. A slot setting only
 * `thinking_effort` keeps the model on the chain below (secondary → own)
 * while the slot's thinking level wins. Spawn reporting reads the display-facing
 * alias from `subagentDisplayModel`: the derived entry id means nothing to a
 * user, so it resolves back to the recipe's base alias — flag-independent on
 * purpose, since interpreting an already-persisted derived binding (resume)
 * must keep working after the experiment is switched off. Self-registered
 * at module load via `registerConfigSection`.
 */

import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import type { AgentModelPreference } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { IFlagService } from '#/app/flag/flag';
import {
  ModelOverrideSchema,
  SECONDARY_MODEL_ENV,
  SECONDARY_MODEL_SECTION,
  type SecondaryModelConfig,
} from '#/app/kosongConfig/configSection';
import {
  SECONDARY_DERIVED_MODEL_ID,
  secondaryModelPatch,
} from '#/app/kosongConfig/secondaryModelOverlay';
import type { ModelOverride } from '#/kosong/model/model';
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
  isPlainObject,
  setDefined,
  transformPlainObject,
} from '#/app/config/toml';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { IModelCatalog } from '#/kosong/model/catalog';

import { SECONDARY_MODEL_FLAG_ID } from './flag';

export const SUBAGENT_SECTION = 'subagent';

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
});

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const SUBAGENT_TIMEOUT_ENV = 'KIMI_SUBAGENT_TIMEOUT_MS';

function parseTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
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

export function resolveSubagentTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.timeoutMs ??
    DEFAULT_SUBAGENT_TIMEOUT_MS
  );
}

export type SubagentModelChoice = AgentModelPreference;

/** Where a resolved subagent model binding came from. */
export type SubagentBindingSource = 'agent_types' | 'slot' | 'secondary' | 'own';

/** A resolved subagent model binding, with provenance for error attribution. */
export interface SubagentBinding {
  readonly model: string;
  readonly thinking?: string;
  readonly displayModel: string;
  readonly source?: SubagentBindingSource;
}

export function resolveSecondaryModel(
  config: IConfigService,
  flags: IFlagService,
): SecondaryModelConfig | undefined {
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) return undefined;
  return config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
}

export function resolveSubagentBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: SubagentModelChoice,
  profileType?: string,
  slotBinding?: { readonly model?: string; readonly thinking?: string },
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
  // (secondary → own) while the slot's thinking level wins, with `source`
  // tracking the model's actual layer — mirroring v1's independent
  // thinking chain.
  if (
    requested === undefined &&
    slotBinding?.model === undefined &&
    slotBinding?.thinking !== undefined
  ) {
    const fallback = resolveSubagentBinding(config, flags, own);
    return {
      model: fallback.model,
      thinking: slotBinding.thinking,
      displayModel: fallback.displayModel,
      source: fallback.source,
    };
  }

  // Explicit 'secondary' or undefined fallback: the global secondary model.
  // ('primary' already returned above, so the upstream `requested !==
  // 'primary'` guard is redundant here and trips TS2367 narrowing.)
  const secondary = resolveSecondaryModel(config, flags);
  if (secondary?.model !== undefined) {
    const model =
      secondaryModelPatch(secondary) === undefined ? secondary.model : SECONDARY_DERIVED_MODEL_ID;
    return {
      model,
      thinking: secondary.defaultEffort,
      displayModel: subagentDisplayModel(config, model),
      source: 'secondary',
    };
  }

  // Final fallback: the caller's model.
  return {
    model: own.modelAlias,
    thinking: own.thinkingLevel,
    displayModel: subagentDisplayModel(config, own.modelAlias),
    source: 'own',
  };
}

export function subagentDisplayModel(
  config: IConfigService,
  boundAlias: string,
): string {
  if (boundAlias !== SECONDARY_DERIVED_MODEL_ID) return boundAlias;
  return (
    config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION)?.model ?? boundAlias
  );
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
  const secondary = resolveSecondaryModel(config, flags);
  const secondaryModel = secondary?.model;
  if (secondaryModel === undefined || callerModelAlias === undefined) return undefined;
  const boundSecondary =
    secondaryModelPatch(secondary) === undefined ? secondaryModel : SECONDARY_DERIVED_MODEL_ID;
  return [
    'Available models (pass via model):',
    `- secondary: ${secondaryModel} (default) — the configured secondary model; prefer it for routine subagent tasks${capabilitiesSuffix(resolvedCapabilities(modelCatalog, boundSecondary))}`,
    `- primary: ${callerModelAlias} — the main model you are running on; use it for hard, quality-sensitive subagent tasks${capabilitiesSuffix(resolvedCapabilities(modelCatalog, callerModelAlias))}`,
  ].join('\n');
}

const ADVERTISED_CAPABILITY_FLAGS = [
  'image_in',
  'video_in',
  'audio_in',
  'thinking',
  'tool_use',
  'dynamically_loaded_tools',
] as const satisfies readonly (keyof ModelCapability)[];

function capabilitiesSuffix(capability: ModelCapability | undefined): string {
  if (capability === undefined) return '';
  const names = ADVERTISED_CAPABILITY_FLAGS.filter((flag) => capability[flag] === true);
  return `; capabilities: ${names.length === 0 ? 'none' : names.join(', ')}`;
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

  const displayModel =
    boundModel === SECONDARY_DERIVED_MODEL_ID
      ? `the derived entry "${SECONDARY_DERIVED_MODEL_ID}"`
      : `"${boundModel}"`;
  return new Error2(
    error.code,
    `${error.message} (secondary model ${displayModel} comes from [secondary_model].model / ${SECONDARY_MODEL_ENV} — check that it names a valid [models] entry)`,
    {
      cause: error,
      name: error.name,
      details: {
        ...error.details,
        secondaryModel: boundModel,
        secondaryModelConfig: {
          section: 'secondaryModel.model',
          environment: SECONDARY_MODEL_ENV,
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
