import { describe, expect, it } from 'vitest';

import { renderSystemPromptResult } from '#/app/agentProfileCatalog/profile-shared';
import { AgentFileParseError, parseAgentFileText } from '#/workspace/workspaceAgentProfileLoader/internal/agentFile';
import { agentProfileFromFile } from '#/workspace/workspaceAgentProfileLoader/internal/agentProfileFromFile';
import type { AgentFileDefinition } from '#/workspace/workspaceAgentProfileLoader/internal/types';
import type { SystemPromptRenderResult } from '#/app/agentProfileCatalog/agentProfileCatalog';

const FULL_FILE = `---
name: code-reviewer
description: 严格的代码审查 agent
whenToUse: 代码评审、PR 检查
override: true
tools:
  - Read
  - Grep
  - mcp__github__*
disallowedTools:
  - Bash
subagents:
  - explore
  - plan
unknownField: tolerated
---

你是严格的代码审查者。
`;

function parse(text: string): AgentFileDefinition {
  return parseAgentFileText({ path: '/tmp/agents/reviewer.md', source: 'project', text });
}

describe('parseAgentFileText', () => {
  it('parses a full agent file', () => {
    const def = parse(FULL_FILE);

    expect(def.name).toBe('code-reviewer');
    expect(def.description).toBe('严格的代码审查 agent');
    expect(def.whenToUse).toBe('代码评审、PR 检查');
    expect(def.override).toBe(true);
    expect(def.tools).toEqual(['Read', 'Grep', 'mcp__github__*']);
    expect(def.disallowedTools).toEqual(['Bash']);
    expect(def.subagents).toEqual(['explore', 'plan']);
    expect(def.prompt).toBe('你是严格的代码审查者。');
    expect(def.source).toBe('project');
  });

  it('accepts when_to_use as a legacy alias', () => {
    const def = parse(
      '---\nname: debater\ndescription: d\nwhen_to_use: legacy field\n---\n\nbody\n',
    );
    expect(def.whenToUse).toBe('legacy field');
  });

  it('prefers whenToUse over the when_to_use alias', () => {
    const def = parse(
      '---\nname: debater\ndescription: d\nwhenToUse: canonical\nwhen_to_use: legacy\n---\n\nbody\n',
    );
    expect(def.whenToUse).toBe('canonical');
  });

  it('leaves optional fields undefined when omitted', () => {
    const def = parse('---\nname: solo\ndescription: d\n---\n\nbody\n');

    expect(def.override).toBe(false);
    expect(def.tools).toBeUndefined();
    expect(def.disallowedTools).toBeUndefined();
    expect(def.subagents).toBeUndefined();
    expect(def.whenToUse).toBeUndefined();
    expect(def.prompt).toBe('body');
  });

  it('parses a symbolic model preference', () => {
    const def = parse(
      '---\nname: solo\ndescription: d\nmodel_preference: primary\n---\n\nbody\n',
    );

    expect(def.modelPreference).toBe('primary');
  });

  it('rejects an unsupported model preference', () => {
    expect(() =>
      parse(
        '---\nname: solo\ndescription: d\nmodel_preference: provider/model\n---\n\nbody\n',
      ),
    ).toThrow(/"model_preference"/);
  });

  it('parses the OMKC slot field and leaves it undefined when omitted', () => {
    const withSlot = parse('---\nname: solo\ndescription: d\nslot: debater\n---\n\nbody\n');
    expect(withSlot.slot).toBe('debater');
    expect(parse('---\nname: solo\ndescription: d\n---\n\nbody\n').slot).toBeUndefined();
  });

  it('rejects a non-string slot field', () => {
    expect(() => parse('---\nname: solo\ndescription: d\nslot: [debater]\n---\n\nbody\n')).toThrow(
      /slot/,
    );
  });
  it('treats an explicit file as an override intent', () => {
    const file = parse(FULL_FILE);
    const basePrompt = (context: any) => renderSystemPromptResult('system prompt', context, { skillActive: false });
    const profile = agentProfileFromFile({ ...file, source: 'explicit' }, basePrompt);

    expect(profile.override).toBe(true);
  });
});
