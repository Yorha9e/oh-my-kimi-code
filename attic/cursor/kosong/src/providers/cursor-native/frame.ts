import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Flags bit marking a frame payload as gzip-compressed.
 */
export const FRAME_FLAG_COMPRESSED = 0x01;

/**
 * Flags bit marking a frame as the EndStream trailer frame.
 */
export const FRAME_FLAG_TRAILER = 0x02;

/**
 * One decoded Connect bidi envelope: raw flags plus the raw frame payload.
 *
 * The payload is still compressed when {@link FRAME_FLAG_COMPRESSED} is set;
 * use {@link decodeFramePayload} to transparently decompress it.
 */
export interface Frame {
  readonly flags: number;
  readonly payload: Uint8Array;
}

/**
 * EndStream trailer map: the decoded JSON object carried by a trailer frame.
 *
 * A failed stream carries an `error` entry shaped as
 * `{ code, message?, debug?: { error?, title? } }`.
 */
export type TrailerMap = Record<string, unknown>;

const HEADER_BYTES = 5;
const GZIP_MAGIC_FIRST = 0x1f;
const GZIP_MAGIC_SECOND = 0x8b;

/**
 * Encode one Connect bidi frame: 1 flag byte plus 4 big-endian length bytes
 * plus the payload, gzipped first when `opts.compress` is set.
 */
export function encodeFrame(payload: string | Uint8Array, opts?: { compress?: boolean }): Uint8Array {
  const compress = opts?.compress === true;
  const raw = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const body = compress ? gzipSync(raw) : raw;
  const out = new Uint8Array(HEADER_BYTES + body.length);
  out[0] = compress ? FRAME_FLAG_COMPRESSED : 0;
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(1, body.length);
  out.set(body, HEADER_BYTES);
  return out;
}

/**
 * Incremental Connect bidi frame decoder. Feed arbitrary byte chunks via
 * {@link push}; it buffers partial data and returns every complete frame
 * decoded so far, so sticky packets and half packets (including splits inside
 * the 4-byte length field) are handled transparently.
 */
export class FrameDecoder {
  private buffered: Uint8Array = new Uint8Array(0);

  /**
   * Feed received bytes and return the complete frames decoded so far.
   */
  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buffered.length + chunk.length);
    merged.set(this.buffered, 0);
    merged.set(chunk, this.buffered.length);
    const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
    const frames: Frame[] = [];
    let offset = 0;
    while (merged.length - offset >= HEADER_BYTES) {
      const flags = view.getUint8(offset);
      const length = view.getUint32(offset + 1);
      if (merged.length - offset - HEADER_BYTES < length) break;
      frames.push({
        flags,
        payload: merged.slice(offset + HEADER_BYTES, offset + HEADER_BYTES + length),
      });
      offset += HEADER_BYTES + length;
    }
    this.buffered = offset === 0 ? merged : merged.slice(offset);
    return frames;
  }
}

/**
 * Build a `TransformStream` that decodes incoming byte chunks into frames.
 */
export function decodeFrames(): TransformStream<Uint8Array, Frame> {
  const decoder = new FrameDecoder();
  return new TransformStream<Uint8Array, Frame>({
    transform(chunk, controller) {
      for (const frame of decoder.push(chunk)) controller.enqueue(frame);
    },
  });
}

/**
 * Return the frame payload bytes, transparently gunzipping when the frame
 * carries {@link FRAME_FLAG_COMPRESSED}.
 */
export function decodeFramePayload(frame: Frame): Uint8Array {
  if ((frame.flags & FRAME_FLAG_COMPRESSED) !== 0) return gunzipSync(frame.payload);
  return frame.payload;
}

/**
 * Decode a frame payload as JSON, transparently gunzipping first when the
 * frame carries {@link FRAME_FLAG_COMPRESSED}.
 */
export function parseFrameJson(frame: Frame): unknown {
  return JSON.parse(new TextDecoder().decode(decodeFramePayload(frame))) as unknown;
}

/**
 * Parse an EndStream trailer payload into a {@link TrailerMap}. Accepts the
 * raw JSON text or the raw payload bytes (gunzipped transparently when they
 * carry the gzip magic header).
 */
export function parseTrailers(payload: string | Uint8Array): TrailerMap {
  const text = typeof payload === 'string' ? payload : new TextDecoder().decode(maybeGunzip(payload));
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Cursor trailer payload is not a JSON object');
  }
  return parsed as TrailerMap;
}

function maybeGunzip(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 2 && bytes[0] === GZIP_MAGIC_FIRST && bytes[1] === GZIP_MAGIC_SECOND) {
    return gunzipSync(bytes);
  }
  return bytes;
}
