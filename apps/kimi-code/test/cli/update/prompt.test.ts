import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  createInstallPromptChoices,
  getDefaultInstallPromptSelection,
  moveInstallPromptSelection,
  promptForInstallChoice,
} from '#/cli/update/prompt';

const RELEASE_URL =
  'https://github.com/Yorha9e/oh-my-kimi-code/releases/tag/oh-my-kimi-code@0.5.0-omkc.1';

describe('install prompt helpers', () => {
  it('defaults the selection to "Install update now"', () => {
    const choices = createInstallPromptChoices({ version: '0.29.0-omkc.2' });

    expect(getDefaultInstallPromptSelection(choices)).toBe(0);
    expect(choices[0]).toEqual({
      value: 'install',
      label: 'Install update now (0.29.0-omkc.2)',
    });
    expect(choices[1]).toEqual({
      value: 'skip',
      label: 'Continue with current version',
    });
  });

  it('moves selection with arrow directions and clamps at the edges', () => {
    expect(moveInstallPromptSelection(1, 'up', 2)).toBe(0);
    expect(moveInstallPromptSelection(0, 'up', 2)).toBe(0);
    expect(moveInstallPromptSelection(0, 'down', 2)).toBe(1);
    expect(moveInstallPromptSelection(1, 'down', 2)).toBe(1);
  });
});

describe('promptForInstallChoice', () => {
  it('renders the GitHub Release notes link and community copy in the prompt output', async () => {
    const input = Object.assign(new EventEmitter(), {
      isRaw: false,
      setRawMode: () => {},
      resume: () => {},
      off: () => {},
    }) as unknown as NodeJS.ReadStream;

    const outputChunks: string[] = [];
    const output = {
      write: (chunk: string) => {
        outputChunks.push(chunk);
        return true;
      },
    } as NodeJS.WriteStream;

    const promptPromise = promptForInstallChoice({
      currentVersion: '0.29.0-omkc.1',
      target: { version: '0.29.0-omkc.2' },
      releaseUrl: RELEASE_URL,
      installSummary: 'Download omkc-linux-x64.zip from GitHub Releases and replace the current binary',
      installSource: 'native',
      input,
      output,
    });

    // Emit keypress to trigger initial render then exit
    input.emit('keypress', '', { name: 'escape' });

    await promptPromise;

    const rendered = outputChunks.join('');
    expect(rendered).toContain(RELEASE_URL);
    expect(rendered).toContain('Release notes');
    expect(rendered).toContain('Oh My Kimi Code Update Available');
    expect(rendered).toContain('omkc-linux-x64.zip');
  });
});
