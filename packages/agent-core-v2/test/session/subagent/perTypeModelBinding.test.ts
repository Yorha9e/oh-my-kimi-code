import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { SECONDARY_MODEL_SECTION, MODELS_SECTION } from '#/app/kosongConfig/configSection';
import '#/app/kosongConfig/agentTypesOverlay';
import { IFlagService } from '#/app/flag/flag';
import { ILogService } from '#/_base/log/log';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  AGENT_TYPES_SECTION,
  agentTypeDerivedModelId,
  agentTypePatch,
  isAgentTypeDerivedModelId,
  resolveSubagentBinding,
} from '#/session/subagent/configSection';
import { SECONDARY_MODEL_FLAG_ID } from '#/session/subagent/flag';

import { stubBootstrap } from '../../app/bootstrap/stubs';
import { stubFlag } from '../../app/flag/stubs';
import { stubLog } from '../../_base/log/stubs';
import { StubConfigService } from '../../kosong/stubs';

const OWN = { modelAlias: 'caller-model', thinkingLevel: 'high' };

describe('resolveSubagentBinding (per-type model binding)', () => {
  function setup(options: {
    agentTypes?: Record<string, { model?: string; thinking?: string; maxOutputSize?: number; defaultEffort?: string; [key: string]: unknown }>;
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

  it('falls back to the caller model when no config is set', () => {
    const { config, flags } = setup({});
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder');
    expect(binding).toEqual({ model: 'caller-model', thinking: 'high', source: 'own' });
  });

  it('uses the per-type binding when the type has a model', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { model: 'provider/coder', thinking: 'medium' } },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder');
    expect(binding).toEqual({
      model: 'provider/coder',
      thinking: 'medium',
      source: 'agent_types',
    });
  });

  it('skips per-type and returns the caller model for an explicit primary request', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { model: 'provider/coder', thinking: 'medium' } },
      secondary: { model: 'provider/secondary' },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, 'primary', 'coder');
    expect(binding).toEqual({ model: 'caller-model', thinking: 'high', source: 'own' });
  });

  it('skips per-type and returns the secondary model for an explicit secondary request', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { model: 'provider/coder', thinking: 'medium' } },
      secondary: { model: 'provider/secondary' },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, 'secondary', 'coder');
    expect(binding).toEqual({
      model: 'provider/secondary',
      thinking: undefined,
      source: 'secondary',
    });
  });

  it('prefers per-type over secondary when no explicit choice is made', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { model: 'provider/coder', thinking: 'medium' } },
      secondary: { model: 'provider/secondary' },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder');
    expect(binding).toEqual({
      model: 'provider/coder',
      thinking: 'medium',
      source: 'agent_types',
    });
  });

  it('falls back to secondary when per-type is not configured for the requested type', () => {
    const { config, flags } = setup({
      agentTypes: { reviewer: { model: 'provider/reviewer' } },
      secondary: { model: 'provider/secondary' },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder');
    expect(binding).toEqual({
      model: 'provider/secondary',
      thinking: undefined,
      source: 'secondary',
    });
  });

  it('falls back to the caller model when neither per-type nor secondary is configured', () => {
    const { config, flags } = setup({
      agentTypes: { reviewer: { model: 'provider/reviewer' } },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder');
    expect(binding).toEqual({ model: 'caller-model', thinking: 'high', source: 'own' });
  });

  it('falls back to secondary when per-type has only thinking but no model', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { thinking: 'medium' } },
      secondary: { model: 'provider/secondary' },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder');
    expect(binding).toEqual({
      model: 'provider/secondary',
      thinking: undefined,
      source: 'secondary',
    });
  });

  it('falls back to the caller model when per-type has only thinking, no model, and no secondary', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { thinking: 'medium' } },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder');
    expect(binding).toEqual({ model: 'caller-model', thinking: 'high', source: 'own' });
  });

  it('uses per-type model with undefined thinking when only model is set', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { model: 'provider/coder' } },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder');
    expect(binding).toEqual({
      model: 'provider/coder',
      thinking: undefined,
      source: 'agent_types',
    });
  });

  it('ignores per-type when profileType is not provided', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { model: 'provider/coder' } },
      secondary: { model: 'provider/secondary' },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, undefined);
    expect(binding).toEqual({
      model: 'provider/secondary',
      thinking: undefined,
      source: 'secondary',
    });
  });

  it('still applies per-type when the secondary-model flag is disabled', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { model: 'provider/coder' } },
      secondary: { model: 'provider/secondary' },
      flagEnabled: false,
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder');
    expect(binding).toEqual({
      model: 'provider/coder',
      thinking: undefined,
      source: 'agent_types',
    });
  });

  it('falls back to the caller model when the flag is disabled and no per-type is configured', () => {
    const { config, flags } = setup({
      secondary: { model: 'provider/secondary' },
      flagEnabled: false,
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder');
    expect(binding).toEqual({ model: 'caller-model', thinking: 'high', source: 'own' });
  });
});

describe('agentTypes TOML key preservation (real ConfigService pipeline)', () => {
  // Creates a ConfigService backed by in-memory TOML storage so we exercise
  // the real fromToml/toToml transforms (StubConfigService bypasses TOML entirely).
  async function createTomlConfig(tomlContent: string): Promise<{
    config: IConfigService;
    disposables: DisposableStore;
    storage: InMemoryStorageService;
  }> {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    if (tomlContent.length > 0) {
      await storage.write('', 'config.toml', new TextEncoder().encode(tomlContent));
    }
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', {}));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables, storage };
  }

  it('preserves snake_case type names (e.g. code_reviewer) when parsing TOML', async () => {
    const { config, disposables } = await createTomlConfig(
      '[agent_types.code_reviewer]\nmodel = "provider/reviewer"\nthinking = "high"\n',
    );

    const agentTypes = config.get<Record<string, { model?: string; thinking?: string }>>(
      AGENT_TYPES_SECTION,
    );

    // The key must remain `code_reviewer`, NOT be transformed to `codeReviewer`.
    expect(agentTypes).toHaveProperty('code_reviewer');
    expect(agentTypes).not.toHaveProperty('codeReviewer');
    expect(agentTypes!['code_reviewer']).toEqual({
      model: 'provider/reviewer',
      thinking: 'high',
    });

    disposables.dispose();
  });

  it('preserves simple type names without underscores (e.g. coder)', async () => {
    const { config, disposables } = await createTomlConfig(
      '[agent_types.coder]\nmodel = "provider/coder"\n',
    );

    const agentTypes = config.get<Record<string, { model?: string }>>(AGENT_TYPES_SECTION);
    expect(agentTypes).toHaveProperty('coder');
    expect(agentTypes!['coder']).toEqual({ model: 'provider/coder' });

    disposables.dispose();
  });

  it('round-trips snake_case type names via set() without corrupting keys', async () => {
    const { config, disposables, storage } = await createTomlConfig('');

    await config.set(AGENT_TYPES_SECTION, {
      code_reviewer: { model: 'provider/reviewer', thinking: 'medium' },
      coder: { model: 'provider/coder' },
    });

    // In-memory key must be preserved.
    const afterSet = config.get<Record<string, { model?: string; thinking?: string }>>(
      AGENT_TYPES_SECTION,
    );
    expect(afterSet).toHaveProperty('code_reviewer');
    expect(afterSet).not.toHaveProperty('codeReviewer');
    expect(afterSet!['code_reviewer']).toEqual({
      model: 'provider/reviewer',
      thinking: 'medium',
    });

    // On-disk TOML must also use the original key (agent_types.code_reviewer).
    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(onDisk).toContain('[agent_types.code_reviewer]');
    expect(onDisk).toContain('model = "provider/reviewer"');
    expect(onDisk).toContain('thinking = "medium"');
    expect(onDisk).toContain('[agent_types.coder]');
    expect(onDisk).not.toContain('codeReviewer');

    disposables.dispose();
  });

  it('resolveSubagentBinding finds snake_case type entries from TOML', async () => {
    const { config, disposables } = await createTomlConfig(
      '[agent_types.code_reviewer]\nmodel = "provider/reviewer"\n',
    );
    const flags = stubFlag(() => false);

    const binding = resolveSubagentBinding(
      config,
      flags,
      { modelAlias: 'caller-model', thinkingLevel: 'high' },
      undefined,
      'code_reviewer',
    );

    expect(binding).toEqual({
      model: 'provider/reviewer',
      thinking: undefined,
      source: 'agent_types',
    });

    disposables.dispose();
  });
});

describe('resolveSubagentBinding (per-type patch entries)', () => {
  function setup(options: {
    agentTypes?: Record<string, { model?: string; thinking?: string; [key: string]: unknown }>;
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

  // Checklist 1: no-patch entries behave byte-identically (regression).
  it('returns the original model for a pointer-only entry (no patch)', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { model: 'provider/coder', thinking: 'medium' } },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder');
    expect(binding).toEqual({
      model: 'provider/coder',
      thinking: 'medium',
      source: 'agent_types',
    });
  });

  // Checklist 2: patch entries return the derived id.
  it('returns the derived id when the entry has patch fields', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { model: 'provider/coder', maxOutputSize: 8192 } },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder');
    expect(binding.model).toBe(agentTypeDerivedModelId('coder'));
    expect(binding.source).toBe('agent_types');
  });

  it('returns the derived id when only a single patch field is set', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { model: 'provider/coder', defaultEffort: 'low' } },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder');
    expect(binding.model).toBe(agentTypeDerivedModelId('coder'));
  });

  // thinking (binding layer) takes priority over patch default_effort.
  it('passes binding-layer thinking even when patch has default_effort', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { model: 'provider/coder', thinking: 'high', defaultEffort: 'low' } },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder');
    // thinking='high' wins; the derived id is still returned (patch is present).
    expect(binding.model).toBe(agentTypeDerivedModelId('coder'));
    expect(binding.thinking).toBe('high');
  });

  it('passes undefined thinking when only patch default_effort is set', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { model: 'provider/coder', defaultEffort: 'low' } },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'coder');
    expect(binding.model).toBe(agentTypeDerivedModelId('coder'));
    // thinking is undefined - the derived entry's default_effort is the fallback.
    expect(binding.thinking).toBeUndefined();
  });

  // Chain guard: the overlay refuses to synthesize a derived entry whose base
  // is itself a derived id, so a patch-bearing entry pointing at
  // `__agent_type_*__` binds the pointed (already-derived) entry directly
  // instead of producing a dangling id.
  it('binds the base directly when a patch entry points at a derived id', () => {
    const { config, flags } = setup({
      agentTypes: {
        a: { model: 'provider/a', maxOutputSize: 8192 },
        b: { model: agentTypeDerivedModelId('a'), maxOutputSize: 4096 },
      },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, undefined, 'b');
    expect(binding.model).toBe(agentTypeDerivedModelId('a'));
    expect(binding.source).toBe('agent_types');
  });

  it('skips per-type patch for an explicit primary request', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { model: 'provider/coder', maxOutputSize: 8192 } },
      secondary: { model: 'provider/secondary' },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, 'primary', 'coder');
    expect(binding).toEqual({ model: 'caller-model', thinking: 'high', source: 'own' });
  });

  it('skips per-type patch for an explicit secondary request', () => {
    const { config, flags } = setup({
      agentTypes: { coder: { model: 'provider/coder', maxOutputSize: 8192 } },
      secondary: { model: 'provider/secondary' },
    });
    const binding = resolveSubagentBinding(config, flags, OWN, 'secondary', 'coder');
    expect(binding.model).toBe('provider/secondary');
    expect(binding.source).toBe('secondary');
  });

  it('agentTypePatch returns undefined for pointer-only entries', () => {
    expect(agentTypePatch({ model: 'k2' })).toBeUndefined();
    expect(agentTypePatch({ model: 'k2', thinking: 'high' })).toBeUndefined();
    expect(agentTypePatch(undefined)).toBeUndefined();
  });

  it('agentTypePatch returns the patch for entries with extra fields', () => {
    expect(agentTypePatch({ model: 'k2', maxOutputSize: 8192 })).toEqual({ maxOutputSize: 8192 });
    expect(agentTypePatch({ model: 'k2', thinking: 'high', defaultEffort: 'low' })).toEqual({
      defaultEffort: 'low',
    });
  });

  it('isAgentTypeDerivedModelId recognizes the derived id pattern', () => {
    expect(isAgentTypeDerivedModelId('__agent_type_coder__')).toBe(true);
    expect(isAgentTypeDerivedModelId('__agent_type_code_reviewer__')).toBe(true);
    expect(isAgentTypeDerivedModelId('__secondary__')).toBe(false);
    expect(isAgentTypeDerivedModelId('provider/coder')).toBe(false);
    expect(isAgentTypeDerivedModelId('__agent_type_coder')).toBe(false);
  });
});

describe('per-type patch TOML round-trip (real ConfigService pipeline)', () => {
  async function createTomlConfig(tomlContent: string): Promise<{
    config: IConfigService;
    disposables: DisposableStore;
    storage: InMemoryStorageService;
  }> {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    if (tomlContent.length > 0) {
      await storage.write('', 'config.toml', new TextEncoder().encode(tomlContent));
    }
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', {}));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables, storage };
  }

  // Checklist 3: config.toml round-trip leaves no derived id on disk, but
  // preserves the patch fields under [agent_types.<type>].
  it('preserves patch fields on disk without writing derived ids to [models]', async () => {
    const { config, disposables, storage } = await createTomlConfig(
      '[models.k2]\nprovider = "kimi"\nmodel = "kimi-k2"\nmax_context_size = 262144\n',
    );

    await config.set(AGENT_TYPES_SECTION, {
      coder: { model: 'k2', maxOutputSize: 8192, defaultEffort: 'low' },
    });

    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    // Patch fields are on disk under [agent_types.coder].
    expect(onDisk).toContain('[agent_types.coder]');
    expect(onDisk).toContain('model = "k2"');
    expect(onDisk).toContain('max_output_size = 8192');
    expect(onDisk).toContain('default_effort = "low"');
    // No derived id in [models].
    expect(onDisk).not.toContain('__agent_type_');

    disposables.dispose();
  });

  it('round-trips a pointer-only entry without patch fields', async () => {
    const { config, disposables, storage } = await createTomlConfig('');

    await config.set(AGENT_TYPES_SECTION, {
      coder: { model: 'provider/coder' },
    });

    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(onDisk).toContain('[agent_types.coder]');
    expect(onDisk).toContain('model = "provider/coder"');
    expect(onDisk).not.toContain('max_output_size');
    expect(onDisk).not.toContain('__agent_type_');

    disposables.dispose();
  });

  // Checklist 4: resume - the overlay reconstructs the derived entry at
  // startup so a derived id recorded in the wire journal re-resolves.
  it('synthesizes the derived entry into the effective models view on load', async () => {
    const { config, disposables } = await createTomlConfig(
      [
        '[models.k2]',
        'provider = "kimi"',
        'model = "kimi-k2"',
        'max_context_size = 262144',
        'default_effort = "medium"',
        '',
        '[agent_types.coder]',
        'model = "k2"',
        'max_output_size = 8192',
        'default_effort = "low"',
      ].join('\n'),
    );

    // The effective models view must contain the derived entry with the
    // patched overrides - this is what the catalog resolves by id during
    // both spawn and resume.
    const models = config.get<Record<string, unknown>>(MODELS_SECTION);
    const derivedId = agentTypeDerivedModelId('coder');
    expect(models[derivedId]).toBeDefined();
    const derived = models[derivedId] as Record<string, unknown>;
    const overrides = derived['overrides'] as Record<string, unknown>;
    expect(overrides['maxOutputSize']).toBe(8192);
    expect(overrides['defaultEffort']).toBe('low');

    // The base entry stays untouched.
    const k2 = models['k2'] as Record<string, unknown>;
    expect(k2['maxOutputSize']).toBeUndefined();

    disposables.dispose();
  });

  it('does not synthesize a derived entry for pointer-only TOML', async () => {
    const { config, disposables } = await createTomlConfig(
      [
        '[models.k2]',
        'provider = "kimi"',
        'model = "kimi-k2"',
        'max_context_size = 262144',
        '',
        '[agent_types.coder]',
        'model = "k2"',
      ].join('\n'),
    );

    const models = config.get<Record<string, unknown>>(MODELS_SECTION);
    expect(models[agentTypeDerivedModelId('coder')]).toBeUndefined();

    disposables.dispose();
  });
});
