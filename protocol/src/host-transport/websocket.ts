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
 * For a socket that may wait its turn before it dials, which a dial timer has
 * to know: time spent waiting belongs to this client, and only the handshake
 * says anything about the host.
 *
 * `dialStarted` settles when the handshake starts, and never settles on a
 * socket closed before its turn. It is absent on a socket that dials as it is
 * constructed, which is every factory with no dial gate.
 */
export interface DialStartSignal {
  readonly dialStarted?: Promise<void>;
}

/**
 * Runs `start` once the handshake has started: at once for a socket with no
 * `dialStarted`, otherwise when it settles. A dial can end during that wait, so
 * `start` checks that its dial is still the live one.
 */
export function whenDialStarted(
  socket: DialStartSignal,
  start: () => void,
): void {
  if (socket.dialStarted === undefined) {
    start();
    return;
  }
  void socket.dialStarted.then(start);
}

/**
 * Subset of the native WebSocket surface required by `WsRpcClient`.
 *
 * The handlers are assignable so the client can install them once and replace
 * them implicitly through socket lifetime - matching the native browser API.
 * Only string payloads are exchanged on the wire, so `send` and the message
 * event are typed as `string` rather than the platform `BufferSource` union.
 */
export interface WebSocketLike extends DialStartSignal {
  onopen: ((event: WebSocketOpenEvent) => void) | null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null;
  onerror: ((event: WebSocketErrorEvent) => void) | null;
  onclose: ((event: WebSocketCloseEvent) => void) | null;
  send(data: string): void;
  close(code: number, reason: string): void;
}

/**
 * Creates a fresh `WebSocketLike` connection bound to the given URL.
 *
 * A host that does not advertise `unary.persistentSession` is dialed once
 * per call, and that socket is discarded when the call settles. A host that
 * does advertise it is dialed once per host and signed-in identity; later
 * calls reuse that socket. The factory itself stays one socket per `create`.
 *
 * `priority` says whether anything rendered is waiting on this call, so the
 * production factory's dial gate can let it past the boot flood
 * (`ws-dial-gate.ts`). It is REQUIRED rather than defaulted: the URL carries
 * no method, this is the last layer that still knows one, and a default would
 * silently classify every future call site.
 */
export interface IWebSocketFactory {
  create(url: string, priority: DialPriority): WebSocketLike;
}
