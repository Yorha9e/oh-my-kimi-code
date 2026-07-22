import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIGRATED_MARKER_FILE,
  SKIP_MARKER_FILE,
  migrateKimiCodeHome,
  rewriteSessionDir,
  runFirstRunHomeMigration,
} from '#/migration/kimi-code-home';

let src: string;
let tgt: string;
const logs: string[] = [];
const log = (m: string): void => {
  logs.push(m);
};

beforeEach(async () => {
  src = await mkdtemp(join(tmpdir(), 'omkc-mig-src-'));
  tgt = join(await mkdtemp(join(tmpdir(), 'omkc-mig-tgt-')), '.omkc');
  logs.length = 0;
});
afterEach(async () => {
  await rm(src, { recursive: true, force: true });
  await rm(join(tgt, '..'), { recursive: true, force: true });
});

async function seedSourceHome(): Promise<void> {
  await writeFile(join(src, 'config.toml'), 'default_model = "k2"\n', 'utf-8');
  await writeFile(join(src, 'tui.toml'), 'theme = "dark"\n', 'utf-8');
  await writeFile(join(src, 'workspaces.json'), '{"workspaces":[]}', 'utf-8');
  await mkdir(join(src, 'credentials'), { recursive: true });
  await writeFile(join(src, 'credentials', 'kimi-code.json'), '{"access_token":"a"}', 'utf-8');
  await mkdir(join(src, 'skills', 'mine'), { recursive: true });
  await writeFile(join(src, 'skills', 'mine', 'SKILL.md'), '# mine\n', 'utf-8');
  await mkdir(join(src, 'sessions', 'bucket1', 'sess-1'), { recursive: true });
  await writeFile(join(src, 'sessions', 'bucket1', 'sess-1', 'wire.jsonl'), '{}\n', 'utf-8');
  await mkdir(join(src, 'bin'), { recursive: true });
  await writeFile(join(src, 'bin', 'rg.exe'), 'RG', 'utf-8');
  await writeFile(
    join(src, 'session_index.jsonl'),
    `${JSON.stringify({ sessionDir: join(src, 'sessions', 'bucket1', 'sess-1'), workDir: '/w' })}\n` +
      '{"sessionDir": 123}\n' +
      'not-json-at-all\n',
    'utf-8',
  );
  // Entries that must NOT be copied.
  await writeFile(join(src, 'device_id'), 'dev-1', 'utf-8');
  await writeFile(join(src, 'server.token'), 'tok', 'utf-8');
  await mkdir(join(src, 'server'), { recursive: true });
  await writeFile(join(src, 'server', 'lock'), '{}', 'utf-8');
  await mkdir(join(src, 'cache'), { recursive: true });
  await writeFile(join(src, 'cache', 'x'), 'x', 'utf-8');
  await mkdir(join(src, 'skills_backup_20240101'), { recursive: true });
  await writeFile(join(src, 'skills_backup_20240101', 'SKILL.md'), '# old\n', 'utf-8');
  await writeFile(join(src, 'bin', 'kimi.exe'), 'K', 'utf-8');
}

describe('migrateKimiCodeHome', () => {
  it('copies the allowlist, skips excluded entries, rewrites session_index', async () => {
    await seedSourceHome();
    const summary = await migrateKimiCodeHome({ sourceHome: src, targetHome: tgt, log });

    expect(await readFile(join(tgt, 'config.toml'), 'utf-8')).toContain('default_model');
    expect(await readFile(join(tgt, 'tui.toml'), 'utf-8')).toContain('dark');
    expect(await readFile(join(tgt, 'credentials', 'kimi-code.json'), 'utf-8')).toContain('"a"');
    expect(await readFile(join(tgt, 'skills', 'mine', 'SKILL.md'), 'utf-8')).toContain('mine');
    expect(await readFile(join(tgt, 'sessions', 'bucket1', 'sess-1', 'wire.jsonl'), 'utf-8')).toBe(
      '{}\n',
    );
    expect(await readFile(join(tgt, 'bin', 'rg.exe'), 'utf-8')).toBe('RG');
    expect(await readFile(join(tgt, 'workspaces.json'), 'utf-8')).toContain('workspaces');

    // Excluded entries stay behind.
    expect(existsSync(join(tgt, 'device_id'))).toBe(false);
    expect(existsSync(join(tgt, 'server.token'))).toBe(false);
    expect(existsSync(join(tgt, 'server'))).toBe(false);
    expect(existsSync(join(tgt, 'cache'))).toBe(false);
    expect(existsSync(join(tgt, 'skills_backup_20240101'))).toBe(false);
    expect(existsSync(join(tgt, 'bin', 'kimi.exe'))).toBe(false);

    // session_index: good line rewritten, non-string sessionDir kept, bad line dropped.
    const lines = (await readFile(join(tgt, 'session_index.jsonl'), 'utf-8'))
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { sessionDir: string };
    expect(first.sessionDir).toBe(join(tgt, 'sessions', 'bucket1', 'sess-1'));
    expect(first.sessionDir).not.toContain('.kimi-code');
    expect(summary.sessionIndexRewritten).toBe(1);
    expect(summary.sessionIndexBadLines).toBe(1);

    // Source untouched (copy, not move).
    expect(existsSync(join(src, 'config.toml'))).toBe(true);
    expect(existsSync(join(src, 'sessions', 'bucket1', 'sess-1', 'wire.jsonl'))).toBe(true);
  });

  it('skips sessions files with mtime later than the migration start', async () => {
    await seedSourceHome();
    const startedAtMs = Date.now() - 60_000;
    // Backdate the normal session file so only `fresh.jsonl` counts as in-flight.
    const old = new Date(startedAtMs - 60_000);
    await utimes(join(src, 'sessions', 'bucket1', 'sess-1', 'wire.jsonl'), old, old);
    const fresh = join(src, 'sessions', 'bucket1', 'sess-1', 'fresh.jsonl');
    await writeFile(fresh, 'fresh\n', 'utf-8');
    const now = new Date();
    await utimes(fresh, now, now);

    const summary = await migrateKimiCodeHome({
      sourceHome: src,
      targetHome: tgt,
      log,
      startedAtMs,
    });

    expect(summary.skippedFresh).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(tgt, 'sessions', 'bucket1', 'sess-1', 'fresh.jsonl'))).toBe(false);
    expect(existsSync(join(tgt, 'sessions', 'bucket1', 'sess-1', 'wire.jsonl'))).toBe(true);
  });

  it('never overwrites existing target files', async () => {
    await seedSourceHome();
    await mkdir(tgt, { recursive: true });
    await writeFile(join(tgt, 'config.toml'), 'default_model = "mine"\n', 'utf-8');

    const summary = await migrateKimiCodeHome({ sourceHome: src, targetHome: tgt, log });

    expect(await readFile(join(tgt, 'config.toml'), 'utf-8')).toContain('mine');
    expect(summary.skippedExisting).toBeGreaterThanOrEqual(1);
  });
});

describe('runFirstRunHomeMigration', () => {
  it('writes the marker and is idempotent on the second run', async () => {
    await seedSourceHome();

    await runFirstRunHomeMigration({ sourceHome: src, targetHome: tgt, log });
    expect(existsSync(join(tgt, MIGRATED_MARKER_FILE))).toBe(true);
    const marker = JSON.parse(await readFile(join(tgt, MIGRATED_MARKER_FILE), 'utf-8')) as {
      sourceHome: string;
      summary: { copiedFiles: number };
    };
    expect(marker.sourceHome).toBe(src);
    expect(marker.summary.copiedFiles).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('migration complete'))).toBe(true);

    // Second run: marker suppresses any further work.
    logs.length = 0;
    await rm(join(tgt, 'config.toml'));
    await runFirstRunHomeMigration({ sourceHome: src, targetHome: tgt, log });
    expect(existsSync(join(tgt, 'config.toml'))).toBe(false);
    expect(logs).toHaveLength(0);
  });

  it('does nothing when the source home is missing', async () => {
    await runFirstRunHomeMigration({ sourceHome: join(src, 'nope'), targetHome: tgt, log });
    expect(existsSync(join(tgt, MIGRATED_MARKER_FILE))).toBe(false);
    expect(logs).toHaveLength(0);
  });

  it('does nothing when the user skip marker exists in the source home', async () => {
    await seedSourceHome();
    await writeFile(join(src, SKIP_MARKER_FILE), '', 'utf-8');
    await runFirstRunHomeMigration({ sourceHome: src, targetHome: tgt, log });
    expect(existsSync(join(tgt, MIGRATED_MARKER_FILE))).toBe(false);
    expect(existsSync(join(tgt, 'config.toml'))).toBe(false);
  });

  it('does nothing when source and target resolve to the same path', async () => {
    await seedSourceHome();
    await runFirstRunHomeMigration({ sourceHome: src, targetHome: src, log });
    expect(existsSync(join(src, MIGRATED_MARKER_FILE))).toBe(false);
  });

  it('swallows failures as a warning instead of throwing', async () => {
    await seedSourceHome();
    // Force a failure: session_index is a directory, so readFile throws.
    await rm(join(src, 'session_index.jsonl'));
    await mkdir(join(src, 'session_index.jsonl'));
    await expect(
      runFirstRunHomeMigration({ sourceHome: src, targetHome: tgt, log }),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('warning: migration'))).toBe(true);
  });
});

describe('rewriteSessionDir', () => {
  it('rewrites the source-home prefix', () => {
    expect(rewriteSessionDir('/home/u/.kimi-code/sessions/b/s', '/home/u/.kimi-code', '/home/u/.omkc')).toBe(
      '/home/u/.omkc/sessions/b/s',
    );
  });

  it('rewrites windows-style separators preserving backslashes', () => {
    expect(
      rewriteSessionDir('C:\\Users\\u\\.kimi-code\\sessions\\b\\s', 'C:\\Users\\u\\.kimi-code', 'C:\\Users\\u\\.omkc'),
    ).toBe('C:\\Users\\u\\.omkc\\sessions\\b\\s');
  });

  it('falls back to segment replacement for differently-spelled homes', () => {
    expect(rewriteSessionDir('/other/mount/.kimi-code/sessions/x', '/home/u/.kimi-code', '/home/u/.omkc')).toBe(
      '/other/mount/.omkc/sessions/x',
    );
  });

  it('leaves unrelated paths untouched', () => {
    expect(rewriteSessionDir('/work/dir/sessions/x', '/home/u/.kimi-code', '/home/u/.omkc')).toBe(
      '/work/dir/sessions/x',
    );
  });
});
