import { readFileSync, readdirSync } from 'node:fs';

import { join } from 'pathe';

import { resolveKimiHome } from '../config/path';
import { log } from '../logging/logger';
import { parseFrontmatter } from '../skill/parser';
import { DEFAULT_AGENT_PROFILES } from './default';
import type { ResolvedAgentProfile, SystemPromptContext } from './types';

/**
 * Sub-agent profile names must match this pattern (lowercase kebab-case digits
 * and hyphens), consistent with the built-in types (`coder`, `explore`, ...).
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const DESCRIPTION_MAX_LENGTH = 240;

/** Cache keyed by the resolved home dir; the home dir is stable in-process. */
const cache = new Map<string, Record<string, ResolvedAgentProfile>>();

/**
 * Return the merged sub-agent profile table: the built-in `agent.subagents`
 * plus any user-defined profiles discovered under `<home>/agents/*.md`.
 *
 * User profiles clone the built-in `coder` profile (keeping its subagent
 * framing) and override `name` / `description` / `whenToUse` / `tools`; the
 * file body is appended to the coder role prompt. A user profile whose name
 * collides with a built-in sub-agent type is skipped with a warning rather
 * than overriding the built-in.
 *
 * The home dir follows the existing `OMKC_HOME` -> `KIMI_CODE_HOME` ->
 * `~/.omkc` resolution (see {@link resolveKimiHome}); pass the session's
 * brand home when available so user profiles live alongside the user-level
 * `AGENTS.md`. Loading is lazy, cached, fault-tolerant, and synchronous
 * (the spawn path is synchronous).
 */
export function getSubagentProfiles(brandHome?: string): Record<string, ResolvedAgentProfile> {
  const builtins = DEFAULT_AGENT_PROFILES['agent']?.subagents ?? {};
  const home = resolveKimiHome(brandHome);
  let userProfiles = cache.get(home);
  if (userProfiles === undefined) {
    userProfiles = loadUserSubagentProfiles(home);
    cache.set(home, userProfiles);
  }
  return { ...builtins, ...userProfiles };
}

/** @internal - vitest only: drops the cache so tests can reuse a temp dir. */
export function resetUserAgentProfileCacheForTest(): void {
  cache.clear();
}

function loadUserSubagentProfiles(home: string): Record<string, ResolvedAgentProfile> {
  const result: Record<string, ResolvedAgentProfile> = {};
  const builtins = DEFAULT_AGENT_PROFILES['agent']?.subagents ?? {};
  const coder = DEFAULT_AGENT_PROFILES['coder'];
  if (coder === undefined) return result;

  const agentsDir = join(home, 'agents');
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    // The directory does not exist for most users - that is normal.
    return result;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = join(agentsDir, entry);
    const def = parseUserAgentFile(filePath, entry);
    if (def === undefined) continue;
    if (builtins[def.name] !== undefined) {
      log.warn(
        `Skipping user subagent profile "${def.name}" at ${filePath}: name conflicts with a built-in subagent type`,
      );
      continue;
    }
    if (result[def.name] !== undefined) {
      log.warn(`Skipping duplicate user subagent profile "${def.name}" at ${filePath}`);
      continue;
    }
    result[def.name] = buildUserProfile(coder, def);
  }
  return result;
}

interface UserAgentDefinition {
  readonly name: string;
  readonly description?: string;
  readonly whenToUse?: string;
  readonly tools?: string[];
  readonly body: string;
}

function parseUserAgentFile(filePath: string, fileName: string): UserAgentDefinition | undefined {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    log.warn(`Failed to read user subagent profile at ${filePath}`, { error });
    return undefined;
  }

  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (error) {
    log.warn(`Invalid frontmatter in user subagent profile ${fileName}`, { error });
    return undefined;
  }

  const frontmatter = isRecord(parsed.data) ? parsed.data : {};

  const baseName = fileName.replace(/\.md$/i, '');
  const name = nonEmptyString(frontmatter['name']) ?? baseName;
  if (!NAME_PATTERN.test(name)) {
    log.warn(
      `Skipping user subagent profile ${fileName}: invalid name "${name}" (must match ${NAME_PATTERN.source})`,
    );
    return undefined;
  }

  const body = parsed.body.trim();
  const description = nonEmptyString(frontmatter['description']) ?? firstLine(body);
  const whenToUse =
    nonEmptyString(frontmatter['when_to_use']) ?? nonEmptyString(frontmatter['whenToUse']);

  let tools: string[] | undefined;
  if (frontmatter['tools'] !== undefined) {
    tools = parseToolList(frontmatter['tools']);
    if (tools === undefined) {
      log.warn(
        `Skipping user subagent profile ${fileName}: "tools" must be a list of non-empty strings`,
      );
      return undefined;
    }
  }

  return { name, description, whenToUse, tools, body };
}

/**
 * Build a user sub-agent profile on top of the built-in `coder`: keep coder's
 * system-prompt template and subagent framing, append the file body to the
 * coder role prompt (`roleAdditional`), and override the tool set only when
 * the frontmatter declares one.
 *
 * The renderer delegates to coder's renderer with `roleAdditional` injected
 * via the runtime context (the renderer prefers `context.roleAdditional` over
 * the closed-over prompt var). `skills` is suppressed when the effective tool
 * set lacks `Skill`, matching how built-in read-only profiles hide the Skills
 * section.
 */
function buildUserProfile(
  coder: ResolvedAgentProfile,
  def: UserAgentDefinition,
): ResolvedAgentProfile {
  const coderPreamble = coder.promptVars?.['roleAdditional'] ?? '';
  const combinedRole =
    def.body.length > 0 ? `${coderPreamble}\n\n${def.body}` : coderPreamble;
  const tools = def.tools ?? coder.tools;
  const exposesSkill = tools.includes('Skill');

  const systemPrompt = (context: SystemPromptContext): string =>
    coder.systemPrompt({
      ...context,
      roleAdditional: combinedRole,
      skills: exposesSkill ? context.skills : '',
    });

  return {
    name: def.name,
    description: def.description,
    whenToUse: def.whenToUse,
    systemPrompt,
    tools: [...tools],
    promptVars: { ...coder.promptVars, roleAdditional: combinedRole },
  };
}

function parseToolList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    const trimmed = item.trim();
    if (trimmed.length === 0) return undefined;
    tools.push(trimmed);
  }
  return tools;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function firstLine(body: string): string | undefined {
  const line = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return undefined;
  return line.length > DESCRIPTION_MAX_LENGTH
    ? `${line.slice(0, DESCRIPTION_MAX_LENGTH - 1)}…`
    : line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
