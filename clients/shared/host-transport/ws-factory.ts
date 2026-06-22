/**
 * Minimal WebSocket abstraction the per-request RPC client depends on.
 *
 * `WsRpcClient` never reads `globalThis.WebSocket`; every connection is sourced
 * through an injected `IWebSocketFactory`. The factory returns a "native-ish"
 * WebSocket object - close in shape to the platform `WebSocket` so the
 * production wiring is a thin pass-through, while still letting tests inject a
 * fully scriptable stub. All event-loop normalization (timeouts, frame
 * buffering, fatal-error mapping) stays inside `WsRpcClient`.
 */

export interface WebSocketOpenEvent {
  readonly type: "open";
}

export interface WebSocketMessageEvent {
  readonly data: string;
}

export interface WebSocketErrorEvent {
  readonly message: string;
}

export interface WebSocketCloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

/**
 * Subset of the native WebSocket surface required by `WsRpcClient`.
 *
 * The handlers are assignable so the client can install them once and replace
 * them implicitly through socket lifetime - matching the native browser API.
 * Only string payloads are exchanged on the wire, so `send` and the message
 * event are typed as `string` rather than the platform `BufferSource` union.
 */
export interface WebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null;
  onerror: ((event: WebSocketErrorEvent) => void) | null;
  onclose: ((event: WebSocketCloseEvent) => void) | null;
  send(data: string): void;
  close(code: number, reason: string): void;
}

/**
 * Creates a fresh `WebSocketLike` connection bound to the given URL. Each
 * `WsRpcClient.request` call obtains exactly one connection through this
 * factory and discards it on completion - no long-lived socket state crosses
 * requests.
 */
export interface IWebSocketFactory {
  create(url: string): WebSocketLike;
}
