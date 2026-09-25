import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { IHostRequestHeaders } from '@moonshot-ai/agent-core-v2';

import { SDKRpcClientV2 } from '#/index';

import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-provider-identity-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('runtime provider identity headers', () => {
  it('preserves the host user agent suffix in SDK RPC headers', async () => {
    const homeDir = await makeTempDir();
    const client = new SDKRpcClientV2({
      homeDir,
      identity: {
        ...TEST_IDENTITY,
        userAgentSuffix: 'web-runtime',
      },
    });

    try {
      const headers = client.engineAccessor.get(IHostRequestHeaders).headers;
      expect(headers['User-Agent']).toBe('kimi-code-cli/0.0.0-test (web-runtime)');
      expect(headers['X-Msh-Version']).toBe('0.0.0-test');
    } finally {
      await client.close();
    }
  });
});
