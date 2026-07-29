/**
 * `kosongConfig` domain (L3) - `[agent_types.<type>]` derived-entry overlay.
 *
 * For each `[agent_types.<type>]` entry that carries patch fields (any
 * `ModelOverride` field besides `model`/`thinking`, extracted by
 * `agentTypePatch`), synthesizes a derived registry entry
 * (`__agent_type_<type>__`) into the effective `models` view: a copy of the
 * pointed entry with the patch merged into its `overrides` block (patch wins
 * conflicts) and `aliases` dropped, so the derived entry never competes in
 * name/alias routing. Subagent binding then resolves it by name through the
 * standard catalog path, and the patch rides the same `effectiveModelConfig`
 * merge as any `models.*.overrides` (including its supportEfforts/defaultEffort
 * pruning and input clamping).
 *
 * Mirrors `secondaryModelOverlay` (the `[secondary_model]` single-recipe
 * overlay): the synthesized entries live ONLY in the in-memory effective view.
 * `strip` removes every `__agent_type_*__` key from `models` writes so they
 * never reach `config.toml`, and rolls back a `defaultModel` pointer set to a
 * derived id (restoring the raw value). Nothing is synthesized for entries
 * without patch fields (subagents bind the pointed entry directly), when
 * `model` is unset, or when the pointed entry does not exist. The ids are
 * reserved: a user-configured entry under one is stripped on write all the
 * same.
 *
 * Self-registered at module load via `registerConfigOverlay`; `src/index.ts`
 * imports it for side effects AFTER `secondaryModelOverlay`, so a per-type
 * `model` pointing at the secondary-synthesized `__secondary__` entry sees the
 * already-applied secondary view.
 */

import type { ConfigEffectiveOverlay } from '#/app/config/config';
import { registerConfigOverlay } from '#/app/config/configOverlayContributions';
import { isPlainObject } from '#/app/config/toml';

import {
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
} from './configSection';
import {
  AGENT_TYPES_SECTION,
  agentTypeDerivedModelId,
  agentTypePatch,
  isAgentTypeDerivedModelId,
  type AgentTypesConfig,
} from '#/session/subagent/configSection';

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function withoutAgentTypeDerivedKeys(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(value)) {
    if (isAgentTypeDerivedModelId(key)) {
      out ??= { ...value };
      delete out[key];
    }
  }
  return out ?? value;
}

export const agentTypesOverlay: ConfigEffectiveOverlay = {
  apply(effective, _getEnv, validate) {
    const agentTypes = effective[AGENT_TYPES_SECTION] as AgentTypesConfig | undefined;
    if (agentTypes === undefined) return [];

    const models = asRecord(effective[MODELS_SECTION]);
    let nextModels: Record<string, unknown> | undefined;

    for (const [type, binding] of Object.entries(agentTypes)) {
      const patch = agentTypePatch(binding);
      const baseId = binding?.model;
      // No patch, no model, or a reserved id as the base: skip (no derivation).
      if (patch === undefined || baseId === undefined || isAgentTypeDerivedModelId(baseId)) {
        continue;
      }
      const base = models[baseId];
      if (!isPlainObject(base)) continue;

      const { overrides: baseOverrides, aliases: _aliases, ...baseFields } = base;
      const derivedId = agentTypeDerivedModelId(type);
      const derived: Record<string, unknown> = {
        ...baseFields,
        overrides: { ...asRecord(baseOverrides), ...patch },
      };
      nextModels ??= { ...models };
      nextModels[derivedId] = derived;
    }

    if (nextModels === undefined) return [];
    effective[MODELS_SECTION] = validate(MODELS_SECTION, nextModels);
    return [MODELS_SECTION];
  },

  strip(domain, value, rawSnake) {
    switch (domain) {
      case MODELS_SECTION:
        return withoutAgentTypeDerivedKeys(value);
      case DEFAULT_MODEL_SECTION:
        if (typeof value !== 'string' || !isAgentTypeDerivedModelId(value)) return value;
        return typeof rawSnake['default_model'] === 'string'
          ? rawSnake['default_model']
          : undefined;
      default:
        return value;
    }
  },
};

registerConfigOverlay(agentTypesOverlay);
