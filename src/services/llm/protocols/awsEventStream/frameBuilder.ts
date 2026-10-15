/**
 * AWS EventStream frame builder
 * Ported from 9router's kiro MITM handler
 * Frame layout (big-endian):
 *   [totalLen 4B][headersLen 4B][preludeCRC 4B][headers...][payload...][messageCRC 4B]
 */

import { crc32 } from './crc32.js';

export type EventType =
  | 'initial-response'
  | 'assistantResponseEvent'
  | 'reasoningContentEvent'
  | 'toolUseEvent'
  | 'messageStopEvent'
  | 'usageEvent'
  | 'exception'
  | 'error';

export interface EventStreamFrame {
  eventType: EventType;
  payload: Record<string, unknown>;
  contentType?: string;
}

/**
 * Encode a single string header into AWS EventStream binary format.
 * Header wire format: [nameLen 1B][name][type=7 1B][valueLen 2B][value]
 */
function encodeHeader(name: string, value: string): Uint8Array {
  const nameBuf = new TextEncoder().encode(name);
  const valueBuf = new TextEncoder().encode(value);
  const buf = new Uint8Array(1 + nameBuf.length + 1 + 2 + valueBuf.length);
  let o = 0;
  buf[o++] = nameBuf.length;
  buf.set(nameBuf, o); o += nameBuf.length;
  buf[o++] = 7; // string type
  new DataView(buf.buffer, o, 2).setUint16(0, valueBuf.length, false); o += 2;
  buf.set(valueBuf, o);
  return buf;
}

/**
 * Build a single AWS EventStream binary frame with all Smithy-required headers.
 */
export function buildEventStreamFrame(
  eventType: EventType,
  payload: Record<string, unknown>,
  contentType: string = 'application/json'
): Uint8Array {
  const payloadBuf = new TextEncoder().encode(JSON.stringify(payload));

  // All three Smithy system headers are required
  const headersBuf = concatUint8Arrays([
    encodeHeader(':message-type', 'event'),
    encodeHeader(':event-type', eventType),
    encodeHeader(':content-type', contentType),
  ]);
  const headersLen = headersBuf.length;

  const totalLen = 4 + 4 + 4 + headersLen + payloadBuf.length + 4;
  const frame = new Uint8Array(totalLen);
  const view = new DataView(frame.buffer);

  view.setUint32(0, totalLen, false);
  view.setUint32(4, headersLen, false);
  view.setUint32(8, crc32(frame.slice(0, 8)), false); // prelude CRC

  frame.set(headersBuf, 12);
  frame.set(payloadBuf, 12 + headersLen);
  view.setUint32(totalLen - 4, crc32(frame.slice(0, totalLen - 4)), false); // message CRC

  return frame;
}

/**
 * Build initial-response frame (real Kiro Runtime always starts with this)
 */
export function buildInitialResponseFrame(conversationId = ''): Uint8Array {
  return buildEventStreamFrame(
    'initial-response',
    { conversationId },
    'application/x-amz-json-1.0'
  );
}

/**
 * Prepend initial-response once per stream so Smithy decoder is happy.
 */
export function withInitialFrame(state: { initialSent: boolean }, frames: Uint8Array | Uint8Array[] | null): Uint8Array | Uint8Array[] | null {
  const list = frames == null ? [] : Array.isArray(frames) ? frames : [frames];
  if (state.initialSent) return list.length === 0 ? null : list.length === 1 ? list[0] : list;
  state.initialSent = true;
  const out = [buildInitialResponseFrame(''), ...list];
  return out.length === 1 ? out[0] : out;
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}