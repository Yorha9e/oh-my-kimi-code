import { describe, expect, it } from 'vitest';

import { CREATE_SUBAGENT_PROFILE_SKILL, SessionSkillRegistry, registerBuiltinSkills } from '../../src/skill';

describe('builtin skill: create-subagent-profile', () => {
  it('has the expected identity and inline metadata', () => {
    expect(CREATE_SUBAGENT_PROFILE_SKILL.name).toBe('create-subagent-profile');
    expect(CREATE_SUBAGENT_PROFILE_SKILL.source).toBe('builtin');
    expect(CREATE_SUBAGENT_PROFILE_SKILL.description.length).toBeGreaterThan(0);
    expect(CREATE_SUBAGENT_PROFILE_SKILL.metadata.type).toBe('inline');
  });

  it('is model-invocable (does not disable model invocation)', () => {
    expect(CREATE_SUBAGENT_PROFILE_SKILL.metadata.disableModelInvocation).not.toBe(true);
  });

  it('documents the agents dir, frontmatter fields, and the slot pattern', () => {
    const content = CREATE_SUBAGENT_PROFILE_SKILL.content;
    expect(content).toContain('agents/');
    expect(content).toContain('whenToUse');
    expect(content).toContain('binding_slot');
    expect(content).toContain('OMKC_HOME');
  });

  it('registers through registerBuiltinSkills and shows up as model-invocable', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);

    expect(registry.getSkill('create-subagent-profile')).toBeDefined();
    expect(
      registry.listInvocableSkills().some((skill) => skill.name === 'create-subagent-profile'),
    ).toBe(true);
  });
});
