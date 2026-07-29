import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { SECONDARY_MODEL_SECTION } from '#/app/kosongConfig/configSection';
import { IFlagService } from '#/app/flag/flag';
import { ILogService } from '#/_base/log/log';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  AGENT_TYPES_SECTION,
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
