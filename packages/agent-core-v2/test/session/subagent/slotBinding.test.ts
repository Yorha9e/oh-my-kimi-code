import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'pathe';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import { IFlagService } from '#/app/flag/flag';
import { SECONDARY_MODEL_SECTION } from '#/app/kosongConfig/configSection';
import {
  AGENT_TYPES_SECTION,
  resolveSubagentBinding,
  wrapSubagentModelError,
} from '#/session/subagent/configSection';
import { SECONDARY_MODEL_FLAG_ID } from '#/session/subagent/flag';
import {
  readGlobalSlotBinding,
  readWorkspaceSlotBinding,
  readWorkspaceThenGlobalSlotBinding,
} from '#/session/subagent/slotBinding';

import { stubFlag } from '../../app/flag/stubs';
import { StubConfigService } from '../../kosong/stubs';

const OWN = { modelAlias: 'caller-model', thinkingLevel: 'high' };

const HOME_ENV_KEYS = ['OMKC_HOME', 'KIMI_CODE_HOME'] as const;

let savedHomeEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedHomeEnv = {};
  for (const key of HOME_ENV_KEYS) {
    savedHomeEnv[key] = process.env[key];
  }
});

afterEach(() => {
  for (const key of HOME_ENV_KEYS) {
    const saved = savedHomeEnv[key];
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const filePath = join(root, relPath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }
}

function setGlobalHome(homeDir: string): void {
  process.env['OMKC_HOME'] = homeDir;
  delete process.env['KIMI_CODE_HOME'];
}

describe('readWorkspaceSlotBinding / readGlobalSlotBinding (local.toml read path)', () => {
  it('reads a slot binding from the workspace .kimi-code/local.toml', async () => {
    const root = await makeTempDir('slot-ws-');
    try {
      await writeFiles(root, {
        '.kimi-code/local.toml': [
          '[subagent-slot.coder]',
          'model = "provider/slot-coder"',
          'thinking_effort = "medium"',
        ].join('\n'),
      });
      const binding = await readWorkspaceSlotBinding(root, 'coder');
      expect(binding).toEqual({ model: 'provider/slot-coder', thinkingEffort: 'medium' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('discovers the project root as the nearest .git ancestor', async () => {
    const root = await makeTempDir('slot-git-');
    try {
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFiles(root, {
        '.kimi-code/local.toml': '[subagent-slot.coder]\nmodel = "provider/slot-coder"\n',
      });
      const nested = join(root, 'src', 'deep');
      await mkdir(nested, { recursive: true });
      const binding = await readWorkspaceSlotBinding(nested, 'coder');
      expect(binding).toEqual({ model: 'provider/slot-coder' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to the work dir itself when no .git ancestor exists', async () => {
    const root = await makeTempDir('slot-nogit-');
    try {
      await writeFiles(root, {
        '.kimi-code/local.toml': '[subagent-slot.coder]\nmodel = "provider/slot-coder"\n',
      });
      const sub = join(root, 'sub');
      await mkdir(sub, { recursive: true });
      // No .git anywhere: the work dir itself is the project root.
      expect(await readWorkspaceSlotBinding(sub, 'coder')).toBeUndefined();
      expect(await readWorkspaceSlotBinding(root, 'coder')).toEqual({
        model: 'provider/slot-coder',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns undefined when the workspace file is missing or empty', async () => {
    const root = await makeTempDir('slot-missing-');
    try {
      expect(await readWorkspaceSlotBinding(root, 'coder')).toBeUndefined();
      await writeFiles(root, { '.kimi-code/local.toml': '' });
      expect(await readWorkspaceSlotBinding(root, 'coder')).toBeUndefined();
      await writeFiles(root, { '.kimi-code/local.toml': '  \n' });
      expect(await readWorkspaceSlotBinding(root, 'coder')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns undefined when the section or the entry is absent', async () => {
    const root = await makeTempDir('slot-nosection-');
    try {
      await writeFiles(root, {
        '.kimi-code/local.toml': '[subagent]\nother = { model = "provider/x" }\n',
      });
      expect(await readWorkspaceSlotBinding(root, 'coder')).toBeUndefined();
      await writeFiles(root, {
        '.kimi-code/local.toml': '[subagent-slot]\nreviewer = { model = "provider/r" }\n',
      });
      expect(await readWorkspaceSlotBinding(root, 'coder')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('parses inherit: true as the inherit field', async () => {
    const root = await makeTempDir('slot-inherit-');
    try {
      await writeFiles(root, {
        '.kimi-code/local.toml': '[subagent-slot.keep]\ninherit = true\n',
      });
      expect(await readWorkspaceSlotBinding(root, 'keep')).toEqual({ inherit: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns an entry-shaped binding for an empty [subagent-slot.<slot>] table', async () => {
    const root = await makeTempDir('slot-emptyentry-');
    try {
      await writeFiles(root, {
        '.kimi-code/local.toml': '[subagent-slot.empty]\n',
      });
      // v1 parity: the entry exists, so an all-undefined binding is returned.
      expect(await readWorkspaceSlotBinding(root, 'empty')).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores unknown entry fields (v1 zod strip semantics)', async () => {
    const root = await makeTempDir('slot-unknown-');
    try {
      await writeFiles(root, {
        '.kimi-code/local.toml': '[subagent-slot.coder]\nmodel = "provider/slot"\nnote = "hi"\n',
      });
      expect(await readWorkspaceSlotBinding(root, 'coder')).toEqual({ model: 'provider/slot' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws CONFIG_INVALID on malformed TOML (v1 parity)', async () => {
    const root = await makeTempDir('slot-badtoml-');
    try {
      await writeFiles(root, {
        '.kimi-code/local.toml': '[subagent-slot.coder]\nmodel = "unterminated\n',
      });
      const error = await readWorkspaceSlotBinding(root, 'coder').catch((e: unknown) => e);
      expect(isError2(error)).toBe(true);
      expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
      expect((error as Error2).message).toContain('Invalid TOML in');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws CONFIG_INVALID on a schema-violating slot entry (v1 parity)', async () => {
    const root = await makeTempDir('slot-badtype-');
    try {
      await writeFiles(root, {
        '.kimi-code/local.toml': '[subagent-slot.coder]\nmodel = 123\n',
      });
      const error = await readWorkspaceSlotBinding(root, 'coder').catch((e: unknown) => e);
      expect(isError2(error)).toBe(true);
      expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
      expect((error as Error2).message).toContain('Invalid workspace local config');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws CONFIG_INVALID when a sibling section violates the v1 whole-file schema', async () => {
    const root = await makeTempDir('slot-sibling-');
    try {
      await writeFiles(root, {
        '.kimi-code/local.toml': '[subagent.other]\nmodel = 123\n',
      });
      const error = await readWorkspaceSlotBinding(root, 'coder').catch((e: unknown) => e);
      expect(isError2(error)).toBe(true);
      expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads the global layer from <OMKC_HOME>/local.toml', async () => {
    const home = await makeTempDir('slot-home-');
    try {
      setGlobalHome(home);
      await writeFiles(home, {
        'local.toml':
          '[subagent-slot.coder]\nmodel = "provider/global-slot"\nthinking_effort = "low"\n',
      });
      const binding = await readGlobalSlotBinding('coder');
      expect(binding).toEqual({ model: 'provider/global-slot', thinkingEffort: 'low' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('falls back to KIMI_CODE_HOME when OMKC_HOME is unset (v1 home chain)', async () => {
    const home = await makeTempDir('slot-kimi-home-');
    try {
      delete process.env['OMKC_HOME'];
      process.env['KIMI_CODE_HOME'] = home;
      await writeFiles(home, {
        'local.toml': '[subagent-slot.coder]\nmodel = "provider/global-slot"\n',
      });
      expect(await readGlobalSlotBinding('coder')).toEqual({ model: 'provider/global-slot' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('returns undefined when the global layer has no entry', async () => {
    const home = await makeTempDir('slot-home-none-');
    try {
      setGlobalHome(home);
      expect(await readGlobalSlotBinding('coder')).toBeUndefined();
      await writeFiles(home, { 'local.toml': '' });
      expect(await readGlobalSlotBinding('coder')).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prefers the workspace layer over the global layer', async () => {
    const root = await makeTempDir('slot-wsg-');
    const home = await makeTempDir('slot-wsg-home-');
    try {
      setGlobalHome(home);
      await writeFiles(root, {
        '.kimi-code/local.toml': '[subagent-slot.coder]\nmodel = "provider/ws-slot"\n',
      });
      await writeFiles(home, {
        'local.toml': '[subagent-slot.coder]\nmodel = "provider/global-slot"\n',
      });
      expect(await readWorkspaceThenGlobalSlotBinding(root, 'coder')).toEqual({
        model: 'provider/ws-slot',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('falls through to the global layer when the workspace layer has no entry', async () => {
    const root = await makeTempDir('slot-wsg2-');
    const home = await makeTempDir('slot-wsg2-home-');
    try {
      setGlobalHome(home);
      await writeFiles(root, {
        '.kimi-code/local.toml': '[subagent-slot.other]\nmodel = "provider/other"\n',
      });
      await writeFiles(home, {
        'local.toml': '[subagent-slot.coder]\nmodel = "provider/global-slot"\n',
      });
      expect(await readWorkspaceThenGlobalSlotBinding(root, 'coder')).toEqual({
        model: 'provider/global-slot',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('returns undefined when neither layer has an entry', async () => {
    const root = await makeTempDir('slot-wsg3-');
    const home = await makeTempDir('slot-wsg3-home-');
    try {
      setGlobalHome(home);
      expect(await readWorkspaceThenGlobalSlotBinding(root, 'coder')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('resolveSubagentBinding (slot layer)', () => {
  function setup(options: {
    agentTypes?: Record<string, { model?: string; thinking?: string }>;
    secondary?: { model?: string; defaultEffort?: string };
    flagEnabled?: boolean;
  }): { config: StubConfigService; flags: IFlagService } {
    const config = new StubConfigService({
      ...(options.agentTypes !== undefined
        ? { [AGENT_TYPES_SECTION]: options.agentTypes }
        : {}),
      ...(options.secondary !== undefined
        ? { [SECONDARY_MODEL_SECTION]: options.secondary }
        : {}),
    });
    const flags = stubFlag(
      (id) => (options.flagEnabled ?? true) && id === SECONDARY_MODEL_FLAG_ID,
    );
    return { config, flags };
  }

  it('uses the slot binding when the profile declares a slot with a model', () => {
    const { config, flags } = setup({});
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder', {
      model: 'provider/slot',
      thinking: 'medium',
    });
    expect(binding).toEqual({ model: 'provider/slot', thinking: 'medium', source: 'slot' });
  });

  it('passes thinking through as undefined when the slot has no thinking', () => {
    const { config, flags } = setup({});
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder', {
      model: 'provider/slot',
    });
    expect(binding).toEqual({ model: 'provider/slot', thinking: undefined, source: 'slot' });
  });

  it('prefers the per-type binding over the slot binding', () => {
    const { config, flags } = setup({ agentTypes: { coder: { model: 'provider/type' } } });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder', {
      model: 'provider/slot',
    });
    expect(binding).toEqual({
      model: 'provider/type',
      thinking: undefined,
      source: 'agent_types',
    });
  });

  it('prefers the slot binding over the secondary model', () => {
    const { config, flags } = setup({ secondary: { model: 'provider/secondary' } });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder', {
      model: 'provider/slot',
      thinking: 'high',
    });
    expect(binding).toEqual({ model: 'provider/slot', thinking: 'high', source: 'slot' });
  });

  it('skips the slot binding for an explicit primary request', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { model: 'provider/type' } },
      secondary: { model: 'provider/secondary' },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, 'primary', 'coder', {
      model: 'provider/slot',
    });
    expect(binding).toEqual({ model: 'caller-model', thinking: 'high', source: 'own' });
  });

  it('skips the slot binding for an explicit secondary request', () => {
    const { config, flags } = setup({ secondary: { model: 'provider/secondary' } });
    const binding = resolveSubagentBinding(config, flags, OWN, 'secondary', 'coder', {
      model: 'provider/slot',
    });
    expect(binding).toEqual({
      model: 'provider/secondary',
      thinking: undefined,
      source: 'secondary',
    });
  });

  it('falls back to secondary when the slot binding has no model', () => {
    const { config, flags } = setup({ secondary: { model: 'provider/secondary' } });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder', {
      thinking: 'high',
    });
    expect(binding).toEqual({
      model: 'provider/secondary',
      thinking: undefined,
      source: 'secondary',
    });
  });

  it('falls back to the caller model when the slot has no model and no secondary is set', () => {
    const { config, flags } = setup({});
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder', {
      thinking: 'high',
    });
    expect(binding).toEqual({ model: 'caller-model', thinking: 'high', source: 'own' });
  });

  it('keeps existing behavior when no slot binding is passed', () => {
    const { config, flags } = setup({ secondary: { model: 'provider/secondary' } });
    expect(resolveSubagentBinding(config, flags, OWN, undefined, 'coder')).toEqual({
      model: 'provider/secondary',
      thinking: undefined,
      source: 'secondary',
    });
  });

  it('applies the slot binding regardless of the secondary-model flag', () => {
    const { config, flags } = setup({
      secondary: { model: 'provider/secondary' },
      flagEnabled: false,
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder', {
      model: 'provider/slot',
    });
    expect(binding).toEqual({ model: 'provider/slot', thinking: undefined, source: 'slot' });
  });
});

describe('wrapSubagentModelError (slot attribution)', () => {
  const CAUSE = new Error2(
    ErrorCodes.CONFIG_INVALID,
    'Model "provider/slot" is not configured in config.toml.',
    { details: { model: 'provider/slot' } },
  );

  it('attributes a missing bound alias to the profile slot', () => {
    const result = wrapSubagentModelError(
      CAUSE,
      'provider/slot',
      'caller-model',
      'slot',
      undefined,
      'coder',
    );
    expect(isError2(result)).toBe(true);
    expect((result as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    expect((result as Error2).message).toContain('[subagent-slot.coder]');
    expect((result as Error2).message).toContain('local.toml');
    expect((result as Error2).details).toMatchObject({
      model: 'provider/slot',
      boundModel: 'provider/slot',
      slotBindingConfig: { section: 'subagent-slot.coder.model', file: 'local.toml' },
    });
  });

  it('leaves the error untouched when the bound model is the caller model', () => {
    expect(
      wrapSubagentModelError(CAUSE, 'caller-model', 'caller-model', 'slot', undefined, 'coder'),
    ).toBe(CAUSE);
  });

  it('leaves the error untouched when it is not a missing bound alias', () => {
    const other = new Error2(
      ErrorCodes.CONFIG_INVALID,
      'Model "provider/x" is not configured in config.toml.',
      { details: { model: 'provider/x' } },
    );
    expect(
      wrapSubagentModelError(other, 'provider/slot', 'caller-model', 'slot', undefined, 'coder'),
    ).toBe(other);
  });

  it('still attributes to agent_types when the source is agent_types', () => {
    const result = wrapSubagentModelError(
      CAUSE,
      'provider/slot',
      'caller-model',
      'agent_types',
      'coder',
    );
    expect((result as Error2).message).toContain('[agent_types.coder]');
    expect((result as Error2).message).not.toContain('subagent-slot');
  });
});
