/**
 * Binary-capable WebSocket abstraction used by `WsStreamClient`.
 *
 * Parallel to `ws-factory.ts` (which is intentionally text-only to keep
 * `WsRpcClient` scope tight). The streaming transport is the only endpoint
 * where the client exchanges binary frames (Y.Doc snapshot bytes, Y updates,
 * awareness payloads), so the stream-facing WebSocket shape widens `send(...)`
 * and `onmessage` to carry either a text envelope or a binary payload.
 *
 * The open/error/close event shapes are identical to the unary transport so
 * both factories can share a single underlying native WebSocket implementation
 * - only the I/O channels differ.
 */

import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "./ws-factory";

export interface StreamWebSocketTextMessageEvent {
  readonly type: "text";
  readonly data: string;
}

export interface StreamWebSocketBinaryMessageEvent {
  readonly type: "binary";
  readonly data: Uint8Array;
}

export type StreamWebSocketMessageEvent =
  StreamWebSocketTextMessageEvent | StreamWebSocketBinaryMessageEvent;

/**
 * Subset of the native WebSocket surface required by `WsStreamClient`. The
 * only shape difference from `WebSocketLike` is the widened `send(...)` and
 * the tagged message event - both sides of the stream carry paired text +
 * binary frames, so the text-only abstraction would not fit.
 */
export interface StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null;
  onerror: ((event: WebSocketErrorEvent) => void) | null;
  onclose: ((event: WebSocketCloseEvent) => void) | null;
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
}

/**
 * Produces a fresh `StreamWebSocketLike` for a given URL. `WsStreamClient`
 * requests exactly one socket per connect attempt through this factory and
 * discards it on disconnect - no long-lived socket state crosses reconnects.
 */
export interface IStreamWebSocketFactory {
  create(url: string): StreamWebSocketLike;
}
