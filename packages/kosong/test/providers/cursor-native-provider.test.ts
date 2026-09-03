import { createUserMessage } from '#/message';
import type { HostToolExecutor, HostToolResult, StreamedMessage } from '#/provider';
import {
  CursorModelError,
  CursorProtocolError,
  CursorResourceError,
} from '#/providers/cursor-native/errors';
import { ExecPermissionDeniedError } from '#/providers/cursor-native/exec-tools';
import {
  encodeFrame,
  FrameDecoder,
  FRAME_FLAG_TRAILER,
  parseFrameJson,
} from '#/providers/cursor-native/frame';
import {
  CursorNativeChatProvider,
  CursorNativeStreamedMessage,
} from '#/providers/cursor-native/index';
import { describe, expect, it, vi } from 'vitest';

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function dataFrame(payload: unknown): Uint8Array {
  return encodeFrame(JSON.stringify(payload));
}

function trailerFrame(payload: unknown): Uint8Array {
  const bytes = encodeFrame(JSON.stringify(payload));
  bytes[0] = FRAME_FLAG_TRAILER;
  return bytes;
}

function stubFetch(handler: (url: unknown, init?: RequestInit) => Uint8Array): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    return new Response(handler(_url, init), { status: 200 });
  }) as typeof fetch;
}

function okResult(text: string): HostToolResult {
  return { content: [{ type: 'text', text }] };
}

function okExecutor(text = 'ok'): HostToolExecutor {
  return vi.fn(async (): Promise<HostToolResult> => okResult(text));
}

async function drain(stream: StreamedMessage): Promise<unknown[]> {
  const parts: unknown[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

function firstFrameOf(body: unknown): Record<string, unknown> {
  const frames = new FrameDecoder().push(body as Uint8Array);
  expect(frames).toHaveLength(1);
  return parseFrameJson(frames[0]!) as Record<string, unknown>;
}

function history() {
  return [createUserMessage('hello')];
}

describe('text streaming and first frame', () => {
  it('assembles textDelta frames into text parts and posts the probe-3c first frame', async () => {
    let seenBody: unknown;
    let seenHeaders: Record<string, string> | undefined;
    const fetchImpl = stubFetch((_url, init) => {
      seenBody = init?.body;
      seenHeaders = init?.headers as Record<string, string>;
      return concatBytes([
        dataFrame({ interactionUpdate: { textDelta: { text: 'Hello ' } } }),
        dataFrame({ interactionUpdate: { textDelta: { text: 'world' } } }),
        dataFrame({ interactionUpdate: { heartbeat: {} } }),
        trailerFrame({}),
      ]);
    });
    const onRequestSent = vi.fn();
    const provider = new CursorNativeChatProvider({ model: 'model-a', apiKey: 'tok', fetchImpl });
    const stream = await provider.generate('sys', [], history(), { onRequestSent });
    expect(stream).toBeInstanceOf(CursorNativeStreamedMessage);
    expect(typeof stream.id).toBe('string');
    const parts = await drain(stream);
    expect(parts).toEqual([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
    ]);
    expect(stream.finishReason).toBe('completed');
    expect(stream.usage).toBeNull();
    expect(onRequestSent).toHaveBeenCalledTimes(1);
    expect(seenHeaders?.['authorization']).toBe('Bearer tok');
    const firstFrame = firstFrameOf(seenBody);
    const runRequest = firstFrame['runRequest'] as Record<string, unknown>;
    expect(runRequest['conversationState']).toEqual({});
    expect((runRequest['requestedModel'] as Record<string, unknown>)['modelId']).toBe('model-a');
    expect(typeof runRequest['runId']).toBe('string');
    expect(stream.id).toBe(runRequest['runId']);
  });

  it('maps thinkingDelta frames onto think parts', async () => {
    const fetchImpl = stubFetch(() =>
      concatBytes([
        dataFrame({ interactionUpdate: { thinkingDelta: { text: 'hmm' } } }),
        dataFrame({ interactionUpdate: { textDelta: { text: 'answer' } } }),
        trailerFrame({}),
      ]),
    );
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl });
    const stream = await provider.generate('', [], history());
    expect(await drain(stream)).toEqual([
      { type: 'think', think: 'hmm' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('prefers per-request auth.apiKey over the constructor token', async () => {
    let seenHeaders: Record<string, string> | undefined;
    const fetchImpl = stubFetch((_url, init) => {
      seenHeaders = init?.headers as Record<string, string>;
      return trailerFrame({});
    });
    const provider = new CursorNativeChatProvider({ apiKey: 'ctor-token', fetchImpl });
    await drain(await provider.generate('', [], history(), { auth: { apiKey: 'req-token' } }));
    expect(seenHeaders?.['authorization']).toBe('Bearer req-token');
  });

  it('throws CursorProtocolError without retry when no token is configured', async () => {
    const provider = new CursorNativeChatProvider({});
    const failure = await provider.generate('', [], history()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CursorProtocolError);
    expect((failure as CursorProtocolError).isRetryable).toBe(false);
  });
});

describe('turnEnded usage', () => {
  it('maps turnEnded counters onto StreamedMessage usage', async () => {
    const fetchImpl = stubFetch(() =>
      concatBytes([
        dataFrame({ interactionUpdate: { textDelta: { text: 'hi' } } }),
        dataFrame({
          interactionUpdate: {
            turnEnded: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, reasoningTokens: 20 },
          },
        }),
        trailerFrame({}),
      ]),
    );
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl });
    const stream = await provider.generate('', [], history());
    await drain(stream);
    expect(stream.usage).toEqual({
      inputOther: 100,
      output: 50,
      inputCacheRead: 10,
      inputCacheCreation: 5,
    });
  });

  it('accepts snake_case envelopes and usage keys', async () => {
    const fetchImpl = stubFetch(() =>
      concatBytes([
        dataFrame({ interaction_update: { text_delta: { text: 'hi' } } }),
        dataFrame({
          interaction_update: {
            turn_ended: { input_tokens: 7, output_tokens: 3, cache_read_tokens: 1, cache_write_tokens: 2 },
          },
        }),
        trailerFrame({}),
      ]),
    );
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl });
    const stream = await provider.generate('', [], history());
    const parts = await drain(stream);
    expect(parts).toEqual([{ type: 'text', text: 'hi' }]);
    expect(stream.usage).toEqual({
      inputOther: 7,
      output: 3,
      inputCacheRead: 1,
      inputCacheCreation: 2,
    });
  });
});

describe('exec tool loop', () => {
  it('runs exec requests through the host executor with engine tool names and continues the stream', async () => {
    const fetchImpl = stubFetch(() =>
      concatBytes([
        dataFrame({
          execServerMessage: {
            shellArgs: { command: 'ls', workingDirectory: '/tmp', toolCallId: 'tc-1' },
            id: 7,
            execId: 'exec-1',
          },
        }),
        dataFrame({
          execServerMessage: {
            readArgs: { path: '/tmp/a.txt', toolCallId: 'tc-2' },
            id: 8,
            execId: 'exec-2',
          },
        }),
        dataFrame({ interactionUpdate: { textDelta: { text: 'after tools' } } }),
        trailerFrame({}),
      ]),
    );
    const executor = okExecutor('tool output');
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, toolExecutor: executor });
    const stream = (await provider.generate('', [], history())) as CursorNativeStreamedMessage;
    const parts = await drain(stream);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor).toHaveBeenNthCalledWith(
      1,
      'Bash',
      expect.objectContaining({ command: 'ls', toolCallId: 'tc-1' }),
    );
    expect(executor).toHaveBeenNthCalledWith(
      2,
      'Read',
      expect.objectContaining({ path: '/tmp/a.txt', toolCallId: 'tc-2' }),
    );
    expect(stream.execReplies).toHaveLength(2);
    const first = (stream.execReplies[0]!['execClientMessage'] ?? {}) as Record<string, unknown>;
    expect(first['id']).toBe(7);
    expect(first['execId']).toBe('exec-1');
    expect(first['shellResult']).toEqual({ success: { output: 'tool output' } });
    const second = (stream.execReplies[1]!['execClientMessage'] ?? {}) as Record<string, unknown>;
    expect(second['readResult']).toEqual({
      success: { content: 'tool output', path: '/tmp/a.txt', isEmpty: false },
    });
    expect(parts).toEqual([{ type: 'text', text: 'after tools' }]);
    expect(stream.finishReason).toBe('completed');
  });

  it('honors a custom toolNameMap over the defaults', async () => {
    const fetchImpl = stubFetch(() =>
      concatBytes([
        dataFrame({ execServerMessage: { shellArgs: { command: 'x', toolCallId: 't' } } }),
        trailerFrame({}),
      ]),
    );
    const executor = okExecutor();
    const provider = new CursorNativeChatProvider({
      apiKey: 'tok',
      fetchImpl,
      toolExecutor: executor,
      toolNameMap: { shell: 'CustomShell' },
    });
    await drain(await provider.generate('', [], history()));
    expect(executor).toHaveBeenCalledWith('CustomShell', expect.objectContaining({ command: 'x' }));
  });

  it('surfaces model-visible tool calls to the host when no exec request arrives', async () => {
    const fetchImpl = stubFetch(() =>
      concatBytes([
        dataFrame({
          interactionUpdate: {
            toolCallStarted: { toolCallId: 'call-1', toolName: 'read', args: '{"path":"a.txt"}' },
          },
        }),
        trailerFrame({}),
      ]),
    );
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl });
    const parts = await drain(await provider.generate('', [], history()));
    expect(parts).toEqual([{ type: 'function', id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' }]);
  });

  it('does not surface a host-visible call for a toolCallId already executed via exec', async () => {
    const fetchImpl = stubFetch(() =>
      concatBytes([
        dataFrame({
          interactionUpdate: {
            toolCallStarted: { toolCallId: 'tc-9', toolName: 'shell', args: '{"command":"ls"}' },
          },
        }),
        dataFrame({ execServerMessage: { shellArgs: { command: 'ls', toolCallId: 'tc-9' } } }),
        dataFrame({ interactionUpdate: { textDelta: { text: 'done' } } }),
        trailerFrame({}),
      ]),
    );
    const executor = okExecutor('out');
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, toolExecutor: executor });
    const parts = await drain(await provider.generate('', [], history()));
    expect(executor).toHaveBeenCalledTimes(1);
    expect(parts).toEqual([{ type: 'text', text: 'done' }]);
  });
});

describe('permission denial seam', () => {
  it('encodes shell denials as permissionDenied and other tools as rejected, then continues', async () => {
    const fetchImpl = stubFetch(() =>
      concatBytes([
        dataFrame({ execServerMessage: { shellArgs: { command: 'rm -rf /', toolCallId: 'd1' }, id: 1, execId: 'e1' } }),
        dataFrame({ execServerMessage: { readArgs: { path: '/secret', toolCallId: 'd2' }, id: 2, execId: 'e2' } }),
        dataFrame({ interactionUpdate: { textDelta: { text: 'still here' } } }),
        trailerFrame({}),
      ]),
    );
    const denying: HostToolExecutor = vi.fn(async () => {
      throw new ExecPermissionDeniedError('denied by policy');
    });
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, toolExecutor: denying });
    const stream = (await provider.generate('', [], history())) as CursorNativeStreamedMessage;
    const parts = await drain(stream);
    expect(denying).toHaveBeenCalledTimes(2);
    expect(stream.execReplies).toHaveLength(2);
    const shell = (stream.execReplies[0]!['execClientMessage'] ?? {}) as Record<string, unknown>;
    expect(shell['shellResult']).toEqual({ permissionDenied: {} });
    const read = (stream.execReplies[1]!['execClientMessage'] ?? {}) as Record<string, unknown>;
    expect(read['readResult']).toEqual({ rejected: {} });
    expect(parts).toEqual([{ type: 'text', text: 'still here' }]);
  });
});

describe('trailer errors', () => {
  it('throws CursorProtocolError for invalid_argument without retry', async () => {
    const fetchImpl = stubFetch(() =>
      trailerFrame({ error: { code: 'invalid_argument', message: 'First message must be a run request' } }),
    );
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl });
    const failure = await drain(await provider.generate('', [], history())).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CursorProtocolError);
    expect((failure as CursorProtocolError).isRetryable).toBe(false);
    expect((failure as Error).message).toContain('First message must be a run request');
  });

  it('throws CursorModelError for not_found with an ERROR_ debug code', async () => {
    const fetchImpl = stubFetch(() =>
      trailerFrame({
        error: { code: 'not_found', debug: { error: 'ERROR_BAD_MODEL_NAME', title: 'Model not found' } },
      }),
    );
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl });
    const failure = await drain(await provider.generate('', [], history())).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CursorModelError);
    expect((failure as CursorModelError).isRetryable).toBe(false);
    expect((failure as CursorModelError).debugError).toBe('ERROR_BAD_MODEL_NAME');
  });

  it('throws CursorResourceError for resource_exhausted with retry', async () => {
    const fetchImpl = stubFetch(() =>
      trailerFrame({
        error: { code: 'resource_exhausted', debug: { error: 'ERROR_RESOURCE_EXHAUSTED', title: 'High Load' } },
      }),
    );
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl });
    const failure = await drain(await provider.generate('', [], history())).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CursorResourceError);
    expect((failure as CursorResourceError).isRetryable).toBe(true);
  });
});

describe('retry gate', () => {
  function resourceExhaustedTrailer(): Uint8Array {
    return trailerFrame({
      error: { code: 'resource_exhausted', debug: { error: 'ERROR_RESOURCE_EXHAUSTED', title: 'High Load' } },
    });
  }

  it('retries a retryable trailer error once when maxRetries allows it', async () => {
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls += 1;
      return calls === 1
        ? resourceExhaustedTrailer()
        : concatBytes([dataFrame({ interactionUpdate: { textDelta: { text: 'recovered' } } }), trailerFrame({})]);
    });
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, maxRetries: 1 });
    const parts = await drain(await provider.generate('', [], history()));
    expect(parts).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(calls).toBe(2);
  });

  it('does not retry by default', async () => {
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls += 1;
      return resourceExhaustedTrailer();
    });
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl });
    await expect(drain(await provider.generate('', [], history()))).rejects.toBeInstanceOf(CursorResourceError);
    expect(calls).toBe(1);
  });

  it('never retries protocol or model errors even with maxRetries set', async () => {
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls += 1;
      return trailerFrame({ error: { code: 'invalid_argument', message: 'bad frame' } });
    });
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, maxRetries: 3 });
    await expect(drain(await provider.generate('', [], history()))).rejects.toBeInstanceOf(CursorProtocolError);
    expect(calls).toBe(1);
  });

  it('does not retry once a part was already yielded', async () => {
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls += 1;
      return concatBytes([
        dataFrame({ interactionUpdate: { textDelta: { text: 'partial' } } }),
        trailerFrame({
          error: { code: 'resource_exhausted', debug: { error: 'ERROR_RESOURCE_EXHAUSTED', title: 'High Load' } },
        }),
      ]);
    });
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, maxRetries: 2 });
    await expect(drain(await provider.generate('', [], history()))).rejects.toBeInstanceOf(CursorResourceError);
    expect(calls).toBe(1);
  });

  it('does not re-execute an already-executed tool on retry', async () => {
    let calls = 0;
    const execFrame = dataFrame({
      execServerMessage: { shellArgs: { command: 'ls', toolCallId: 'tc-r' }, id: 1, execId: 'e1' },
    });
    const fetchImpl = stubFetch(() => {
      calls += 1;
      return calls === 1
        ? concatBytes([
            execFrame,
            trailerFrame({
              error: {
                code: 'resource_exhausted',
                debug: { error: 'ERROR_RESOURCE_EXHAUSTED', title: 'High Load' },
              },
            }),
          ])
        : concatBytes([
            execFrame,
            dataFrame({ interactionUpdate: { textDelta: { text: 'ok' } } }),
            trailerFrame({}),
          ]);
    });
    const executor = okExecutor('out');
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, toolExecutor: executor, maxRetries: 1 });
    const stream = (await provider.generate('', [], history())) as CursorNativeStreamedMessage;
    const parts = await drain(stream);
    expect(parts).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls).toBe(2);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(stream.execReplies).toHaveLength(1);
  });
});

describe('withThinking', () => {
  function captureProvider() {
    let seenBody: unknown;
    const fetchImpl = stubFetch((_url, init) => {
      seenBody = init?.body;
      return concatBytes([dataFrame({ interactionUpdate: { textDelta: { text: 'x' } } }), trailerFrame({})]);
    });
    return { fetchImpl, seenBody: () => seenBody };
  }

  function requestedModelOf(body: unknown): Record<string, unknown> {
    return (firstFrameOf(body)['runRequest'] as Record<string, unknown>)['requestedModel'] as Record<string, unknown>;
  }

  it('clones without sharing thinking state and sends the effort as a model parameter', async () => {
    const capture = captureProvider();
    const base = new CursorNativeChatProvider({ model: 'model-a', apiKey: 'tok', fetchImpl: capture.fetchImpl });
    const clone = base.withThinking('high');
    expect(clone).toBeInstanceOf(CursorNativeChatProvider);
    expect(clone).not.toBe(base);
    expect(base.thinkingEffort).toBeNull();
    expect(clone.thinkingEffort).toBe('high');
    expect(clone.modelName).toBe('model-a');
    await drain(await clone.generate('', [], history()));
    expect(requestedModelOf(capture.seenBody())).toEqual({
      modelId: 'model-a',
      parameters: [{ id: 'effort', value: 'high' }],
    });
    await drain(await base.generate('', [], history()));
    expect(requestedModelOf(capture.seenBody())['parameters']).toBeUndefined();
  });

  it('sends no effort parameter for off and keeps explicit modelParams winning', async () => {
    const capture = captureProvider();
    const provider = new CursorNativeChatProvider({
      model: 'model-a',
      apiKey: 'tok',
      fetchImpl: capture.fetchImpl,
      modelParams: { effort: 'low' },
    });
    await drain(await provider.withThinking('off').generate('', [], history()));
    expect(requestedModelOf(capture.seenBody())).toEqual({
      modelId: 'model-a',
      parameters: [{ id: 'effort', value: 'low' }],
    });
    await drain(await provider.withThinking('max').generate('', [], history()));
    expect(requestedModelOf(capture.seenBody())).toEqual({
      modelId: 'model-a',
      parameters: [{ id: 'effort', value: 'low' }],
    });
  });
});
