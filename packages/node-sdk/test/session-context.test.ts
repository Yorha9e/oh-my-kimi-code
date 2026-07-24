/**
 * Scenario: host-managed context changes through the public Session API.
 * Responsibilities: clear/import behavior, validation, status, and persisted resume.
 * Wiring: real in-process core and filesystem storage; no model boundary is invoked.
 * Run: pnpm exec vitest run packages/node-sdk/test/session-context.test.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LocalKaos, type Environment, type Kaos } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, type KimiError } from '#/index';

import {
  makeTempDir,
  removeTempDirs,
  waitForSDKEvent,
} from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];
const toPosix = (path: string): string => path.replaceAll('\\', '/');

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session context', () => {
  it('round-trips subagent model bindings through the public Session API', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-subagent-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-subagent-work-');
    await writeTestConfig(homeDir, 200_000);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_subagent_binding', workDir });
      await expect(session.getSubagentBindings()).resolves.toEqual({});

      const { configPath } = await session.setSubagentBinding('coder', {
        model: 'test-model',
        thinkingEffort: 'high',
      });
      expect(configPath).toContain('local.toml');
      await expect(session.getSubagentBindings()).resolves.toEqual({
        coder: { model: 'test-model', thinkingEffort: 'high', inherit: undefined },
      });

      await session.setSubagentBinding('coder', undefined);
      await expect(session.getSubagentBindings()).resolves.toEqual({});
    } finally {
      await harness.close();
    }
  });

  it('round-trips global subagent model bindings through the public Session API', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-global-home-');
    const osHomeDir = await makeTempDir(tempDirs, 'kimi-sdk-global-oshome-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-global-work-');
    await writeTestConfig(homeDir, 200_000);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({
        id: 'ses_global_subagent_binding',
        workDir,
        ...kaosWithHome(osHomeDir),
      });
      await expect(session.getGlobalSubagentBindings()).resolves.toEqual({});

      const { configPath } = await session.setGlobalSubagentBinding('coder', {
        model: 'test-model',
        thinkingEffort: 'high',
      });
      expect(toPosix(configPath)).toBe(toPosix(join(osHomeDir, '.omkc', 'local.toml')));
      await expect(session.getGlobalSubagentBindings()).resolves.toEqual({
        coder: { model: 'test-model', thinkingEffort: 'high', inherit: undefined },
      });
      // The workspace layer is untouched by global writes.
      await expect(session.getSubagentBindings()).resolves.toEqual({});

      await session.setGlobalSubagentBinding('coder', undefined);
      await expect(session.getGlobalSubagentBindings()).resolves.toEqual({});
    } finally {
      await harness.close();
    }
  });

  it('lists built-in and user subagent profiles through the public Session API', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-profiles-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-profiles-work-');
    await writeTestConfig(homeDir, 200_000);
    await mkdir(join(homeDir, 'agents'), { recursive: true });
    await writeFile(
      join(homeDir, 'agents', 'debater.md'),
      '---\nname: debater\ndescription: A debate agent\nwhen_to_use: When you need a debate\n---\nArgue both sides.\n',
      'utf8',
    );
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_profiles', workDir });
      const profiles = await session.listSubagentProfiles();
      const byName = new Map(profiles.map((p) => [p.name, p]));

      // Built-in profiles are tagged 'builtin'.
      expect(byName.get('coder')?.source).toBe('builtin');
      expect(byName.get('explore')?.source).toBe('builtin');

      // User profiles appear and are tagged 'user'.
      const debater = byName.get('debater');
      expect(debater?.source).toBe('user');
      expect(debater?.description).toBe('A debate agent');
      expect(debater?.whenToUse).toBe('When you need a debate');
    } finally {
      await harness.close();
    }
  });

  it('restores a session-only additional directory after close and resume', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-additional-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-additional-work-');
    const additionalDir = await makeTempDir(tempDirs, 'kimi-sdk-additional-dir-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_additional_resume', workDir });
      await session.addAdditionalDir(additionalDir, { persist: false });
      await session.close();

      const resumed = await harness.resumeSession({ id: 'ses_additional_resume' });

      expect(resumed.summary?.additionalDirs).toEqual([toPosix(additionalDir)]);
    } finally {
      await harness.close();
    }
  });

  it('clears context without replacing the session', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-context-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-context-work-');
    const additionalDir = await makeTempDir(tempDirs, 'kimi-sdk-context-additional-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_context_clear', workDir });
      await session.addAdditionalDir(additionalDir, { persist: false });
      await expect(session.getContext()).resolves.toMatchObject({
        history: [{ role: 'user' }],
      });

      await session.clearContext();

      expect(session.id).toBe('ses_context_clear');
      await expect(session.getContext()).resolves.toEqual({ history: [], tokenCount: 0 });
    } finally {
      await harness.close();
    }
  });

  it('appends old-compatible user context markup when importing raw content', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-context-import-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-context-import-work-');
    await writeTestConfig(homeDir, 200_000);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_context_import', workDir });

      await session.importContext('Earlier user: keep the API stable.', "file 'notes.md'");

      expect(session.id).toBe('ses_context_import');
      await expect(session.getContext()).resolves.toMatchObject({
        history: [
          {
            role: 'user',
            origin: { kind: 'user' },
            content: [
              {
                type: 'text',
                text:
                  "<system>The user has imported context from file 'notes.md'. " +
                  'This is a prior conversation history that may be relevant to the current session. ' +
                  'Please review this context and use it to inform your responses.</system>',
              },
              {
                type: 'text',
                text:
                  '<imported_context source="file \'notes.md\'">\n' +
                  'Earlier user: keep the API stable.\n' +
                  '</imported_context>',
              },
            ],
          },
        ],
        tokenCount: expect.any(Number),
      });
    } finally {
      await harness.close();
    }
  });

  it('emits the estimated context token status after an import', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-context-status-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-context-status-work-');
    await writeTestConfig(homeDir, 200_000);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_context_status', workDir });
      const status = waitForSDKEvent(
        session,
        (event) =>
          event.type === 'agent.status.updated' && (event.contextTokens ?? 0) > 0,
      );

      await session.importContext('Prior context.', "file 'status.md'");

      await expect(status).resolves.toMatchObject({
        type: 'agent.status.updated',
        maxContextTokens: 200_000,
        contextTokens: expect.any(Number),
      });
      const context = await session.getContext();
      expect(context.tokenCount).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });

  it('restores the imported message with its estimated token count after resume', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-context-resume-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-context-resume-work-');
    await writeTestConfig(homeDir, 200_000);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_context_resume', workDir });
      await session.importContext('A decision from the previous session.', "session 'old-session'");
      const imported = await session.getContext();
      await session.close();

      const resumed = await harness.resumeSession({ id: 'ses_context_resume' });

      await expect(resumed.getContext()).resolves.toEqual(imported);
      expect(resumed.getResumeState()?.agents['main']?.replay).toContainEqual(
        expect.objectContaining({
          type: 'message',
          message: imported.history[0],
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it('rejects whitespace-only imported content without mutating context', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-context-empty-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-context-empty-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_context_empty', workDir });

      await expect(session.importContext(' \n\t ', "file 'empty.md'")).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.invalid',
        details: { reason: 'import_content_empty' },
      } satisfies Partial<KimiError>);
      await expect(session.getContext()).resolves.toEqual({ history: [], tokenCount: 0 });
    } finally {
      await harness.close();
    }
  });

  it('rejects an import that would push existing context beyond the model limit', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-context-overflow-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-context-overflow-work-');
    await writeTestConfig(homeDir, 100);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_context_overflow', workDir });
      await session.importContext('First import.', "file 'first.md'");
      const contextBeforeRejectedImport = await session.getContext();

      await expect(
        session.importContext('Second import.', "file 'second.md'"),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'context.overflow',
        details: {
          reason: 'import_context_overflow',
          currentTokenCount: expect.any(Number),
          maxContextTokens: 100,
        },
      } satisfies Partial<KimiError>);
      await expect(session.getContext()).resolves.toEqual(contextBeforeRejectedImport);
    } finally {
      await harness.close();
    }
  });
});

/**
 * Build a session Kaos pair whose `gethome()` points at a temp directory, so
 * the global `~/.omkc/local.toml` never touches the real home. The
 * wrapper re-wraps `withCwd`/`withEnv` results because `LocalKaos` returns a
 * fresh instance from each of them.
 */
function kaosWithHome(home: string): { kaos: Kaos; persistenceKaos: Kaos } {
  // `LocalKaos`'s constructor is `private` at the TS level only — build a
  // fresh instance with a fixed `osEnv` (same pattern as the agent-core test
  // fixture) instead of probing the host environment.
  const osEnv: Environment = {
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
  };
  type LocalKaosCtor = new (osEnv: Environment) => LocalKaos;
  const inner = new (LocalKaos as unknown as LocalKaosCtor)(osEnv);

  const wrap = (target: Kaos): Kaos =>
    new Proxy(target, {
      get(t, prop, receiver) {
        if (prop === 'gethome') return () => home;
        if (prop === 'withCwd') return (cwd: string) => wrap(t.withCwd(cwd));
        if (prop === 'withEnv') return (env: Record<string, string>) => wrap(t.withEnv(env));
        const value = Reflect.get(t, prop, receiver);
        return typeof value === 'function' ? value.bind(t) : value;
      },
    });

  const kaos = wrap(inner);
  return { kaos, persistenceKaos: kaos };
}

async function writeTestConfig(homeDir: string, maxContextSize: number): Promise<void> {
  await writeFile(
    join(homeDir, 'config.toml'),
    `
default_model = "test-model"

[providers.local]
type = "openai"
base_url = "https://example.test/v1"
api_key = "YOUR_API_KEY"

[models.test-model]
provider = "local"
model = "test-model"
max_context_size = ${String(maxContextSize)}
`,
    'utf-8',
  );
}
