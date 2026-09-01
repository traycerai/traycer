import type { DialPriority } from "./dial-priority";
import { hostDialGate, type DialTicket } from "./ws-dial-gate";
import type {
  IWebSocketFactory,
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "./ws-factory";

/**
 * `IWebSocketFactory` over the WHATWG `globalThis.WebSocket` - the single
 * adapter shared by every shell that has a standard WebSocket global (the
 * browser/Electron renderer and the Bun CLI). `WsRpcClient` always sends string
 * payloads, so `binaryType` is left at its default. One adapter instance per
 * dialed connection, matching the per-request socket lifetime the client owns.
 *
 * The native socket is not constructed when this wrapper is - it is
 * constructed when {@link hostDialGate} grants a slot, which is what keeps the
 * renderer's concurrent handshake count under Chromium's throttling knee. See
 * `ws-dial-gate.ts` for the measurement that motivates it.
 */
function resolveNativeWebSocketCtor(): typeof WebSocket {
  if (typeof WebSocket === "undefined") {
    throw new Error(
      "No global `WebSocket` available for the host transport on this runtime.",
    );
  }
  return WebSocket;
}

class WhatwgWebSocket implements WebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  private readonly nativeCtor: typeof WebSocket;
  private readonly url: string;
  private readonly ticket: DialTicket;
  private native: WebSocket | null = null;
  /** Guards against emitting a second close for a socket already given up on. */
  private closeRequested = false;

  constructor(url: string, priority: DialPriority) {
    // Resolved BEFORE queueing, so a runtime with no WebSocket global still
    // fails synchronously out of `create()` exactly as it did before the gate
    // existed - rather than throwing later, inside a microtask nobody awaits.
    this.nativeCtor = resolveNativeWebSocketCtor();
    this.url = url;
    this.ticket = hostDialGate.acquire(priority, () => {
      this.dial();
    });
  }

  private dial(): void {
    let native: WebSocket;
    try {
      native = new this.nativeCtor(this.url);
    } catch (cause) {
      // A URL the platform rejects. Before the gate this threw synchronously
      // out of `create()`; there is no caller frame left to throw into now, so
      // report it as what it is - a dial that failed - which is a path both
      // clients already handle. Releasing first matters more than the report:
      // a slot held by a socket that does not exist is never given back.
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
    // The slot is released on the FIRST of open/error/close - the three events
    // that mean this handshake is no longer pending. `release()` is idempotent,
    // so the usual error-then-close pair costs nothing.
    native.addEventListener("open", () => {
      this.ticket.release();
      this.onopen?.({ type: "open" });
    });
    native.addEventListener("message", (event: MessageEvent) => {
      const data =
        typeof event.data === "string" ? event.data : String(event.data);
      this.onmessage?.({ data });
    });
    native.addEventListener("error", () => {
      this.ticket.release();
      this.onerror?.({ message: "WebSocket transport error" });
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

  send(data: string): void {
    const native = this.native;
    if (native === null) {
      // Matches what the platform does when `send` is called on a CONNECTING
      // socket. Unreachable through either client - both send only after
      // `onopen` - and a silent drop would be the worse failure.
      throw new Error("Cannot send on a WebSocket that has not dialed yet.");
    }
    native.send(data);
  }

  close(code: number, reason: string): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    if (this.ticket.cancel()) {
      // Dequeued before the handshake started, so the platform never saw this
      // socket - it counted neither as a pending connection nor, once torn
      // down, as a failed one. The caller is still owed its close.
      queueMicrotask(() => {
        this.onclose?.({ code, reason, wasClean: true });
      });
      return;
    }
    // A refused cancel means the gate had already run `dial()` to completion -
    // it sets `started` and calls `start()` in one synchronous step - so either
    // `native` exists, or construction failed and its own `close` is already
    // scheduled.
    this.native?.close(code, reason);
  }
}

export function createWhatwgWebSocketFactory(): IWebSocketFactory {
  return {
    create(url: string, priority: DialPriority): WebSocketLike {
      return new WhatwgWebSocket(url, priority);
    },
  };
}
