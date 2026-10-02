
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
