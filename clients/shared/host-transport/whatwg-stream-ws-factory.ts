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
 * Binary-capable `IStreamWebSocketFactory` over the WHATWG
 * `globalThis.WebSocket`, shared by every shell with a standard WebSocket
 * global (renderer + Bun CLI). Sets `binaryType = "arraybuffer"` so the stream
 * transport routes `update` / `snapshot` payload bytes directly.
 */
class WhatwgStreamWebSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  private readonly native: WebSocket;
  /** Set when close() is called mid-dial; honored once the socket opens. */
  private pendingClose: {
    readonly code: number;
    readonly reason: string;
  } | null = null;

  constructor(url: string) {
    if (typeof WebSocket === "undefined") {
      throw new Error(
        "No global `WebSocket` available for the host stream transport on this runtime.",
      );
    }
    this.native = new WebSocket(url);
    this.native.binaryType = "arraybuffer";
    this.native.addEventListener("open", () => {
      if (this.pendingClose !== null) {
        this.native.close(this.pendingClose.code, this.pendingClose.reason);
        return;
      }
      this.onopen?.({ type: "open" });
    });
    this.native.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") {
        this.onmessage?.({ type: "text", data: event.data });
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        this.onmessage?.({ type: "binary", data: new Uint8Array(event.data) });
      }
    });
    this.native.addEventListener("error", () => {
      this.onerror?.({ message: "WebSocket stream transport error" });
    });
    this.native.addEventListener("close", (event: CloseEvent) => {
      this.onclose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
    });
  }

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.native.send(data);
      return;
    }
    // `Uint8Array` (generic over `ArrayBufferLike`) is no longer assignable to
    // the DOM `BufferSource`, which requires an `ArrayBuffer`-backed view. Copy
    // into a fresh `ArrayBuffer`-backed array; the browser copies into its send
    // buffer on `send()` regardless, so this adds no extra observable cost.
    this.native.send(new Uint8Array(data));
  }

  close(code: number, reason: string): void {
    // Closing a socket that is still CONNECTING makes the browser log
    // "WebSocket is closed before the connection is established". The close
    // can't be honored until the handshake finishes, so record the intent and
    // let the constructor's `open` handler issue it. If the socket never opens
    // (errors/closes mid-dial) the intent is simply dropped with the wrapper -
    // no dangling listener, no close on an abandoned socket.
    if (this.native.readyState === WebSocket.CONNECTING) {
      this.pendingClose = { code, reason };
      return;
    }
    this.native.close(code, reason);
  }
}

export function createWhatwgStreamWebSocketFactory(): IStreamWebSocketFactory {
  return {
    create(url: string): StreamWebSocketLike {
      return new WhatwgStreamWebSocket(url);
    },
  };
}
