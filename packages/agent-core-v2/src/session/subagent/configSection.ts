/**
 * `subagent` domain (L6) — subagent config-section schema, env binding, and
 * timeout / model resolution.
 *
 * Owns the `[subagent]` configuration section (`timeout_ms` on disk) together
 * with the `KIMI_SUBAGENT_TIMEOUT_MS` env override, mirroring v1's
 * `resolveSubagentTimeoutMs` precedence (env > config.toml > 2h default). While
 * the env var is set, `stripEnvBoundFields` restores the env-free raw value
 * before persistence, so the override never leaks into `config.toml`. Both
 * collaboration tools — `Agent` in this domain and `AgentSwarm` in the `swarm`
 * domain — resolve their per-run timeout through `resolveSubagentTimeoutMs`,
 * and render the timeout message with `formatSubagentTimeoutDescription`.
 *
 * The model half of the spawn binding is the secondary model (the section
 * and type in `app/kosongConfig` — `[secondary_model]` on disk): when its
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
 * `buildSubagentModelDescriptions`, and wrap spawn failures with
 * `wrapSubagentModelError`. Self-registered at module load via
 * `registerConfigSection`, so the `config` domain never imports this
 * domain's types.
 *
 * Per-type model binding (`[agent_types.<type>]` on disk) lets users pin a
 * model (and optional thinking) to a specific subagent type. When no explicit
 * model choice is made, `resolveSubagentBinding` checks the per-type entry
 * before the secondary model and the caller's model; an explicit `primary` or
 * `secondary` request skips the per-type lookup. The section takes effect
 * without any experimental flag - it is gated only by its own presence.
 */

import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import type { AgentModelPreference } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { IFlagService } from '#/app/flag/flag';
import {
  SECONDARY_MODEL_ENV,
  SECONDARY_MODEL_SECTION,
} from '#/app/kosongConfig/configSection';
import {
  SECONDARY_DERIVED_MODEL_ID,
  secondaryModelPatch,
} from '#/app/kosongConfig/secondaryModelOverlay';
import { type SecondaryModelConfig } from '#/app/kosongConfig/configSection';
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

import { SECONDARY_MODEL_FLAG_ID } from './flag';

export const SUBAGENT_SECTION = 'subagent';

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
});

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

/** Default per-run subagent timeout: 2 hours, same as v1. */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const SUBAGENT_TIMEOUT_ENV = 'KIMI_SUBAGENT_TIMEOUT_MS';

/** Parse the env override; anything but a positive integer is ignored (v1 semantics). */
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
// disk). Each entry may set `model` (a [models] entry id) and `thinking` (an
// effort level). When no explicit model choice is made,
// resolveSubagentBinding checks the per-type entry before the secondary model
// and the caller's model. The record keys are user-defined subagent type
// names (e.g. `code_reviewer`) and must be preserved verbatim; only the inner
// field names (`model`, `thinking`) go through snake_case ↔ camelCase
// conversion. Mirrors the `[models]` section's record-preserving transforms.
export const AGENT_TYPES_SECTION = 'agentTypes';

export const AgentTypeBindingSchema = z.object({
  model: z.string().min(1).optional(),
  thinking: z.string().optional(),
});

export type AgentTypeBinding = z.infer<typeof AgentTypeBindingSchema>;

export const AgentTypesConfigSchema = z.record(z.string(), AgentTypeBindingSchema);

export type AgentTypesConfig = z.infer<typeof AgentTypesConfigSchema>;

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

/**
 * Resolve the effective per-run subagent timeout. Governs foreground and
 * background subagents (and AgentSwarm) through the task manager's per-task
 * timeout.
 */
export function resolveSubagentTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.timeoutMs ??
    DEFAULT_SUBAGENT_TIMEOUT_MS
  );
}

export type SubagentModelChoice = AgentModelPreference;

/** Where a resolved subagent model binding came from. */
export type SubagentBindingSource = 'agent_types' | 'secondary' | 'own';

/** A resolved subagent model binding, with provenance for error attribution. */
export interface SubagentBinding {
  readonly model: string;
  readonly thinking?: string;
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
): SubagentBinding {
  // Explicit 'primary': always the caller's model, skipping all config.
  if (requested === 'primary') {
    return { model: own.modelAlias, thinking: own.thinkingLevel, source: 'own' };
  }

  // No explicit choice: check the per-type binding first.
  if (requested === undefined && profileType !== undefined) {
    const agentTypes = config.get<AgentTypesConfig | undefined>(AGENT_TYPES_SECTION);
    const perType = agentTypes?.[profileType];
    if (perType?.model !== undefined) {
      return { model: perType.model, thinking: perType.thinking, source: 'agent_types' };
    }
  }

  // Explicit 'secondary' or undefined fallback: the global secondary model.
  const secondary = resolveSecondaryModel(config, flags);
  if (secondary?.model !== undefined) {
    return {
      model:
        secondaryModelPatch(secondary) === undefined
          ? secondary.model
          : SECONDARY_DERIVED_MODEL_ID,
      thinking: secondary.defaultEffort,
      source: 'secondary',
    };
  }

  // Final fallback: the caller's model.
  return { model: own.modelAlias, thinking: own.thinkingLevel, source: 'own' };
}

export function buildSubagentModelDescriptions(
  config: IConfigService,
  flags: IFlagService,
  callerModelAlias: string | undefined,
): string | undefined {
  const secondaryModel = resolveSecondaryModel(config, flags)?.model;
  if (secondaryModel === undefined || callerModelAlias === undefined) return undefined;
  return [
    'Available models (pass via model):',
    `- secondary: ${secondaryModel} (default) — the configured secondary model; prefer it for routine subagent tasks`,
    `- primary: ${callerModelAlias} — the main model you are running on; use it for hard, quality-sensitive subagent tasks`,
  ].join('\n');
}

export function wrapSubagentModelError(
  error: unknown,
  boundModel: string,
  callerModelAlias: string,
  source?: SubagentBindingSource,
  profileType?: string,
): unknown {
  if (boundModel === callerModelAlias) return error;
  if (!isError2(error) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  if (error.details?.['model'] !== boundModel) return error;

  if (source === 'agent_types' && profileType !== undefined) {
    return new Error2(
      error.code,
      `${error.message} (model "${boundModel}" comes from [agent_types.${profileType}].model — check that it names a valid [models] entry)`,
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

/** Human-readable duration for the subagent timeout message. */
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
