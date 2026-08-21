
import { describe, expect, it } from 'vitest';

import {
  MODELS_SECTION,
} from '#/app/kosongConfig/configSection';
import {
  agentTypesOverlay,
} from '#/app/kosongConfig/agentTypesOverlay';
import {
  AGENT_TYPES_SECTION,
  agentTypeDerivedModelId,
} from '#/session/subagent/configSection';

function apply(effective: Record<string, unknown>): readonly string[] {
  return agentTypesOverlay.apply(effective, () => undefined, (_domain, value) => value);
}

const baseEntry = {
  provider: 'kimi',
  model: 'kimi-k2',
  maxContextSize: 262144,
  aliases: ['k2-latest'],
  overrides: { defaultEffort: 'medium', supportEfforts: ['low', 'medium', 'high'] },
};

describe('agentTypesOverlay.apply', () => {
  it('does nothing when no agent types are configured', () => {
    const effective: Record<string, unknown> = { [MODELS_SECTION]: { k2: baseEntry } };
    expect(apply(effective)).toEqual([]);
    expect(effective[MODELS_SECTION]).toEqual({ k2: baseEntry });
  });

  it('does nothing for a pointer-only entry (no patch fields)', () => {
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { k2: baseEntry },
      [AGENT_TYPES_SECTION]: { coder: { model: 'k2' } },
    };
    expect(apply(effective)).toEqual([]);
    expect(effective[MODELS_SECTION]).toEqual({ k2: baseEntry });
  });

  it('does nothing for an entry with only model + thinking (no patch fields)', () => {
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { k2: baseEntry },
      [AGENT_TYPES_SECTION]: { coder: { model: 'k2', thinking: 'high' } },
    };
    expect(apply(effective)).toEqual([]);
    expect(effective[MODELS_SECTION]).toEqual({ k2: baseEntry });
  });

  it('synthesizes the derived entry: base copy, patch wins overrides conflicts, aliases dropped', () => {
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { k2: baseEntry },
      [AGENT_TYPES_SECTION]: { coder: { model: 'k2', maxOutputSize: 8192, defaultEffort: 'low' } },
    };
    expect(apply(effective)).toEqual([MODELS_SECTION]);
    const models = effective[MODELS_SECTION] as Record<string, unknown>;
    const derivedId = agentTypeDerivedModelId('coder');
    expect(models[derivedId]).toEqual({
      provider: 'kimi',
      model: 'kimi-k2',
      maxContextSize: 262144,
      overrides: {
        defaultEffort: 'low',
        supportEfforts: ['low', 'medium', 'high'],
        maxOutputSize: 8192,
      },
    });
    expect(models['k2']).toEqual(baseEntry);
  });

  it('synthesizes multiple derived entries for multiple patch-bearing types', () => {
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { k2: baseEntry },
      [AGENT_TYPES_SECTION]: {
        coder: { model: 'k2', maxOutputSize: 4096 },
        reviewer: { model: 'k2', defaultEffort: 'high' },
      },
    };
    expect(apply(effective)).toEqual([MODELS_SECTION]);
    const models = effective[MODELS_SECTION] as Record<string, unknown>;
    expect(models[agentTypeDerivedModelId('coder')]).toBeDefined();
    expect(models[agentTypeDerivedModelId('reviewer')]).toBeDefined();
    const coderDerived = models[agentTypeDerivedModelId('coder')] as Record<string, unknown>;
    expect((coderDerived['overrides'] as Record<string, unknown>)['maxOutputSize']).toBe(4096);
    const reviewerDerived = models[agentTypeDerivedModelId('reviewer')] as Record<string, unknown>;
    expect((reviewerDerived['overrides'] as Record<string, unknown>)['defaultEffort']).toBe('high');
  });

  it('does nothing when the pointed entry does not exist', () => {
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { k2: baseEntry },
      [AGENT_TYPES_SECTION]: { coder: { model: 'nope', maxOutputSize: 8192 } },
    };
    expect(apply(effective)).toEqual([]);
    expect(effective[MODELS_SECTION]).toEqual({ k2: baseEntry });
  });

  it('does nothing when the entry has patch fields but no model', () => {
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { k2: baseEntry },
      [AGENT_TYPES_SECTION]: { coder: { maxOutputSize: 8192 } },
    };
    expect(apply(effective)).toEqual([]);
    expect(effective[MODELS_SECTION]).toEqual({ k2: baseEntry });
  });

  it('never derives from a derived id (agent type model pointing at __agent_type_*__)', () => {
    const derivedId = agentTypeDerivedModelId('coder');
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { [derivedId]: baseEntry },
      [AGENT_TYPES_SECTION]: { reviewer: { model: derivedId, maxOutputSize: 1 } },
    };
    expect(apply(effective)).toEqual([]);
  });

  it('skips pointer-only entries but synthesizes for patch-bearing entries in the same config', () => {
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { k2: baseEntry },
      [AGENT_TYPES_SECTION]: {
        coder: { model: 'k2' },        reviewer: { model: 'k2', maxOutputSize: 2048 },      },
    };
    expect(apply(effective)).toEqual([MODELS_SECTION]);
    const models = effective[MODELS_SECTION] as Record<string, unknown>;
    expect(models[agentTypeDerivedModelId('coder')]).toBeUndefined();
    expect(models[agentTypeDerivedModelId('reviewer')]).toBeDefined();
  });
});

describe('agentTypesOverlay.strip', () => {
  const strip = agentTypesOverlay.strip!;

  it('removes all derived entries from models writes and leaves other domains alone', () => {
    const coderId = agentTypeDerivedModelId('coder');
    const reviewerId = agentTypeDerivedModelId('reviewer');
    const models = { k2: baseEntry, [coderId]: { ...baseEntry }, [reviewerId]: { ...baseEntry } };
    expect(strip(MODELS_SECTION, models, {})).toEqual({ k2: baseEntry });
    expect(strip('thinking', { effort: 'low' }, {})).toEqual({ effort: 'low' });
  });

  it('leaves a models section without derived entries untouched', () => {
    const models = { k2: baseEntry };
    expect(strip(MODELS_SECTION, models, {})).toBe(models);
  });

  it('rolls back a defaultModel pointer set to a derived id', () => {
    const coderId = agentTypeDerivedModelId('coder');
    expect(strip('defaultModel', 'k2', {})).toBe('k2');
    expect(strip('defaultModel', coderId, { default_model: 'k2' })).toBe('k2');
    expect(strip('defaultModel', coderId, {})).toBeUndefined();
  });
});
