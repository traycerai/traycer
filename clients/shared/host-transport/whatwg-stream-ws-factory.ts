import type { DialPriority } from "./dial-priority";
import { hostDialGate, type DialTicket } from "./ws-dial-gate";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "./ws-factory";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "./ws-stream-factory";

/**
 * Binary-capable `IStreamWebSocketFactory` over the whatwg `globalThis.WebSocket`, shared by every shell with a standard WebSocket global (renderer + Bun CLI).
 * Like the unary factory, the native socket is constructed only once {@link hostDialGate} grants a slot - see `ws-dial-gate.ts`.
 */
class WhatwgStreamWebSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  private readonly url: string;
  private readonly ticket: DialTicket;
  private native: WebSocket | null = null;
  /**
   * Guards against emitting a second close for a socket already given up on, and - since a mid-dial close now aborts rather than deferring - marks the socket the caller has abandoned, so a late `open` is not announced to it.
   */
  private closeRequested = false;

  constructor(url: string, priority: DialPriority) {
  // Checked before queueing so a runtime without the global still fails
    // synchronously out of `create()`, as it did before the gate existed.
    if (typeof WebSocket === "undefined") {
      throw new Error(
        "No global `WebSocket` available for the host stream transport on this runtime.",
      );
    }
    this.url = url;
    this.ticket = hostDialGate.acquire(priority, () => {
      this.dial();
    });
  }

  private dial(): void {
    let native: WebSocket;
    try {
      native = new WebSocket(this.url);
    } catch (cause) {
      // See the unary factory: no caller frame is left to throw into, so a URL the platform rejects is reported as the failed dial it is.
      // Release first - a slot held for a socket that was never built is never returned.
      this.ticket.release();
      queueMicrotask(() => {
        this.onerror?.({
          message: `WebSocket construction failed: ${String(cause)}`,
        });
        this.onclose?.({ code: 1006, reason: "dial-failed", wasClean: false });
      });
      return;
    }
    this.native = native;
    native.binaryType = "arraybuffer";
    // Released on the first of open/error/close - the three events that end a
    // pending handshake. Idempotent, so the usual error-then-close pair is free.
    native.addEventListener("open", () => {
      this.ticket.release();
      // Aborted mid-dial: the caller has given up on this socket and its close has already been issued, so an `open` that lands anyway is not its business.
      // Only reachable if the platform completes a handshake it was told to fail; the guard costs nothing and keeps the abandoned socket from re-entering the consumer.
      if (this.closeRequested) return;
      this.onopen?.({ type: "open" });
    });
    native.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") {
        this.onmessage?.({ type: "text", data: event.data });
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        this.onmessage?.({ type: "binary", data: new Uint8Array(event.data) });
      }
    });
    native.addEventListener("error", () => {
      this.ticket.release();
      this.onerror?.({ message: "WebSocket stream transport error" });
    });
    native.addEventListener("close", (event: CloseEvent) => {
      this.ticket.release();
      this.onclose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
    });
  }

  send(data: string | Uint8Array): void {
    const native = this.native;
    if (native === null) {
      // What the platform does for a connecting socket.
      // Unreachable through `WsStreamClient` or `RelaySocket` - both send only after open - and a silent drop would be the worse failure.
      throw new Error("Cannot send on a WebSocket that has not dialed yet.");
    }
    if (typeof data === "string") {
      native.send(data);
      return;
    }
    // `Uint8Array` (generic over `ArrayBufferLike`) is no longer assignable to the DOM `BufferSource`, which requires an `ArrayBuffer`-backed view.
    native.send(new Uint8Array(data));
  }

  close(code: number, reason: string): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    if (this.ticket.cancel()) {
      // Never dialed: dequeued instead.
      queueMicrotask(() => {
        this.onclose?.({ code, reason, wasClean: true });
      });
      return;
    }
    const native = this.native;
    // Construction failed; its own close is already scheduled.
    if (native === null) return;
    // Hand the slot back here rather than leaving it to the native `open`/`error`/`close` listeners.
    this.ticket.release();
    // Closing a still-connecting socket makes the browser log "WebSocket is closed before the connection is established", which is the cost this branch used to defer to avoid.
    // Paying it is the point: it is a console line, while not closing leaves a real pending connection against the browser's own per-renderer ceiling - the very ceiling the gate exists to stay under.
    native.close(code, reason);
  }
}

export function createWhatwgStreamWebSocketFactory(): IStreamWebSocketFactory {
  return {
    create(url: string, priority: DialPriority): StreamWebSocketLike {
      return new WhatwgStreamWebSocket(url, priority);
    },
  };
}
