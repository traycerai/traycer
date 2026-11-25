import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "@traycer/protocol/host-transport/websocket";
import type { ConnectionManifest } from "@traycer/protocol/framework/ws-protocol";
import {
  ANSWERS_AT_ONCE,
  deferred,
  readFrame,
  refusalFrame,
  type Deferred,
  type DoorScript,
  type MintEdge,
} from "./expired-host-token-harness";

/**
 * The host's unary door (`/rpc`) on the same fake host as the stream door: the
 * real `callHostRpc` dials it with the real `WsRpcClient`. It reads the token
 * of every open the way `FakeHost` does, and answers a request frame with the
 * result the case serves.
 */

export interface UnaryOpenSeen {
  readonly index: number;
  readonly token: unknown;
  readonly mintStillOut: boolean;
}

class UnarySocket implements WebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  constructor(
    readonly index: number,
    private readonly door: UnaryDoor,
  ) {}

  send(data: string): void {
    this.door.heard(this, readFrame(data));
  }

  close(): void {}

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  fireClose(code: number, reason: string): void {
    this.onclose?.({ code, reason, wasClean: false });
  }
}

export class UnaryDoor {
  readonly opens: UnaryOpenSeen[] = [];
  /** The answer to the held, expired token; by open index, else `expired`. */
  expired: DoorScript = ANSWERS_AT_ONCE("token-expired");
  readonly expiredAt = new Map<number, DoorScript>();
  /** The answer to the placeholder an open with no token presents. */
  probe: DoorScript = ANSWERS_AT_ONCE("owner-sign-in");
  /** What the host serves for a unary request. */
  serve: (method: string, params: unknown) => unknown = () => {
    throw new Error("no unary read was expected");
  };
  /** Every request frame the host read: on which connection, and what. */
  readonly requests: { index: number; method: string }[] = [];
  /**
   * What the host does with a request instead of answering it: closes the
   * connection naming `token_expired` (the token's end passed), or drops the
   * transport. `null` answers it.
   */
  cutAfterRequest: (
    method: string,
    openIndex: number,
  ) => "token-expired" | "drop" | null = () => null;
  /** Answers of this method wait for `hold`: the request is on the wire, unanswered. */
  holdMethod: string | null = null;
  hold: Promise<void> | null = null;
  private readonly sockets: UnarySocket[] = [];
  private readonly requested = new Map<string, Deferred>();
  private made = 0;
  private readonly opened = new Map<number, Deferred>();
  private readonly refused = new Map<number, Deferred>();

  constructor(
    private readonly mint: MintEdge,
    private readonly expiredHeld: string,
  ) {}

  accept(): WebSocketLike {
    const socket = new UnarySocket(this.made, this);
    this.sockets.push(socket);
    this.made += 1;
    queueMicrotask(() => socket.fireOpen());
    return socket;
  }

  /** Settles when the host has read the open of this index. */
  whenOpened(index: number): Promise<void> {
    return this.latch(index, this.opened).promise;
  }

  /** Settles when the host has sent its refusal on the socket of this index. */
  whenRefused(index: number): Promise<void> {
    return this.latch(index, this.refused).promise;
  }

  /** Settles when the host has read a request of this method. */
  whenRequested(method: string): Promise<void> {
    let latch = this.requested.get(method);
    if (latch === undefined) {
      latch = deferred();
      this.requested.set(method, latch);
    }
    return latch.promise;
  }

  /** The token's end passes on connection `index`: the host closes it, `token_expired`. */
  cut(index: number): void {
    this.sockets[index]?.fireMessage(refusalFrame("token-expired"));
  }

  private latch(index: number, book: Map<number, Deferred>): Deferred {
    let latch = book.get(index);
    if (latch === undefined) {
      latch = deferred();
      book.set(index, latch);
    }
    return latch;
  }

  heard(socket: UnarySocket, frame: Record<string, unknown>): void {
    if (frame.kind === "open") {
      this.readOpen(socket, frame);
      return;
    }
    if (frame.kind === "request") {
      const method = String(frame.method);
      this.requests.push({ index: socket.index, method });
      void this.whenRequested(method);
      this.latchOf(method).settle();
      const cut = this.cutAfterRequest(method, socket.index);
      // Never inside the client's own `send`: a host answers a later turn.
      void (async (): Promise<void> => {
        await Promise.resolve();
        if (cut === "token-expired") {
          socket.fireMessage(refusalFrame("token-expired"));
          this.latch(socket.index, this.refused).settle();
          return;
        }
        if (cut === "drop") {
          socket.fireClose(1006, "connection lost");
          return;
        }
        if (this.hold !== null && this.holdMethod === method) await this.hold;
        socket.fireMessage({
          kind: "response",
          requestId: frame.requestId,
          method: frame.method,
          schemaVersion: frame.schemaVersion,
          result: this.serve(method, frame.params),
          error: null,
        });
      })();
    }
  }

  private readOpen(socket: UnarySocket, open: Record<string, unknown>): void {
    const token = open.token;
    this.opens[socket.index] = {
      index: socket.index,
      token,
      mintStillOut: this.mint.isOut(),
    };
    this.latch(socket.index, this.opened).settle();
    const script = this.scriptFor(socket.index, token);
    void (async (): Promise<void> => {
      await Promise.resolve();
      if (script.after !== null) await script.after;
      if (script.answer === "admit") {
        // The manifest as asked: this host serves every method the call names.
        const manifest = open.manifest as ConnectionManifest;
        socket.fireMessage({
          kind: "openAck",
          manifest,
          optionalManifest: open.optionalManifest,
        });
        return;
      }
      socket.fireMessage(refusalFrame(script.answer));
      this.latch(socket.index, this.refused).settle();
    })();
  }

  private latchOf(method: string): Deferred {
    void this.whenRequested(method);
    const latch = this.requested.get(method);
    if (latch === undefined) throw new Error("latch missing");
    return latch;
  }

  private scriptFor(index: number, token: unknown): DoorScript {
    if (token === this.expiredHeld)
      return this.expiredAt.get(index) ?? this.expired;
    if (token === NO_HOST_TOKEN_PROBE) return this.probe;
    return ANSWERS_AT_ONCE("admit");
  }
}
