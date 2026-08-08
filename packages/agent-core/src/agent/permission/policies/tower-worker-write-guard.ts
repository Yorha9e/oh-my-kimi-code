import { basename, dirname, join } from 'node:path';

import * as pathe from 'pathe';

import type { Agent } from '../..';
import { isWithinDirectory } from '../../../tools/policies/path-access';
import type {
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
} from '../types';
import { writeFileAccesses } from './file-access-ask';
import {
  readTowerGuardMirror,
  type TowerGuardMirror,
  type TowerGuardMirrorAgentEntry,
} from './tower-guard-mirror';

/**
 * tower-worker agents are confined to their own worktree: TowerSpawn sets
 * the agent's cwd to the worktree, and this guard denies any Write/Edit whose
 * target escapes it — including absolute paths, which the workspace guard
 * otherwise lets through to the ask fallback. The main checkout and sibling
 * agents' slots are therefore unreachable for edits; out-of-scope changes go
 * through moa_tower_finding / the tower instead.
 *
 * Bash commands with absolute escape paths remain a briefing-level rule (the
 * Bash tool reports no file accesses to match against) — Bash redirection
 * escapes are NOT intercepted, matching the official v1 guard.
 *
 * The worktree comes from the guard mirror `<repoRoot>/.tower-guard.json`
 * written by the moamcp tower controller. Layout convention: the worker cwd
 * is `<repoRoot>`-sibling `<repoName>-worktrees/<slot>`, so the repo root is
 * reverse-located from `cwd` — `dirname(cwd)` must end in `-worktrees` and
 * exactly ONE trailing `-worktrees` suffix is stripped (a repo whose own name
 * ends in `-worktrees` still resolves). Any deviation from this layout, or
 * any mirror read failure, fails open (no interception).
 */
export class TowerWorkerWriteGuardPermissionPolicy implements PermissionPolicy {
  readonly name = 'tower-worker-write-guard-deny';

  constructor(private readonly agent: Agent) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    if (this.agent.config?.profileName !== 'tower-worker') return;
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return;

    const repoRoot = reverseRepoRoot(this.agent.config.cwd);
    if (repoRoot === undefined) return;
    const mirror = await readTowerGuardMirror(repoRoot);
    if (mirror === undefined) return;

    // Best-effort agent id derived from the agent homedir
    // (`…/agents/<id>`, same allocation source the tower writes as agentId
    // into the mirror; mirrors turn/index.ts's best-effort getter).
    const agentId = basename(this.agent.homedir ?? '');
    if (agentId.length === 0) return; // no homedir → nothing to match → fail open

    const entry = findEntryByAgentId(mirror, agentId);
    if (entry === undefined) return;
    const worktree = entry.worktree;
    // B3-4: a matched entry with a null/empty worktree has no confinement →
    // treat it as no entry and fail open.
    // B3R-1: a non-absolute worktree likewise has no usable confinement —
    // access paths are canonicalized absolute, so a relative base could
    // never contain them and the guard would deny everything (fail-closed).
    // The tower controller always writes absolute worktrees; any other
    // shape is anomalous, and we prefer fail-open over wrongly denying.
    if (typeof worktree !== 'string' || worktree.length === 0 || !pathe.isAbsolute(worktree)) {
      return;
    }

    const pathClass = this.agent.kaos.pathClass();
    const escapes = writeFileAccesses(context).filter(
      (access) => !isWithinDirectory(access.path, worktree, pathClass),
    );
    if (escapes.length === 0) return;
    return {
      kind: 'deny',
      message:
        `tower workers may only write inside their own worktree (${worktree}) — denied: ` +
        `${escapes.map((access) => access.path).join(', ')}. ` +
        'Out-of-scope changes are not yours to make: file them with moa_tower_finding or ask the tower via moa_tower_send.',
    };
  }
}

/** Reverse-locate the repo root from a worker cwd per the worktree layout. */
function reverseRepoRoot(cwd: string): string | undefined {
  if (cwd.length === 0) return undefined;
  const worktreesDir = dirname(cwd);
  const base = basename(worktreesDir);
  const suffix = '-worktrees';
  if (!base.endsWith(suffix)) return undefined;
  return join(dirname(worktreesDir), base.slice(0, -suffix.length));
}

/** Scan the mirror's agents map by agentId; pending (null) ids never match. */
function findEntryByAgentId(
  mirror: TowerGuardMirror,
  agentId: string,
): TowerGuardMirrorAgentEntry | undefined {
  const agents = mirror.agents;
  if (agents === undefined) return undefined;
  for (const value of Object.values(agents)) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as TowerGuardMirrorAgentEntry;
    if (entry.agentId === agentId) return entry;
  }
  return undefined;
}
