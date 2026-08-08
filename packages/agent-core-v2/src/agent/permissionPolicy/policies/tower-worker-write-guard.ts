import { basename, dirname, join } from 'node:path';

import * as pathe from 'pathe';

import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { IAgentProfileService as ProfileService } from '#/agent/profile/profile';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentScopeContext as ScopeContext } from '#/agent/scopeContext/scopeContext';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IHostEnvironment as HostEnvironment } from '#/os/interface/hostEnvironment';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ISessionWorkspaceContext as WorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { isWithinDirectory } from '#/tool/path-access';
import { writeFileAccesses } from './path-utils';
import {
  readTowerGuardMirror,
  type TowerGuardMirror,
  type TowerGuardMirrorAgentEntry,
} from './tower-guard-mirror';

/**
 * tower-worker agents are confined to their own worktree: the tower spawns
 * them with the worktree as their working directory, and this guard denies
 * any Write/Edit whose target escapes it — including absolute paths. The
 * main checkout and sibling agents' slots are therefore unreachable for
 * edits; out-of-scope changes go through moa_tower_finding / the tower
 * instead.
 *
 * Bash commands with absolute escape paths remain a briefing-level rule (the
 * Bash tool reports no file accesses to match against) — Bash redirection
 * escapes are NOT intercepted, matching the official v2 guard.
 *
 * The worktree comes from the guard mirror `<repoRoot>/.tower-guard.json`
 * written by the moamcp tower controller. Layout convention: the worker cwd
 * is `<repoRoot>`-sibling `<repoName>-worktrees/<slot>`, so the repo root is
 * reverse-located from the session work dir — `dirname(cwd)` must end in
 * `-worktrees` and exactly ONE trailing `-worktrees` suffix is stripped (a
 * repo whose own name ends in `-worktrees` still resolves). Any deviation
 * from this layout, or any mirror read failure, fails open (no
 * interception).
 *
 * Path comparison uses `env.pathClass` explicitly (win32 lowercases both
 * sides, mirroring the official guard's platform handling).
 */
export class TowerWorkerWriteGuardPermissionPolicyService implements PermissionPolicy {
  readonly name = 'tower-worker-write-guard-deny';

  constructor(
    @IAgentProfileService private readonly profile: ProfileService,
    @IAgentScopeContext private readonly scopeContext: ScopeContext,
    @ISessionWorkspaceContext private readonly workspace: WorkspaceContext,
    @IHostEnvironment private readonly env: HostEnvironment,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    if (this.profile.data().profileName !== 'tower-worker') return;
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return;

    const repoRoot = reverseRepoRoot(this.workspace.workDir);
    if (repoRoot === undefined) return;
    const mirror = await readTowerGuardMirror(repoRoot);
    if (mirror === undefined) return;

    const entry = findEntryByAgentId(mirror, this.scopeContext.agentId);
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

    const escapes = writeFileAccesses(context).filter(
      (access) => !isWithinDirectory(access.path, worktree, this.env.pathClass),
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
