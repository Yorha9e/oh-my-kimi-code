import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import CREATE_SUBAGENT_PROFILE_BODY from './create-subagent-profile.md?raw';

const PSEUDO_PATH = 'builtin://create-subagent-profile';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/create-subagent-profile.md',
  skillDirName: 'create-subagent-profile',
  source: 'builtin',
  text: CREATE_SUBAGENT_PROFILE_BODY,
});

export const CREATE_SUBAGENT_PROFILE_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};
