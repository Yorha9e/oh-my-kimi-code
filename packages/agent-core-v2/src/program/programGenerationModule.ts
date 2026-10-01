import { BugIndicatingError } from '#/_base/errors/errors';
import type { Runtime } from '#/runtime/runtime';
import type { IExtraAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader';
import type { IExplicitAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader';
import type { IPluginAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader';
import type { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import type { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import type { IWorkspaceFsService } from '#/workspace/workspaceFs/fs';
import type { IWorkspaceFsWatchService } from '#/workspace/workspaceFs/fsWatch';
import type { IWorkspaceGitService } from '#/workspace/workspaceGit/workspaceGit';
import type { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import type { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import type { IWorkspaceMcpConfigService } from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';
import type { IWorkspaceSkillCatalog } from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalog';
import type { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import type { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';

import type { ProgramDependencies } from './programDependencies';

export type ProgramDisposable = { dispose(): void | Promise<void> };

export interface ProgramGenerationBuiltins {
  readonly state: IWorkspaceStateService;
  readonly dirs: IWorkspaceDirs;
  readonly fs: IWorkspaceFsService;
  readonly watch: IWorkspaceFsWatchService;
  readonly git: IWorkspaceGitService;
  readonly instructions: IWorkspaceInstructionsService;
  readonly mcpConfig: IWorkspaceMcpConfigService;
  readonly mcp: IWorkspaceMcpService;
  readonly trust: IWorkspaceTrust;
  readonly skills: IWorkspaceSkillCatalog;
  readonly agentProfiles: IWorkspaceAgentProfileLoader;
  readonly userAgentProfiles: IUserAgentProfileLoader;
  readonly pluginAgentProfiles: IPluginAgentProfileLoader;
  readonly explicitAgentProfiles: IExplicitAgentProfileLoader;
  readonly extraAgentProfiles: IExtraAgentProfileLoader;
}

export interface ProgramGenerationModuleContext {
  readonly workspaceId: string;
  readonly context: IWorkspaceContext;
  readonly dependencies: ProgramDependencies;
  readonly runtime: Runtime;
  readonly builtins: ProgramGenerationBuiltins;
  own<T extends ProgramDisposable>(value: T): T;
  provide(id: string, value: unknown): void;
  get<T>(id: string): T | undefined;
}

export interface ProgramGenerationModule {
  readonly id: string;
  apply(ctx: ProgramGenerationModuleContext): void;
}

const modules: ProgramGenerationModule[] = [];

/**
 * Register a workspace-shared generation participant. Built-ins stay in
 * `Program.createGeneration()`; new domains register here instead of editing that list.
 */
export function registerProgramGenerationModule(module: ProgramGenerationModule): void {
  if (modules.some((entry) => entry.id === module.id)) {
    throw new BugIndicatingError(`duplicate program generation module: ${module.id}`);
  }
  modules.push(module);
}

export function getProgramGenerationModules(): readonly ProgramGenerationModule[] {
  return modules;
}

export function _resetProgramGenerationModulesForTests(): void {
  modules.length = 0;
}

export function applyProgramGenerationModules(
  ctx: Omit<ProgramGenerationModuleContext, 'provide' | 'get'>,
  list: readonly ProgramGenerationModule[] = modules,
): Map<string, unknown> {
  const extras = new Map<string, unknown>();
  const host: ProgramGenerationModuleContext = {
    ...ctx,
    provide(id, value) {
      if (extras.has(id)) {
        throw new BugIndicatingError(`duplicate program generation extra: ${id}`);
      }
      extras.set(id, value);
    },
    get<T>(id: string): T | undefined {
      return extras.get(id) as T | undefined;
    },
  };
  for (const module of list) {
    module.apply(host);
  }
  return extras;
}
