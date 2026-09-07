/**
 * Binary-capable WebSocket abstraction used by `WsStreamClient`.
 * Parallel to `ws-factory.ts` (which is intentionally text-only to keep `WsRpcClient` scope tight).
 */

import type { DialPriority } from "./dial-priority";
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
  | StreamWebSocketTextMessageEvent
  | StreamWebSocketBinaryMessageEvent;

  /**
   * Subset of the native WebSocket surface required by `WsStreamClient`.
   * The only shape difference from `WebSocketLike` is the widened `send(...)` and the tagged message event - both sides of the stream carry paired text + binary frames, so the text-only abstraction would not fit.
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
 * Produces a fresh `StreamWebSocketLike` for a given URL.
 * `priority` carries the same meaning as on the unary `IWebSocketFactory` (`ws-factory.ts`): a session is bound to one subscription method for its lifetime, so it can classify every dial and redial it makes.
 */
export interface IStreamWebSocketFactory {
  create(url: string, priority: DialPriority): StreamWebSocketLike;
}
