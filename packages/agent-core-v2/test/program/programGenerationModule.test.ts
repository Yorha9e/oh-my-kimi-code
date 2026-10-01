import { afterEach, describe, expect, it } from 'vitest';

import { BugIndicatingError } from '#/_base/errors/errors';
import {
  applyProgramGenerationModules,
  registerProgramGenerationModule,
  _resetProgramGenerationModulesForTests,
} from '#/program/programGenerationModule';

afterEach(() => {
  _resetProgramGenerationModulesForTests();
});

describe('program generation modules', () => {
  it('rejects a duplicate module id at register time', () => {
    registerProgramGenerationModule({
      id: 'dup',
      apply() {},
    });
    expect(() =>
      registerProgramGenerationModule({
        id: 'dup',
        apply() {},
      }),
    ).toThrow(BugIndicatingError);
  });

  it('applies registered modules onto extras and tracks own() disposables', () => {
    const disposed: string[] = [];
    registerProgramGenerationModule({
      id: 'example',
      apply(ctx) {
        const value = ctx.own({
          tag: 'example',
          dispose() {
            disposed.push('example');
          },
        });
        ctx.provide('example', value);
      },
    });

    const ownables: { dispose(): void }[] = [];
    const extras = applyProgramGenerationModules({
      workspaceId: 'ws',
      context: { workspaceId: 'ws' } as never,
      dependencies: {} as never,
      runtime: {} as never,
      builtins: {} as never,
      own(value) {
        ownables.push(value);
        return value;
      },
    });

    expect(extras.get('example')).toEqual({ tag: 'example', dispose: expect.any(Function) });
    expect(ownables).toHaveLength(1);
    ownables[0]!.dispose();
    expect(disposed).toEqual(['example']);
  });

  it('rejects a duplicate extra id', () => {
    expect(() =>
      applyProgramGenerationModules(
        {
          workspaceId: 'ws',
          context: {} as never,
          dependencies: {} as never,
          runtime: {} as never,
          builtins: {} as never,
          own: (value) => value,
        },
        [
          {
            id: 'a',
            apply(ctx) {
              ctx.provide('shared', 1);
            },
          },
          {
            id: 'b',
            apply(ctx) {
              ctx.provide('shared', 2);
            },
          },
        ],
      ),
    ).toThrow(BugIndicatingError);
  });
});
