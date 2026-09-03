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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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

function firstFrameOf(body: unknown): Promise<Record<string, unknown>> {
  return requestFramesOf(body).then((frames) => {
    expect(frames).not.toHaveLength(0);
    return frames[0]!;
  });
}

/** Decode every frame written into a (possibly still-buffered) request body. */
async function requestFramesOf(body: unknown): Promise<Record<string, unknown>[]> {
  let wire: Uint8Array;
  if (body instanceof ReadableStream) {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      chunks.push(read.value);
    }
    wire = concatBytes(chunks);
  } else {
    wire = body as Uint8Array;
  }
  return new FrameDecoder().push(wire).map((frame) => parseFrameJson(frame) as Record<string, unknown>);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    timer.unref?.();
  });
  return Promise.race([
    promise.then(
      (value) => {
        clearTimeout(timer);
        return value;
      },
      (error: unknown) => {
        clearTimeout(timer);
        throw error;
      },
    ),
    timeout,
  ]);
}

async function waitFor(condition: () => boolean, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
    const provider = new CursorNativeChatProvider({ model: 'model-a', apiKey: 'tok', fetchImpl, transport: 'undici' });
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
    const firstFrame = await firstFrameOf(seenBody);
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
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici' });
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
    const provider = new CursorNativeChatProvider({ apiKey: 'ctor-token', fetchImpl, transport: 'undici' });
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
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici' });
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
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici' });
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
    let seenBody: unknown;
    const fetchImpl = stubFetch((_url, init) => {
      seenBody = init?.body;
      return concatBytes([
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
      ]);
    });
    const executor = okExecutor('tool output');
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici', toolExecutor: executor });
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
    // Both replies were transmitted mid-stream: the request body carries the
    // first frame followed by the two execClientMessage replies.
    const sent = await requestFramesOf(seenBody);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toHaveProperty('runRequest');
    expect(sent[1]).toEqual(stream.execReplies[0]);
    expect(sent[2]).toEqual(stream.execReplies[1]);
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
      transport: 'undici',
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
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici' });
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
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici', toolExecutor: executor });
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
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici', toolExecutor: denying });
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
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici' });
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
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici' });
    const failure = await drain(await provider.generate('', [], history())).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CursorModelError);
    expect((failure as CursorModelError).isRetryable).toBe(false);
    expect((failure as CursorModelError).debugError).toBe('ERROR_BAD_MODEL_NAME');
  });

  it('throws CursorResourceError for resource_exhausted with retry when the trailer says retryable', async () => {
    const fetchImpl = stubFetch(() =>
      trailerFrame({
        error: {
          code: 'resource_exhausted',
          isRetryable: true,
          debug: { error: 'ERROR_RESOURCE_EXHAUSTED', title: 'High Load' },
        },
      }),
    );
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici' });
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
      error: {
        code: 'resource_exhausted',
        isRetryable: true,
        debug: { error: 'ERROR_RESOURCE_EXHAUSTED', title: 'High Load' },
      },
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
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici', maxRetries: 1 });
    const parts = await drain(await provider.generate('', [], history()));
    expect(parts).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(calls).toBe(2);
  });

  it('retries a nested details.debug.details.isRetryable:true trailer and succeeds on retry', async () => {
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls += 1;
      return calls === 1
        ? trailerFrame({
            error: {
              code: 'resource_exhausted',
              details: [
                {
                  type: 'aiserver.v1.ErrorDetails',
                  debug: {
                    error: 'ERROR_HIGH_LOAD',
                    details: { title: 'High Load', isRetryable: true },
                    isExpected: true,
                  },
                },
              ],
            },
          })
        : concatBytes([dataFrame({ interactionUpdate: { textDelta: { text: 'recovered' } } }), trailerFrame({})]);
    });
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici', maxRetries: 1 });
    const parts = await drain(await provider.generate('', [], history()));
    expect(parts).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(calls).toBe(2);
  });

  it('does not retry a resource error whose trailer says isRetryable:false', async () => {
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls += 1;
      return trailerFrame({
        error: {
          code: 'resource_exhausted',
          isRetryable: false,
          debug: { error: 'ERROR_QUOTA_EXHAUSTED', title: 'Quota exceeded' },
        },
      });
    });
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici', maxRetries: 3 });
    const failure = await drain(await provider.generate('', [], history())).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CursorResourceError);
    expect((failure as CursorResourceError).isRetryable).toBe(false);
    expect(calls).toBe(1);
  });

  it('does not retry by default', async () => {
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls += 1;
      return resourceExhaustedTrailer();
    });
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici' });
    await expect(drain(await provider.generate('', [], history()))).rejects.toBeInstanceOf(CursorResourceError);
    expect(calls).toBe(1);
  });

  it('never retries protocol or model errors even with maxRetries set', async () => {
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls += 1;
      return trailerFrame({ error: { code: 'invalid_argument', message: 'bad frame' } });
    });
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici', maxRetries: 3 });
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
          error: {
            code: 'resource_exhausted',
            isRetryable: true,
            debug: { error: 'ERROR_RESOURCE_EXHAUSTED', title: 'High Load' },
          },
        }),
      ]);
    });
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici', maxRetries: 2 });
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
                isRetryable: true,
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
    const provider = new CursorNativeChatProvider({ apiKey: 'tok', fetchImpl, transport: 'undici', toolExecutor: executor, maxRetries: 1 });
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

  function requestedModelOf(body: Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return body.then(
      (firstFrame) => (firstFrame['runRequest'] as Record<string, unknown>)['requestedModel'] as Record<string, unknown>,
    );
  }

  it('clones without sharing thinking state and sends the effort as a model parameter', async () => {
    const capture = captureProvider();
    const base = new CursorNativeChatProvider({ model: 'model-a', apiKey: 'tok', fetchImpl: capture.fetchImpl, transport: 'undici' });
    const clone = base.withThinking('high');
    expect(clone).toBeInstanceOf(CursorNativeChatProvider);
    expect(clone).not.toBe(base);
    expect(base.thinkingEffort).toBeNull();
    expect(clone.thinkingEffort).toBe('high');
    expect(clone.modelName).toBe('model-a');
    await drain(await clone.generate('', [], history()));
    expect(await requestedModelOf(firstFrameOf(capture.seenBody()))).toEqual({
      modelId: 'model-a',
      parameters: [{ id: 'effort', value: 'high' }],
    });
    await drain(await base.generate('', [], history()));
    expect((await requestedModelOf(firstFrameOf(capture.seenBody())))['parameters']).toBeUndefined();
  });

  it('sends no effort parameter for off and keeps explicit modelParams winning', async () => {
    const capture = captureProvider();
    const provider = new CursorNativeChatProvider({
      model: 'model-a',
      apiKey: 'tok',
      fetchImpl: capture.fetchImpl,
      transport: 'undici',
      modelParams: { effort: 'low' },
    });
    await drain(await provider.withThinking('off').generate('', [], history()));
    expect(await requestedModelOf(firstFrameOf(capture.seenBody()))).toEqual({
      modelId: 'model-a',
      parameters: [{ id: 'effort', value: 'low' }],
    });
    await drain(await provider.withThinking('max').generate('', [], history()));
    expect(await requestedModelOf(firstFrameOf(capture.seenBody()))).toEqual({
      modelId: 'model-a',
      parameters: [{ id: 'effort', value: 'low' }],
    });
  });
});

describe('full-duplex roundtrip over a real local server', () => {
  it(
    'transmits the execClientMessage reply mid-stream and the server observes request EOS',
    { timeout: 15000 },
    async () => {
      const requestFrames: unknown[] = [];
      const decoder = new FrameDecoder();
      let resolveReply!: (frame: Record<string, unknown>) => void;
      const replyReceived = new Promise<Record<string, unknown>>((resolve) => {
        resolveReply = resolve;
      });
      let resolveRequestEnded!: () => void;
      const requestEnded = new Promise<void>((resolve) => {
        resolveRequestEnded = resolve;
      });
      let serverError: unknown = null;

      const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
        req.on('data', (chunk: Buffer) => {
          for (const frame of decoder.push(new Uint8Array(chunk))) {
            const json = parseFrameJson(frame) as Record<string, unknown>;
            requestFrames.push(json);
            if ('execClientMessage' in json) resolveReply(json);
          }
        });
        req.on('end', () => resolveRequestEnded());
        req.on('error', (error: Error) => {
          serverError = error;
        });
        void (async () => {
          // a. The first frame (runRequest) reaches the server.
          await waitFor(() => requestFrames.length >= 1, 'first frame');
          const first = requestFrames[0] as Record<string, unknown>;
          expect(first['runRequest']).toMatchObject({ conversationState: {} });
          // b. Server sends a text frame back while the request body stays open.
          res.writeHead(200, { 'content-type': 'application/connect+json' });
          res.write(Buffer.from(dataFrame({ interactionUpdate: { textDelta: { text: 'working' } } })));
          // c. Server sends an exec-server-message frame.
          res.write(
            Buffer.from(
              dataFrame({
                execServerMessage: {
                  shellArgs: { command: 'echo hi', workingDirectory: '/tmp', toolCallId: 'tc-duplex' },
                  id: 11,
                  execId: 'exec-duplex',
                },
              }),
            ),
          );
          // d. The server receives the execClientMessage reply mid-stream,
          // before any final frames are sent — this is the duplex fix.
          const reply = await withTimeout(replyReceived, 5000, 'execClientMessage reply');
          const replyBody = reply['execClientMessage'] as Record<string, unknown>;
          expect(replyBody['id']).toBe(11);
          expect(replyBody['execId']).toBe('exec-duplex');
          expect(replyBody['shellResult']).toEqual({ success: { output: 'duplex out' } });
          // e. Server sends the final frame and the trailer-flag frame; the
          // client iteration ends after the trailer. The HTTP response stays
          // open until the client ends its request body: undici only
          // delivers the request EOS while the response is still in flight
          // (after a completed response it tears the socket down instead).
          res.write(Buffer.from(dataFrame({ interactionUpdate: { textDelta: { text: 'done' } } })));
          res.write(Buffer.from(trailerFrame({})));
          await withTimeout(requestEnded, 5000, 'request body EOS');
          res.end();
        })().catch((error: unknown) => {
          serverError = error;
          res.destroy(error as Error);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const port = (server.address() as AddressInfo).port;
        const provider = new CursorNativeChatProvider({
          apiKey: 'tok',
          gatewayUrl: `http://127.0.0.1:${port}`,
          toolExecutor: okExecutor('duplex out'),
          transport: 'undici',
        });
        const stream = (await provider.generate('', [], history())) as CursorNativeStreamedMessage;
        const parts = await drain(stream);
        expect(parts).toEqual([
          { type: 'text', text: 'working' },
          { type: 'text', text: 'done' },
        ]);
        expect(stream.execReplies).toHaveLength(1);
        expect(serverError).toBeNull();
        // f. Client close() ended the request body: the server saw EOS.
        await withTimeout(requestEnded, 5000, 'request body EOS');
        expect(requestFrames).toHaveLength(2);
        expect(requestFrames[1]).toEqual(stream.execReplies[0]);
      } finally {
        server.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.once('close', resolve));
      }
    },
  );
});
