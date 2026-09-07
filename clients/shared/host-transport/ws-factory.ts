/**
 * Minimal WebSocket abstraction the per-request RPC client depends on.
 * `WsRpcClient` never reads `globalThis.WebSocket`; every connection is sourced through an injected `IWebSocketFactory`.
 */

import type { DialPriority } from "./dial-priority";

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
 * Only string payloads are exchanged on the wire, so `send` and the message event are typed as `string` rather than the platform `BufferSource` union.
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
 * Creates a fresh `WebSocketLike` connection bound to the given URL.
 * `priority` says whether anything rendered is waiting on this call, so the production factory's dial gate can let it past the boot flood (`ws-dial-gate.ts`).
 */
export interface IWebSocketFactory {
  create(url: string, priority: DialPriority): WebSocketLike;
}
