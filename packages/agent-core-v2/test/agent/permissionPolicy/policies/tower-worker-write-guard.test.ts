import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { ToolCall } from '#/kosong/contract/message';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { TowerWorkerWriteGuardPermissionPolicyService } from '#/agent/permissionPolicy/policies/tower-worker-write-guard';
import type { ToolAccesses } from '#/tool/toolContract';
import { afterEach, describe, expect, it } from 'vitest';

const signal = new AbortController().signal;

interface Layout {
  readonly root: string;
  readonly repoRoot: string;
  readonly worktreesDir: string;
  readonly slot: string;
  readonly mirrorFile: string;
}

function makeLayout(repoName = 'my-repo'): Layout {
  const root = mkdtempSync(join(tmpdir(), 'tower-guard-v2-'));
  const repoRoot = join(root, repoName);
  mkdirSync(repoRoot, { recursive: true });
  const worktreesDir = join(root, `${repoName}-worktrees`);
  const slot = join(worktreesDir, 'slot-1');
  return { root, repoRoot, worktreesDir, slot, mirrorFile: join(repoRoot, '.tower-guard.json') };
}

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function writeMirror(layout: Layout, agentId: string, worktree: string | null): void {
  writeFileSync(
    layout.mirrorFile,
    JSON.stringify({
      version: 1,
      repoRoot: layout.repoRoot,
      updatedAt: new Date().toISOString(),
      agents: {
        worker: { name: 'worker', worktree, agentId },
      },
      worktrees: [layout.slot],
    }),
    'utf8',
  );
}

function makePolicy(options: {
  readonly profileName?: string;
  readonly agentId?: string;
  readonly workDir?: string;
  readonly pathClass?: 'posix' | 'win32';
}): TowerWorkerWriteGuardPermissionPolicyService {
  const profile = {
    data: () => ({ profileName: options.profileName ?? 'tower-worker' }),
  };
  const scopeContext = { agentId: options.agentId ?? 'worker-1' };
  const workspace = { workDir: options.workDir ?? '' };
  const env = {
    pathClass: options.pathClass ?? (process.platform === 'win32' ? 'win32' : 'posix'),
  };
  return new TowerWorkerWriteGuardPermissionPolicyService(
    profile as never,
    scopeContext as never,
    workspace as never,
    env as never,
  );
}

function policyContext(
  toolName: string,
  args: Record<string, unknown>,
  accesses: ToolAccesses,
): ResolvedToolExecutionHookContext {
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {},
    args,
    toolCall: {
      type: 'function',
      id: `call_${toolName}`,
      name: toolName,
      arguments: JSON.stringify(args),
    } satisfies ToolCall,
    toolCalls: [
      {
        type: 'function',
        id: `call_${toolName}`,
        name: toolName,
        arguments: JSON.stringify(args),
      },
    ],
    execution: {
      accesses,
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as ResolvedToolExecutionHookContext;
}

function writeAccesses(path: string): ToolAccesses {
  return [{ kind: 'file', operation: 'write', path }];
}

describe('TowerWorkerWriteGuardPermissionPolicyService', () => {
  it('allows Write inside the own worktree', async () => {
    const layout = makeLayout();
    cleanup.push(layout.root);
    writeMirror(layout, 'worker-1', layout.slot);

    const policy = makePolicy({ workDir: layout.slot, agentId: 'worker-1' });
    const inside = join(layout.slot, 'src', 'a.ts');
    await expect(
      policy.evaluate(policyContext('Write', { path: inside, content: 'x' }, writeAccesses(inside))),
    ).resolves.toBeUndefined();
  });

  it('denies Write escaping the worktree with moa_tower_ tool names in the message', async () => {
    const layout = makeLayout();
    cleanup.push(layout.root);
    writeMirror(layout, 'worker-1', layout.slot);

    const policy = makePolicy({ workDir: layout.slot, agentId: 'worker-1' });
    const escape = join(layout.repoRoot, 'src', 'main.ts');
    const result = await policy.evaluate(
      policyContext('Write', { path: escape, content: 'x' }, writeAccesses(escape)),
    );
    if (result?.kind !== 'deny') throw new Error('expected deny');
    expect(result.message).toContain(escape);
    expect(result.message).toContain('moa_tower_finding');
    expect(result.message).toContain('moa_tower_send');
  });

  it('denies Edit escaping the worktree', async () => {
    const layout = makeLayout();
    cleanup.push(layout.root);
    writeMirror(layout, 'worker-1', layout.slot);

    const policy = makePolicy({ workDir: layout.slot, agentId: 'worker-1' });
    const escape = join(layout.worktreesDir, 'slot-2', 'a.ts');
    const result = await policy.evaluate(
      policyContext(
        'Edit',
        { path: escape, old_string: 'a', new_string: 'b' },
        writeAccesses(escape),
      ),
    );
    expect(result?.kind).toBe('deny');
  });

  it('fails open (allows) when the guard mirror does not exist', async () => {
    const layout = makeLayout();
    cleanup.push(layout.root);

    const policy = makePolicy({ workDir: layout.slot, agentId: 'worker-1' });
    const escape = join(layout.repoRoot, 'src', 'main.ts');
    await expect(
      policy.evaluate(policyContext('Write', { path: escape, content: 'x' }, writeAccesses(escape))),
    ).resolves.toBeUndefined();
  });

  it('fails open when the mirror is malformed JSON', async () => {
    const layout = makeLayout();
    cleanup.push(layout.root);
    writeFileSync(layout.mirrorFile, '{not json', 'utf8');

    const policy = makePolicy({ workDir: layout.slot, agentId: 'worker-1' });
    const escape = join(layout.repoRoot, 'src', 'main.ts');
    await expect(
      policy.evaluate(policyContext('Write', { path: escape, content: 'x' }, writeAccesses(escape))),
    ).resolves.toBeUndefined();
  });

  it('fails open when no mirror entry matches the agentId', async () => {
    const layout = makeLayout();
    cleanup.push(layout.root);
    writeMirror(layout, 'some-other-agent', layout.slot);

    const policy = makePolicy({ workDir: layout.slot, agentId: 'worker-1' });
    const escape = join(layout.repoRoot, 'src', 'main.ts');
    await expect(
      policy.evaluate(policyContext('Write', { path: escape, content: 'x' }, writeAccesses(escape))),
    ).resolves.toBeUndefined();
  });

  it('ignores pending entries with agentId null', async () => {
    const layout = makeLayout();
    cleanup.push(layout.root);
    writeFileSync(
      layout.mirrorFile,
      JSON.stringify({
        version: 1,
        repoRoot: layout.repoRoot,
        updatedAt: new Date().toISOString(),
        agents: {
          pending: { name: 'pending', worktree: layout.slot, agentId: null },
        },
        worktrees: [layout.slot],
      }),
      'utf8',
    );

    const policy = makePolicy({ workDir: layout.slot, agentId: 'worker-1' });
    const escape = join(layout.repoRoot, 'src', 'main.ts');
    await expect(
      policy.evaluate(policyContext('Write', { path: escape, content: 'x' }, writeAccesses(escape))),
    ).resolves.toBeUndefined();
  });

  it('allows when profileName is not tower-worker', async () => {
    const layout = makeLayout();
    cleanup.push(layout.root);
    writeMirror(layout, 'worker-1', layout.slot);

    const policy = makePolicy({ profileName: 'main', workDir: layout.slot, agentId: 'worker-1' });
    const escape = join(layout.repoRoot, 'src', 'main.ts');
    await expect(
      policy.evaluate(policyContext('Write', { path: escape, content: 'x' }, writeAccesses(escape))),
    ).resolves.toBeUndefined();
  });

  it('fails open when the matched entry has a null worktree (B3-4)', async () => {
    const layout = makeLayout();
    cleanup.push(layout.root);
    writeMirror(layout, 'worker-1', null);

    const policy = makePolicy({ workDir: layout.slot, agentId: 'worker-1' });
    const escape = join(layout.repoRoot, 'src', 'main.ts');
    await expect(
      policy.evaluate(policyContext('Write', { path: escape, content: 'x' }, writeAccesses(escape))),
    ).resolves.toBeUndefined();
  });

  it('fails open when the matched entry has an empty worktree', async () => {
    const layout = makeLayout();
    cleanup.push(layout.root);
    writeMirror(layout, 'worker-1', '');

    const policy = makePolicy({ workDir: layout.slot, agentId: 'worker-1' });
    const escape = join(layout.repoRoot, 'src', 'main.ts');
    await expect(
      policy.evaluate(policyContext('Write', { path: escape, content: 'x' }, writeAccesses(escape))),
    ).resolves.toBeUndefined();
  });

  it('fails open when the matched entry has a relative worktree (B3R-1)', async () => {
    const layout = makeLayout();
    cleanup.push(layout.root);
    writeMirror(layout, 'worker-1', 'slot-1');

    const policy = makePolicy({ workDir: layout.slot, agentId: 'worker-1' });
    const escape = join(layout.repoRoot, 'src', 'main.ts');
    await expect(
      policy.evaluate(policyContext('Write', { path: escape, content: 'x' }, writeAccesses(escape))),
    ).resolves.toBeUndefined();
  });

  it('fails open when cwd does not follow the -worktrees layout convention', async () => {
    const layout = makeLayout();
    cleanup.push(layout.root);
    writeMirror(layout, 'worker-1', layout.slot);

    const policy = makePolicy({ workDir: layout.repoRoot, agentId: 'worker-1' });
    const escape = join(layout.repoRoot, 'src', 'main.ts');
    await expect(
      policy.evaluate(policyContext('Write', { path: escape, content: 'x' }, writeAccesses(escape))),
    ).resolves.toBeUndefined();
  });

  it('ignores tools other than Write/Edit', async () => {
    const layout = makeLayout();
    cleanup.push(layout.root);
    writeMirror(layout, 'worker-1', layout.slot);

    const policy = makePolicy({ workDir: layout.slot, agentId: 'worker-1' });
    await expect(
      policy.evaluate(policyContext('Bash', { command: 'echo hi' }, [])),
    ).resolves.toBeUndefined();
  });
});
