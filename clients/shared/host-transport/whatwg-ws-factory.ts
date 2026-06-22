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

  private readonly native: WebSocket;

  constructor(url: string) {
    const Ctor = resolveNativeWebSocketCtor();
    this.native = new Ctor(url);
    this.native.addEventListener("open", () => {
      this.onopen?.({ type: "open" });
    });
    this.native.addEventListener("message", (event: MessageEvent) => {
      const data =
        typeof event.data === "string" ? event.data : String(event.data);
      this.onmessage?.({ data });
    });
    this.native.addEventListener("error", () => {
      this.onerror?.({ message: "WebSocket transport error" });
    });
    this.native.addEventListener("close", (event: CloseEvent) => {
      this.onclose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
    });
  }

  send(data: string): void {
    this.native.send(data);
  }

  close(code: number, reason: string): void {
    this.native.close(code, reason);
  }
}

export function createWhatwgWebSocketFactory(): IWebSocketFactory {
  return {
    create(url: string): WebSocketLike {
      return new WhatwgWebSocket(url);
    },
  };
}
