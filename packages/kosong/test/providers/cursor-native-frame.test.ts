import { APIConnectionError } from '#/errors';
import {
  decodeFrames,
  decodeFramePayload,
  encodeFrame,
  FRAME_FLAG_COMPRESSED,
  FRAME_FLAG_TRAILER,
  FrameDecoder,
  parseFrameJson,
  parseTrailers,
} from '#/providers/cursor-native/frame';
import {
  CursorModelError,
  CursorProtocolError,
  CursorResourceError,
  classifyTrailerError,
} from '#/providers/cursor-native/errors';
import { openRunStream, type ServerFrame } from '#/providers/cursor-native/run-stream';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function trailerBytes(payload: unknown): Uint8Array {
  const bytes = encodeFrame(JSON.stringify(payload));
  bytes[0] = FRAME_FLAG_TRAILER;
  return bytes;
}

async function collect(iter: AsyncIterable<ServerFrame>): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  for await (const frame of iter) frames.push(frame);
  return frames;
}

describe('encodeFrame roundtrip', () => {
  it('decodes an uncompressed string frame with flags 0', () => {
    const frames = new FrameDecoder().push(encodeFrame('{"hello":"world"}'));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.flags).toBe(0);
    expect(new TextDecoder().decode(frames[0]?.payload)).toBe('{"hello":"world"}');
  });

  it('roundtrips Uint8Array payloads byte-identically', () => {
    const payload = new Uint8Array([0, 1, 2, 255, 128, 64]);
    const frames = new FrameDecoder().push(encodeFrame(payload));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toEqual(payload);
  });

  it('sets the compressed flag and recovers the payload when compress is on', () => {
    const text = '{"runRequest":{"action":"x"}}'.repeat(20);
    const wire = encodeFrame(text, { compress: true });
    const frames = new FrameDecoder().push(wire);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.flags).toBe(FRAME_FLAG_COMPRESSED);
    expect(wire.length).toBeLessThan(new TextEncoder().encode(text).length + 5);
    expect(new TextDecoder().decode(decodeFramePayload(frames[0]!))).toBe(text);
  });
});

describe('sticky packets', () => {
  it('decodes multiple concatenated frames from a single push in order', () => {
    const wire = concatBytes([encodeFrame('{"a":1}'), encodeFrame('{"b":2}'), encodeFrame('{"c":3}')]);
    const frames = new FrameDecoder().push(wire);
    expect(frames).toHaveLength(3);
    expect(frames.map((frame) => new TextDecoder().decode(frame.payload))).toEqual([
      '{"a":1}',
      '{"b":2}',
      '{"c":3}',
    ]);
  });

  it('decodes mixed compressed and plain frames from one push', () => {
    const wire = concatBytes([encodeFrame('plain'), encodeFrame('compressed-body', { compress: true })]);
    const frames = new FrameDecoder().push(wire);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.flags).toBe(0);
    expect(frames[1]?.flags).toBe(FRAME_FLAG_COMPRESSED);
    expect(new TextDecoder().decode(decodeFramePayload(frames[1]!))).toBe('compressed-body');
  });
});

describe('half packets', () => {
  it('emits nothing until the final byte arrives when fed one byte at a time', () => {
    const wire = encodeFrame('{"split":"bytes"}');
    const decoder = new FrameDecoder();
    for (let i = 0; i < wire.length - 1; i += 1) {
      expect(decoder.push(wire.slice(i, i + 1))).toHaveLength(0);
    }
    const frames = decoder.push(wire.slice(wire.length - 1));
    expect(frames).toHaveLength(1);
    expect(new TextDecoder().decode(frames[0]?.payload)).toBe('{"split":"bytes"}');
  });

  it('buffers a split inside the 4-byte length field', () => {
    const wire = encodeFrame('{"length":"split"}');
    const decoder = new FrameDecoder();
    expect(decoder.push(wire.slice(0, 2))).toHaveLength(0);
    const frames = decoder.push(wire.slice(2));
    expect(frames).toHaveLength(1);
    expect(new TextDecoder().decode(frames[0]?.payload)).toBe('{"length":"split"}');
  });

  it('holds a partial second frame while releasing the complete first frame', () => {
    const first = encodeFrame('{"one":1}');
    const second = encodeFrame('{"two":2}');
    const decoder = new FrameDecoder();
    const frames = decoder.push(concatBytes([first, second.slice(0, 3)]));
    expect(frames).toHaveLength(1);
    expect(new TextDecoder().decode(frames[0]?.payload)).toBe('{"one":1}');
    const rest = decoder.push(second.slice(3));
    expect(rest).toHaveLength(1);
    expect(new TextDecoder().decode(rest[0]?.payload)).toBe('{"two":2}');
  });
});

describe('decodeFrames TransformStream', () => {
  it('streams frames written as sticky bytes across separate writes', async () => {
    const stream = decodeFrames();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const first = encodeFrame('{"s":1}');
    const second = encodeFrame('{"s":2}');
    const seen: string[] = [];
    const draining = (async () => {
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        seen.push(new TextDecoder().decode(read.value.payload));
      }
    })();
    await writer.write(first.slice(0, 3));
    await writer.write(concatBytes([first.slice(3), second]));
    await writer.close();
    await draining;
    expect(seen).toEqual(['{"s":1}', '{"s":2}']);
    reader.releaseLock();
  });
});

describe('parseFrameJson', () => {
  it('parses plain and compressed JSON frames', () => {
    const plain = new FrameDecoder().push(encodeFrame('{"k":"v"}'))[0]!;
    const compressed = new FrameDecoder().push(encodeFrame('{"k":"v"}', { compress: true }))[0]!;
    expect(parseFrameJson(plain)).toEqual({ k: 'v' });
    expect(parseFrameJson(compressed)).toEqual({ k: 'v' });
  });
});

describe('parseTrailers', () => {
  it('parses a trailer without error', () => {
    expect(parseTrailers('{}')).toEqual({});
  });

  it('parses an error trailer and preserves code and debug fields', () => {
    const trailers = parseTrailers(
      '{"error":{"code":"resource_exhausted","debug":{"error":"ERROR_RESOURCE_EXHAUSTED","title":"High Load"}}}',
    );
    expect(trailers['error']).toEqual({
      code: 'resource_exhausted',
      debug: { error: 'ERROR_RESOURCE_EXHAUSTED', title: 'High Load' },
    });
  });

  it('accepts raw payload bytes, gunzipping when needed', () => {
    const json = '{"error":{"code":"invalid_argument","message":"First message must be a run request"}}';
    expect(parseTrailers(new TextEncoder().encode(json))['error']).toMatchObject({
      code: 'invalid_argument',
    });
    expect(parseTrailers(gzipSync(json))['error']).toMatchObject({ code: 'invalid_argument' });
  });

  it('rejects malformed JSON and non-object payloads', () => {
    expect(() => parseTrailers('not json')).toThrow();
    expect(() => parseTrailers('[1,2]')).toThrow();
    expect(() => parseTrailers('null')).toThrow();
  });
});

describe('classifyTrailerError', () => {
  it('maps invalid_argument to CursorProtocolError without retry', () => {
    const error = classifyTrailerError(
      parseTrailers('{"error":{"code":"invalid_argument","message":"First message must be a run request"}}'),
    );
    expect(error).toBeInstanceOf(CursorProtocolError);
    expect(error?.isRetryable).toBe(false);
    expect(error).toMatchObject({ code: 'invalid_argument' });
    expect(error?.message).toContain('First message must be a run request');
  });

  it('maps not_found with an ERROR_ debug code to CursorModelError without retry', () => {
    const error = classifyTrailerError(
      parseTrailers('{"error":{"code":"not_found","debug":{"error":"ERROR_BAD_MODEL_NAME","title":"Model not found"}}}'),
    );
    expect(error).toBeInstanceOf(CursorModelError);
    expect(error?.isRetryable).toBe(false);
    expect(error).toMatchObject({
      code: 'not_found',
      debugError: 'ERROR_BAD_MODEL_NAME',
      title: 'Model not found',
    });
  });

  it('maps resource_exhausted to CursorResourceError with retry', () => {
    const error = classifyTrailerError(
      parseTrailers(
        '{"error":{"code":"resource_exhausted","debug":{"error":"ERROR_RESOURCE_EXHAUSTED","title":"High Load"}}}',
      ),
    );
    expect(error).toBeInstanceOf(CursorResourceError);
    expect(error?.isRetryable).toBe(true);
    expect(error).toMatchObject({ code: 'resource_exhausted', debugError: 'ERROR_RESOURCE_EXHAUSTED' });
  });

  it('returns null when the trailer carries no error', () => {
    expect(classifyTrailerError(parseTrailers('{}'))).toBeNull();
  });

  it('falls back to CursorProtocolError for unknown codes while keeping the code', () => {
    const error = classifyTrailerError(
      parseTrailers('{"error":{"code":"internal","message":"parse binary: illegal tag"}}'),
    );
    expect(error).toBeInstanceOf(CursorProtocolError);
    expect(error?.isRetryable).toBe(false);
    expect(error).toMatchObject({ code: 'internal' });
    expect(error?.message).toContain('parse binary');
  });

  it('handles a string-shaped error without crashing', () => {
    const error = classifyTrailerError({ error: 'boom' });
    expect(error).toBeInstanceOf(CursorProtocolError);
    expect(error?.message).toBe('boom');
  });
});

describe('openRunStream', () => {
  it('posts the first frame with identity headers and yields frames until the trailer', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const firstFrame = { runRequest: { runId: 'r1', conversationState: {} } };
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init;
      const body = concatBytes([
        encodeFrame('{"interactionUpdate":{"heartbeat":{}}}'),
        trailerBytes({}),
      ]);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body.slice(0, 7));
            controller.enqueue(body.slice(7));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'application/connect+json' } },
      );
    }) as typeof fetch;

    const frames = await collect(
      openRunStream({ token: 'tok', firstFrame, gatewayUrl: 'https://127.0.0.1:51443', fetchImpl }),
    );
    expect(seenUrl).toBe('https://127.0.0.1:51443/agent.v1.AgentService/Run');
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/connect+json');
    expect(headers['authorization']).toBe('Bearer tok');
    expect(headers['x-cursor-client-type']).toBe('sdk');
    expect(headers['x-cursor-client-version']).toBe('sdk-1.0.30');
    expect(typeof headers['x-request-id']).toBe('string');
    const sent = new FrameDecoder().push(seenInit?.body as Uint8Array);
    expect(sent).toHaveLength(1);
    expect(parseFrameJson(sent[0]!)).toEqual(firstFrame);
    expect(frames).toHaveLength(2);
    expect(frames[1]?.flags).toBe(FRAME_FLAG_TRAILER);
  });

  it('yields an error trailer instead of throwing', async () => {
    const fetchImpl = (async () => {
      return new Response(
        trailerBytes({ error: { code: 'resource_exhausted', debug: { error: 'ERROR_HIGH' } } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const frames = await collect(openRunStream({ token: 'tok', firstFrame: {}, fetchImpl }));
    expect(frames).toHaveLength(1);
    expect(classifyTrailerError(parseTrailers(decodeFramePayload(frames[0]!)))).toBeInstanceOf(
      CursorResourceError,
    );
  });

  it('throws APIConnectionError when fetch fails', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(collect(openRunStream({ token: 'tok', firstFrame: {}, fetchImpl }))).rejects.toBeInstanceOf(
      APIConnectionError,
    );
  });

  it('lets abort rejections propagate unwrapped', async () => {
    const fetchImpl = (async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }) as typeof fetch;
    const failure = await collect(
      openRunStream({ token: 'tok', firstFrame: {}, fetchImpl }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DOMException);
    expect((failure as DOMException).name).toBe('AbortError');
  });

  it('throws on non-200 responses', async () => {
    const fetchImpl = (async () => new Response('upstream says no', { status: 502 })) as typeof fetch;
    await expect(collect(openRunStream({ token: 'tok', firstFrame: {}, fetchImpl }))).rejects.toThrow(/502/);
  });
});
