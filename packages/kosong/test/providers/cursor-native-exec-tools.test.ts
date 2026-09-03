import type { HostToolExecutor, HostToolResult } from '#/provider';
import {
  decodeExecServerMessage,
  encodeExecClientMessage,
  ExecPermissionDeniedError,
  ExecRejectedError,
  handleExecServerMessage,
  isSupportedTool,
  type ExecRequest,
} from '#/providers/cursor-native/exec-tools';
import { describe, expect, it, vi } from 'vitest';

function okResult(text: string): HostToolResult {
  return { content: [{ type: 'text', text }] };
}

function serverMessage(toolKey: string, args: Record<string, unknown>, id = 7, execId = 'exec-1'): Record<string, unknown> {
  return { execServerMessage: { [toolKey]: args, id, execId } };
}

function clientBody(reply: Record<string, unknown> | null): Record<string, unknown> {
  expect(reply).not.toBeNull();
  const body = (reply as Record<string, unknown>)['execClientMessage'];
  expect(body).toBeTypeOf('object');
  return body as Record<string, unknown>;
}

function okExecutor(text = 'done'): HostToolExecutor {
  return vi.fn(async (): Promise<HostToolResult> => okResult(text));
}

function errExecutor(text: string): HostToolExecutor {
  return vi.fn(async (): Promise<HostToolResult> => ({ content: [{ type: 'text', text }], isError: true }));
}

describe('core tool roundtrips', () => {
  const cases: Array<{
    caseNo: number;
    tool: string;
    argsKey: string;
    args: Record<string, unknown>;
    expectedArgs: Record<string, unknown>;
    resultKey: string;
  }> = [
    {
      caseNo: 2,
      tool: 'shell',
      argsKey: 'shellArgs',
      args: { command: 'ls -la', workingDirectory: '/tmp', timeout: 30, toolCallId: 'tc-shell' },
      expectedArgs: { command: 'ls -la', workingDirectory: '/tmp', timeout: 30, toolCallId: 'tc-shell' },
      resultKey: 'shellResult',
    },
    {
      caseNo: 3,
      tool: 'write',
      argsKey: 'writeArgs',
      args: { path: '/tmp/a.txt', fileText: 'hello', toolCallId: 'tc-write' },
      expectedArgs: { path: '/tmp/a.txt', fileText: 'hello', toolCallId: 'tc-write' },
      resultKey: 'writeResult',
    },
    {
      caseNo: 4,
      tool: 'delete',
      argsKey: 'deleteArgs',
      args: { path: '/tmp/a.txt', toolCallId: 'tc-delete' },
      expectedArgs: { path: '/tmp/a.txt', toolCallId: 'tc-delete' },
      resultKey: 'deleteResult',
    },
    {
      caseNo: 5,
      tool: 'grep',
      argsKey: 'grepArgs',
      args: { pattern: 'hello', path: '/tmp', toolCallId: 'tc-grep' },
      expectedArgs: { pattern: 'hello', path: '/tmp', toolCallId: 'tc-grep' },
      resultKey: 'grepResult',
    },
    {
      caseNo: 7,
      tool: 'read',
      argsKey: 'readArgs',
      args: { path: '/tmp/a.txt', offset: 1, limit: 50, toolCallId: 'tc-read' },
      expectedArgs: { path: '/tmp/a.txt', offset: 1, limit: 50, toolCallId: 'tc-read' },
      resultKey: 'readResult',
    },
    {
      caseNo: 8,
      tool: 'ls',
      argsKey: 'lsArgs',
      args: { path: '/tmp', toolCallId: 'tc-ls' },
      expectedArgs: { path: '/tmp', toolCallId: 'tc-ls' },
      resultKey: 'lsResult',
    },
    {
      caseNo: 11,
      tool: 'mcp',
      argsKey: 'mcpArgs',
      args: {
        name: 'lookup',
        args: { q: 'x' },
        toolCallId: 'tc-mcp',
        providerIdentifier: 'prov',
        toolName: 'lookup',
      },
      expectedArgs: {
        name: 'lookup',
        args: { q: 'x' },
        toolCallId: 'tc-mcp',
        providerIdentifier: 'prov',
        toolName: 'lookup',
      },
      resultKey: 'mcpResult',
    },
    {
      caseNo: 20,
      tool: 'fetch',
      argsKey: 'fetchArgs',
      args: { url: 'https://example.com/x', toolCallId: 'tc-fetch' },
      expectedArgs: { url: 'https://example.com/x', toolCallId: 'tc-fetch' },
      resultKey: 'fetchResult',
    },
  ];

  it.each(cases)('routes $tool args to the executor and replies with the same-numbered result', async (entry) => {
    const executor = okExecutor(`${entry.tool} output`);
    const reply = await handleExecServerMessage(serverMessage(entry.argsKey, entry.args, 11, 'exec-9'), executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith(entry.tool, expect.objectContaining(entry.expectedArgs));
    const body = clientBody(reply);
    expect(body['id']).toBe(11);
    expect(body['execId']).toBe('exec-9');
    const result = body[entry.resultKey] as Record<string, unknown>;
    expect(Object.keys(body)).toContain(entry.resultKey);
    if (entry.tool === 'read') {
      expect(result['success']).toEqual({
        content: `${entry.tool} output`,
        path: '/tmp/a.txt',
        isEmpty: false,
      });
    } else {
      expect(result['success']).toEqual({ output: `${entry.tool} output` });
    }
    expect(decodeExecServerMessage(serverMessage(entry.argsKey, entry.args))?.caseNo).toBe(entry.caseNo);
  });

  it('decodes snake_case envelopes and args keys', async () => {
    const executor = okExecutor('out');
    const msg = {
      exec_server_message: {
        shell_args: { command: 'pwd', working_directory: '/tmp', tool_call_id: 'tc-1' },
        id: 3,
        exec_id: 'e-snake',
      },
    };
    const reply = await handleExecServerMessage(msg, executor);
    expect(executor).toHaveBeenCalledWith(
      'shell',
      expect.objectContaining({ command: 'pwd', workingDirectory: '/tmp', toolCallId: 'tc-1' }),
    );
    const body = clientBody(reply);
    expect(body['id']).toBe(3);
    expect(body['execId']).toBe('e-snake');
    expect(body['shellResult']).toEqual({ success: { output: 'out' } });
  });

  it('maps snake_case mcp provider fields to canonical args', async () => {
    const executor = okExecutor('mcp-out');
    const msg = serverMessage('mcpArgs', {
      name: 'lookup',
      args: { q: 'x' },
      tool_call_id: 'tc-m',
      provider_identifier: 'prov',
      tool_name: 'lookup',
      skip_approval: true,
      server_identifier: 'srv',
    });
    await handleExecServerMessage(msg, executor);
    expect(executor).toHaveBeenCalledWith(
      'mcp',
      expect.objectContaining({
        providerIdentifier: 'prov',
        toolName: 'lookup',
        skipApproval: true,
        serverIdentifier: 'srv',
        toolCallId: 'tc-m',
      }),
    );
  });

  it('marks isSupportedTool for the core eight only', () => {
    for (const supported of [2, 3, 4, 5, 7, 8, 11, 20]) expect(isSupportedTool(supported)).toBe(true);
    for (const unsupported of [9, 14, 28, 44, 45, 56, 99, -1]) expect(isSupportedTool(unsupported)).toBe(false);
  });
});

describe('id and exec_id pairing', () => {
  it('echoes the pair verbatim on success and on failure', async () => {
    const success = clientBody(await handleExecServerMessage(serverMessage('lsArgs', { path: '/' }, 42, 'exec-42'), okExecutor()));
    expect(success['id']).toBe(42);
    expect(success['execId']).toBe('exec-42');
    const failing = errExecutor('nope');
    const failure = clientBody(await handleExecServerMessage(serverMessage('lsArgs', { path: '/' }, 43, 'exec-43'), failing));
    expect(failure['id']).toBe(43);
    expect(failure['execId']).toBe('exec-43');
  });

  it('supports localExecutionTimeMs passthrough', () => {
    const req: ExecRequest = { caseNo: 2, toolName: 'shell', args: { command: 'ls' }, id: 1, execId: 'e' };
    const reply = encodeExecClientMessage(req, { kind: 'success', text: 'x' }, { localExecutionTimeMs: 12 });
    expect((reply['execClientMessage'] as Record<string, unknown>)['localExecutionTimeMs']).toBe(12);
  });
});

describe('unsupported cases', () => {
  it.each([
    { argsKey: 'subagentArgs', tool: 'subagent', caseNo: 28, resultKey: 'subagentResult' },
    { argsKey: 'diagnosticsArgs', tool: 'diagnostics', caseNo: 9, resultKey: 'diagnosticsResult' },
    { argsKey: 'gitDiffRequest', tool: 'git_diff', caseNo: 44, resultKey: 'gitDiffResult' },
    { argsKey: 'shellStreamArgs', tool: 'shell_stream', caseNo: 14, resultKey: 'shellStreamResult' },
  ])('replies failure for $tool without calling the executor', async (entry) => {
    const executor = okExecutor();
    const reply = await handleExecServerMessage(
      serverMessage(entry.argsKey, { toolCallId: 't' }, 5, 'exec-u'),
      executor,
    );
    expect(executor).not.toHaveBeenCalled();
    const body = clientBody(reply);
    expect(body['id']).toBe(5);
    expect(body['execId']).toBe('exec-u');
    const inner = body[entry.resultKey] as Record<string, unknown>;
    expect(inner['failure']).toEqual({ message: expect.stringContaining('unsupported') });
    expect(String((inner['failure'] as Record<string, unknown>)['message'])).toContain(entry.tool);
    expect(decodeExecServerMessage(serverMessage(entry.argsKey, {}))?.caseNo).toBe(entry.caseNo);
  });

  it('replies failure for an entirely unknown payload key without throwing', async () => {
    const executor = okExecutor();
    const reply = await handleExecServerMessage(serverMessage('frobnicatorArgs', { a: 1 }, 6, 'exec-x'), executor);
    expect(executor).not.toHaveBeenCalled();
    const body = clientBody(reply);
    expect(body['id']).toBe(6);
    expect(body['execId']).toBe('exec-x');
    expect(body['failure']).toEqual({ message: expect.stringContaining('unrecognized') });
  });
});

describe('executor error mapping', () => {
  it('maps isError results to failure with the tool text', async () => {
    const executor = errExecutor('disk full');
    const body = clientBody(await handleExecServerMessage(serverMessage('writeArgs', { path: '/x' }), executor));
    expect(body['writeResult']).toEqual({ failure: { message: 'disk full' } });
  });

  it('maps mcp isError results to the native error case', async () => {
    const executor = errExecutor('tool blew up');
    const body = clientBody(await handleExecServerMessage(serverMessage('mcpArgs', { name: 't' }), executor));
    expect(body['mcpResult']).toEqual({ error: { message: 'tool blew up' } });
  });

  it('converts thrown errors to failure results without rejecting', async () => {
    const executor: HostToolExecutor = vi.fn(async () => {
      throw new Error('kaput');
    });
    const body = clientBody(await handleExecServerMessage(serverMessage('shellArgs', { command: 'x' }), executor));
    expect(body['shellResult']).toEqual({ failure: { message: 'kaput' } });
  });

  it('converts non-Error rejections to failure with a readable message', async () => {
    const executor: HostToolExecutor = vi.fn((): Promise<HostToolResult> => Promise.reject('plain string failure'));
    const body = clientBody(await handleExecServerMessage(serverMessage('readArgs', { path: '/x' }), executor));
    expect(body['readResult']).toEqual({ failure: { message: 'plain string failure' } });
  });

  it('maps shell timeouts to the native timeout case and other tools to failure', async () => {
    const timingOut: HostToolExecutor = vi.fn(async () => {
      throw new Error('command timed out after 30000ms');
    });
    const shellBody = clientBody(await handleExecServerMessage(serverMessage('shellArgs', { command: 'x' }), timingOut));
    expect(shellBody['shellResult']).toEqual({ timeout: { message: 'command timed out after 30000ms' } });
    const readBody = clientBody(await handleExecServerMessage(serverMessage('readArgs', { path: '/x' }), timingOut));
    expect(readBody['readResult']).toEqual({ failure: { message: 'command timed out after 30000ms' } });
  });
});

describe('permission denial seam', () => {
  it('encodes shell and mcp denials as permission_denied', async () => {
    const denying: HostToolExecutor = vi.fn(async () => {
      throw new Error('permission denied by policy');
    });
    const shellBody = clientBody(await handleExecServerMessage(serverMessage('shellArgs', { command: 'rm' }), denying));
    expect(shellBody['shellResult']).toEqual({ permissionDenied: {} });
    const mcpBody = clientBody(await handleExecServerMessage(serverMessage('mcpArgs', { name: 't' }), denying));
    expect(mcpBody['mcpResult']).toEqual({ permissionDenied: {} });
  });

  it('encodes denials for tools without a native case as rejected', async () => {
    const denying: HostToolExecutor = vi.fn(async () => {
      throw new Error('operation not permitted');
    });
    const readBody = clientBody(await handleExecServerMessage(serverMessage('readArgs', { path: '/x' }), denying));
    expect(readBody['readResult']).toEqual({ rejected: {} });
  });

  it('honors the explicit denial and rejection error classes', async () => {
    const denied: HostToolExecutor = vi.fn(async () => {
      throw new ExecPermissionDeniedError('yolo mode is off');
    });
    const readBody = clientBody(await handleExecServerMessage(serverMessage('readArgs', { path: '/x' }), denied));
    expect(readBody['readResult']).toEqual({ rejected: {} });
    const shellDenied = clientBody(await handleExecServerMessage(serverMessage('shellArgs', { command: 'x' }), denied));
    expect(shellDenied['shellResult']).toEqual({ permissionDenied: {} });
    const rejected: HostToolExecutor = vi.fn(async () => {
      throw new ExecRejectedError('user declined approval');
    });
    const shellBody = clientBody(await handleExecServerMessage(serverMessage('shellArgs', { command: 'x' }), rejected));
    expect(shellBody['shellResult']).toEqual({ rejected: {} });
  });

  it('lets M4 override denial detection via opts', async () => {
    const other: HostToolExecutor = vi.fn(async () => {
      throw new Error('totally custom gate signal');
    });
    const body = clientBody(
      await handleExecServerMessage(serverMessage('shellArgs', { command: 'x' }), other, {
        isPermissionDenied: (error) => error instanceof Error && error.message.includes('custom gate'),
      }),
    );
    expect(body['shellResult']).toEqual({ permissionDenied: {} });
  });
});

describe('malformed input', () => {
  it.each([null, undefined, 'nope', 42, [], {}, { interactionUpdate: {} }, { execServerMessage: null }, { execServerMessage: {} }])(
    'returns null for %s',
    async (input) => {
      await expect(handleExecServerMessage(input, okExecutor())).resolves.toBeNull();
      expect(decodeExecServerMessage(input)).toBeNull();
    },
  );

  it('keeps id pairing when args are missing', async () => {
    const reply = await handleExecServerMessage({ execServerMessage: { readArgs: {}, id: 9, execId: 'e9' } }, okExecutor('x'));
    const body = clientBody(reply);
    expect(body['id']).toBe(9);
    expect(body['execId']).toBe('e9');
    expect(body['readResult']).toEqual({ success: { content: 'x', path: undefined, isEmpty: false } });
  });
});
