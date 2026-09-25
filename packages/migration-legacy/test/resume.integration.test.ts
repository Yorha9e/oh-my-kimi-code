/**
 * End-to-end check that a migrated session is actually visible to — and
 * inspectable by — agent-core-v2. The migrator writes session buckets named by
 * `computeWorkdirBucket`; v2's session index locates sessions purely by
 * `readdir(encodeWorkDirKey(workDir))` under `<home>/sessions`. If the two
 * bucket algorithms diverged, migrated sessions become silently invisible —
 * these tests fail fast in that case.
 *
 * v2 has no lightweight `Session.resume()` equivalent (session lifecycle is
 * composed through the scoped DI container), so the migrated history and the
 * legacy tool-call displays are asserted directly on the written `wire.jsonl`
 * instead of driving a live resume.
 *
 * agent-core-v2 API used:
 *   - `encodeWorkDirKey` from `@moonshot-ai/agent-core-v2/_base/utils/workdir-slug`
 *   - `listWorkspaceIds` / `listSessionIds` / `readSessionSummary` from
 *     `@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndexSource`
 *     (backed by `FileStorageService` + `JsonAtomicDocumentStore`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeWorkDirKey } from '@moonshot-ai/agent-core-v2/_base/utils/workdir-slug';
import {
  listSessionIds,
  listWorkspaceIds,
  readSessionSummary,
} from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndexSource';
import type { SessionSummary } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import { FileStorageService } from '@moonshot-ai/agent-core-v2/persistence/backends/node-fs/fileStorageService';
import { JsonAtomicDocumentStore } from '@moonshot-ai/agent-core-v2/persistence/backends/node-fs/atomicDocumentStore';

import { migrateOneSession, type MigrateOneResult } from '../src/sessions/migrate-one.js';
import { computeWorkdirBucket } from '../src/sessions/workdir-bucket.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const WORK_DIR = '/Users/example/proj';

let targetHome: string;
beforeEach(async () => {
  targetHome = await mkdtemp(join(tmpdir(), 'resume-integ-'));
});
afterEach(async () => {
  await rm(targetHome, { recursive: true, force: true });
});

/** Authoritative v2 session scan over `<home>/sessions/<bucket>/<id>/state.json`. */
async function listSessionsV2(homeDir: string): Promise<readonly SessionSummary[]> {
  const storage = new FileStorageService(homeDir);
  const docs = new JsonAtomicDocumentStore(storage);
  const out: SessionSummary[] = [];
  for (const workspaceId of await listWorkspaceIds(storage, 'sessions')) {
    for (const sessionId of await listSessionIds(storage, 'sessions', workspaceId)) {
      const summary = await readSessionSummary(docs, 'sessions', workspaceId, sessionId);
      if (summary !== undefined) out.push(summary);
    }
  }
  return out;
}

describe('migrated session is discoverable by agent-core-v2', () => {
  it('computeWorkdirBucket matches v2 encodeWorkDirKey', () => {
    expect(computeWorkdirBucket(WORK_DIR)).toBe(encodeWorkDirKey(WORK_DIR));
  });

  it('v2 authoritative scan finds a migrated session under the same workDir', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'with-tool-calls'),
      oldSessionUuid: 'integ-uuid',
      workdirPath: WORK_DIR,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');

    const sessions = await listSessionsV2(targetHome);
    const migrated = sessions.find((s) => s.id === 'ses_integ-uuid');
    expect(migrated).toBeDefined();
    expect(migrated?.workspaceId).toBe(computeWorkdirBucket(WORK_DIR));
    expect(migrated?.custom?.['imported_from_kimi_cli']).toBe(true);
    expect(migrated?.title).toBeTruthy();
    expect(migrated?.createdAt).toBeGreaterThan(0);
  });

  it('migrated wire history is non-empty', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-resume',
      workdirPath: WORK_DIR,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>)
      .targetDir;

    const wire = await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    const events = wire
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string });
    expect(events[0]?.type).toBe('metadata');
    expect(events.filter((e) => e.type === 'context.append_message').length).toBeGreaterThan(0);
  });

  it('migrated wire carries the full conversation text', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-resume',
      workdirPath: WORK_DIR,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>)
      .targetDir;

    // A live resume replays exactly these records, so asserting on the wire
    // content covers "the migrated history survives" without driving the
    // engine's session lifecycle.
    const wire = await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    expect(wire).toContain('hi');
    expect(wire).toContain('Hello! How can I help?');
  });

  it('migrated wire preserves a legacy todo display', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'large-100msgs'),
      oldSessionUuid: 'todo-display',
      workdirPath: WORK_DIR,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>)
      .targetDir;

    const wire = await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    expect(wire).toContain('tool_y3SXWWQIUysddnYoklaWhUeE');
    expect(wire).toContain('todo_list');
    expect(wire).toContain('准备测试环境（创建隔离 work-dir）');
    expect(wire).toContain('汇报结论');
  });
});
