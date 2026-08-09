/**
 * The v1 subagent model-binding file surface (`[subagent.<type>]` /
 * `[subagent-slot.<name>]` in the workspace `.kimi-code/local.toml` and the
 * global `<home>/local.toml`), rebuilt for the v2 client.
 *
 * Why a replica exists: agent-core-v2 only READS these files on the spawn
 * path (`session/subagent/slotBinding.ts`); nothing in the engine writes
 * them, and there is no binding-management service at any scope. The read /
 * write helpers are therefore ported here byte-for-byte from v1
 * (`agent-core/src/config/workspace-local.ts`): read the raw TOML, touch only
 * the target section's single key, and write the unrelated content back
 * unchanged (same `parse → clone → mutate → stringify` pass, same trailing
 * newline, same whole-file schema so a schema-violating entry anywhere in the
 * file fails the same way v1 does), and path handling stays on `pathe`
 * exactly like the v1 source, so returned paths keep the same spelling on
 * every platform. Differences from the v1 source are mechanical only: the
 * Kaos filesystem abstraction becomes `node:fs/promises` (the same
 * substitution `global-mcp.ts` makes), and the global layer takes the
 * client's already-resolved kimi home instead of `kaos.gethome()` (matching
 * the engine's own reader, which resolves the same home via
 * `resolveKimiHome`).
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

import { dirname, isAbsolute, join, normalize, resolve } from 'pathe';

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { z } from 'zod';

import { ErrorCodes, KimiError } from '@moonshot-ai/agent-core';

import type { SubagentBinding } from '#/types';

/** The two `local.toml` sections that hold subagent model bindings. */
export type SubagentBindingSection = 'subagent' | 'subagent-slot';

const SubagentBindingTomlSchema = z.object({
  model: z.string().optional(),
  thinking_effort: z.string().optional(),
  inherit: z.boolean().optional(),
});

// Whole-file schema matching v1's `WorkspaceLocalTomlSchema`, so a
// schema-violating entry anywhere in local.toml fails the same way v1 does.
const WorkspaceLocalTomlSchema = z.object({
  workspace: z
    .object({
      additional_dir: z.array(z.string()),
    })
    .optional(),
  subagent: z.record(z.string(), SubagentBindingTomlSchema).optional(),
  'subagent-slot': z.record(z.string(), SubagentBindingTomlSchema).optional(),
});

type WorkspaceLocalToml = z.infer<typeof WorkspaceLocalTomlSchema>;

interface WorkspaceLocalTomlFile {
  readonly raw: Record<string, unknown>;
  readonly parsed: WorkspaceLocalToml;
}

/**
 * Read one binding section from the workspace layer: `<projectRoot>/.kimi-code/local.toml`,
 * where the project root is the nearest `.git` ancestor of `workDir` (or
 * `workDir` itself when there is none). Byte-identical port of v1's
 * `readBindingSection`.
 */
export async function readWorkspaceSubagentBindingSection(
  workDir: string,
  section: SubagentBindingSection,
): Promise<Readonly<Record<string, SubagentBinding>>> {
  const projectRoot = await findProjectRoot(workDir);
  return readBindingSectionAtPath(getWorkspaceLocalConfigPath(projectRoot), section);
}

/**
 * Write (or clear, when `binding` is `undefined`) one workspace-layer
 * binding, preserving unrelated TOML content. Byte-identical port of v1's
 * `writeBindingEntry`.
 */
export async function writeWorkspaceSubagentBinding(
  workDir: string,
  section: SubagentBindingSection,
  name: string,
  binding: SubagentBinding | undefined,
): Promise<{ readonly configPath: string }> {
  const projectRoot = await findProjectRoot(workDir);
  return writeBindingEntryAtPath(
    getWorkspaceLocalConfigPath(projectRoot),
    section,
    name,
    binding,
  );
}

/**
 * Read one binding section from the global layer: `<homeDir>/local.toml` —
 * the same path the v2 spawn-side reader uses (`resolveKimiHome()`'s output;
 * the client hands in its already-resolved home). Byte-identical port of
 * v1's `readBindingSectionAtPath` over `getGlobalLocalConfigPath`.
 */
export async function readGlobalSubagentBindingSection(
  homeDir: string,
  section: SubagentBindingSection,
): Promise<Readonly<Record<string, SubagentBinding>>> {
  return readBindingSectionAtPath(getGlobalLocalConfigPath(homeDir), section);
}

/**
 * Write (or clear, when `binding` is `undefined`) one global-layer binding,
 * preserving unrelated TOML content. Byte-identical port of v1's
 * `writeBindingEntryAtPath` over `getGlobalLocalConfigPath`.
 */
export async function writeGlobalSubagentBinding(
  homeDir: string,
  section: SubagentBindingSection,
  name: string,
  binding: SubagentBinding | undefined,
): Promise<{ readonly configPath: string }> {
  return writeBindingEntryAtPath(getGlobalLocalConfigPath(homeDir), section, name, binding);
}

async function readBindingSectionAtPath(
  configPath: string,
  section: SubagentBindingSection,
): Promise<Readonly<Record<string, SubagentBinding>>> {
  const file = await readWorkspaceLocalToml(configPath);
  const entries = file?.parsed[section] ?? {};
  return Object.fromEntries(
    Object.entries(entries).map(([type, entry]) => [
      type,
      { model: entry.model, thinkingEffort: entry.thinking_effort, inherit: entry.inherit },
    ]),
  );
}

async function writeBindingEntryAtPath(
  configPath: string,
  section: SubagentBindingSection,
  name: string,
  binding: SubagentBinding | undefined,
): Promise<{ readonly configPath: string }> {
  const file = (await readWorkspaceLocalToml(configPath)) ?? { raw: {}, parsed: {} };

  const record = cloneRecord(file.raw[section]);
  if (binding === undefined) {
    delete record[name];
  } else {
    const entry: Record<string, unknown> = {};
    if (binding.model !== undefined) entry['model'] = binding.model;
    if (binding.thinkingEffort !== undefined) entry['thinking_effort'] = binding.thinkingEffort;
    if (binding.inherit !== undefined) entry['inherit'] = binding.inherit;
    record[name] = entry;
  }
  if (Object.keys(record).length === 0) {
    delete file.raw[section];
  } else {
    file.raw[section] = record;
  }

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${stringifyToml(file.raw)}\n`, 'utf-8');
  return { configPath };
}

function getWorkspaceLocalConfigPath(projectRoot: string): string {
  return join(projectRoot, '.kimi-code', 'local.toml');
}

/**
 * The global config lives at a fixed path under the resolved kimi home — no
 * project-root search, unlike the per-workspace file.
 */
function getGlobalLocalConfigPath(homeDir: string): string {
  return join(homeDir, 'local.toml');
}

async function findProjectRoot(workDir: string): Promise<string> {
  const initial = resolveWorkDir(workDir);
  let current = initial;

  for (;;) {
    if (await pathExists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

function resolveWorkDir(workDir: string): string {
  return isAbsolute(workDir) ? normalize(workDir) : resolve(process.cwd(), workDir);
}

async function readWorkspaceLocalToml(
  configPath: string,
): Promise<WorkspaceLocalTomlFile | undefined> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf-8');
  } catch (error: unknown) {
    if (isPathMissing(error)) return undefined;
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Failed to read ${configPath}: ${describeError(error)}`,
      { cause: error },
    );
  }

  if (text.trim().length === 0) return { raw: {}, parsed: {} };

  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error: unknown) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid TOML in ${configPath}: ${describeError(error)}`,
      { cause: error },
    );
  }

  if (!isPlainObject(raw)) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `Invalid workspace local config in ${configPath}`);
  }

  return { raw: cloneRecord(raw), parsed: parseWorkspaceLocalToml(raw) };
}

function parseWorkspaceLocalToml(raw: Record<string, unknown>): WorkspaceLocalToml {
  try {
    return WorkspaceLocalTomlSchema.parse(raw);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      throw new KimiError(ErrorCodes.CONFIG_INVALID, describeWorkspaceLocalValidationError(error), {
        cause: error,
      });
    }
    throw error;
  }
}

function describeWorkspaceLocalValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.path[0] === 'workspace' && issue.path[1] === 'additional_dir') {
    return 'workspace.additional_dir must be an array of strings';
  }
  if (issue?.path[0] === 'workspace') return 'workspace must be a table';
  return `Invalid workspace local config: ${error.message}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
