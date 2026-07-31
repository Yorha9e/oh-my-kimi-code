/**
 * `subagent` domain — named slot binding access (`[subagent-slot.<slot>]`).
 *
 * A profile's frontmatter may declare a `slot`; the spawn chain resolves it
 * against `[subagent-slot.<slot>]` in `.kimi-code/local.toml` (workspace
 * layer: the nearest `.git` ancestor of the work dir, or the work dir itself)
 * and, falling back, `<home>/local.toml` (global layer; home via
 * `resolveKimiHome`: `OMHC_HOME` > `KIMI_CODE_HOME` > `~/.omkc`). Field
 * names, file layout, and malformed-input behavior mirror the v1
 * `workspace-local` reader: a missing file/section/entry is `undefined` and
 * an empty file is an empty config, while malformed TOML or a schema-
 * violating entry raises `CONFIG_INVALID`. The read layer is deliberately
 * dumb — `inherit: true` and alias validity are consumed by the spawn-side
 * caller, never here.
 */

import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'pathe';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import { resolveKimiHome } from '#/app/bootstrap/bootstrap';
import { isPlainObject } from '#/app/config/toml';
import { Error2, ErrorCodes } from '#/errors';

export interface SubagentSlotBinding {
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly inherit?: boolean;
}

const SubagentSlotBindingSchema = z.object({
  model: z.string().optional(),
  thinking_effort: z.string().optional(),
  inherit: z.boolean().optional(),
});

// Whole-file schema matching the v1 `WorkspaceLocalTomlSchema`, so a
// schema-violating entry anywhere in local.toml fails the same way v1 does.
const LocalTomlSchema = z.object({
  workspace: z
    .object({
      additional_dir: z.array(z.string()),
    })
    .optional(),
  subagent: z.record(z.string(), SubagentSlotBindingSchema).optional(),
  'subagent-slot': z.record(z.string(), SubagentSlotBindingSchema).optional(),
});

type LocalToml = z.infer<typeof LocalTomlSchema>;

/** Read the workspace-layer binding for one named slot; `undefined` means never configured. */
export async function readWorkspaceSlotBinding(
  workDir: string,
  slot: string,
): Promise<SubagentSlotBinding | undefined> {
  const projectRoot = await findProjectRoot(workDir);
  return readSlotBindingAtPath(join(projectRoot, '.kimi-code', 'local.toml'), slot);
}

/** Read the global-layer binding for one named slot; `undefined` means never configured. */
export async function readGlobalSlotBinding(
  slot: string,
): Promise<SubagentSlotBinding | undefined> {
  return readSlotBindingAtPath(join(resolveKimiHome(), 'local.toml'), slot);
}

/** Workspace layer first, then the global layer; `undefined` when neither is configured. */
export async function readWorkspaceThenGlobalSlotBinding(
  workDir: string,
  slot: string,
): Promise<SubagentSlotBinding | undefined> {
  const workspace = await readWorkspaceSlotBinding(workDir, slot);
  return workspace ?? (await readGlobalSlotBinding(slot));
}

async function readSlotBindingAtPath(
  configPath: string,
  slot: string,
): Promise<SubagentSlotBinding | undefined> {
  const file = await readLocalToml(configPath);
  const entry = file?.['subagent-slot']?.[slot];
  if (entry === undefined) return undefined;
  return {
    model: entry.model,
    thinkingEffort: entry.thinking_effort,
    inherit: entry.inherit,
  };
}

async function findProjectRoot(workDir: string): Promise<string> {
  const initial = isAbsolute(workDir) ? normalize(workDir) : resolve(process.cwd(), workDir);
  let current = initial;

  while (true) {
    if (await pathExists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readLocalToml(configPath: string): Promise<LocalToml | undefined> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error: unknown) {
    if (isPathMissing(error)) return undefined;
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Failed to read ${configPath}: ${describeError(error)}`,
      { cause: error },
    );
  }

  if (text.trim().length === 0) return {};

  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error: unknown) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Invalid TOML in ${configPath}: ${describeError(error)}`,
      { cause: error },
    );
  }

  if (!isPlainObject(raw)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, `Invalid workspace local config in ${configPath}`);
  }

  return parseLocalToml(raw);
}

function parseLocalToml(raw: Record<string, unknown>): LocalToml {
  try {
    return LocalTomlSchema.parse(raw);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, describeLocalValidationError(error), {
        cause: error,
      });
    }
    throw error;
  }
}

function describeLocalValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.path[0] === 'workspace' && issue.path[1] === 'additional_dir') {
    return 'workspace.additional_dir must be an array of strings';
  }
  if (issue?.path[0] === 'workspace') return 'workspace must be a table';
  return `Invalid workspace local config: ${error.message}`;
}

function isPathMissing(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function getErrorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return (error as { code: unknown }).code;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
