import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../../ws-stream-factory";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
} from "../../ws-factory";
import {
  RELAY_AWAITING_PING_INTERVAL_MS,
  RELAY_AWAITING_PONG_TIMEOUT_MS,
  RELAY_PING_INTERVAL_MS,
  RELAY_PING_TICK_MS,
  RELAY_PONG_TIMEOUT_MS,
} from "../config";
import { RelaySocket, type RelaySocketHandlers } from "../relay-socket";

/**
 * A `StreamWebSocketLike` double that opens synchronously and records every
 * outbound frame. `emitPong`/`emitBinary` let a test hand-drive inbound
 * traffic without a real relay.
 */
class FakeStreamSocket implements StreamWebSocketLike {
  onopen: ((event: { readonly type: "open" }) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly sent: Array<string | Uint8Array> = [];
  closed = false;

  send(data: string | Uint8Array): void {
    if (this.closed) {
      throw new Error("socket is closed");
    }
    this.sent.push(data);
  }

  close(_code: number, _reason: string): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.({ type: "open" });
  }

  emitText(raw: string): void {
    this.onmessage?.({ type: "text", data: raw });
  }

  emitPong(): void {
    this.emitText("relay-pong");
  }

  emitBinary(data: Uint8Array): void {
    this.onmessage?.({ type: "binary", data });
  }

  get pingsSent(): number {
    return this.sent.filter((frame) => frame === "relay-ping").length;
  }
}

function makeHandlers(
  overrides: Partial<RelaySocketHandlers>,
): RelaySocketHandlers {
  return {
    onAttachAck: vi.fn(),
    onData: vi.fn(),
    onHostDetached: vi.fn(),
    onHostAttached: vi.fn(),
    onReauthAck: vi.fn(),
    onPeerGone: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function makeFactory(): {
  readonly factory: IStreamWebSocketFactory;
  readonly sockets: FakeStreamSocket[];
} {
  const sockets: FakeStreamSocket[] = [];
  return {
    sockets,
    factory: {
      create: () => {
        const socket = new FakeStreamSocket();
        sockets.push(socket);
        return socket;
      },
    },
  };
}

/** Opens a fresh `RelaySocket` against a fake transport, past the dial handshake. */
function openSocket(handlers: RelaySocketHandlers): {
  readonly socket: RelaySocket;
  readonly stream: FakeStreamSocket;
} {
  const { factory, sockets } = makeFactory();
  const socket = new RelaySocket({
    attachBaseUrl: "wss://relay.test/attach",
    grantJws: "grant",
    webSocketFactory: factory,
    handlers,
  });
  const stream = sockets[0];
  stream.open();
  return { socket, stream };
}

describe("RelaySocket adaptive half-open detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("idle socket: pings on the 25s cadence and does not fail before 60s of silence", () => {
    const handlers = makeHandlers({});
    const { stream } = openSocket(handlers);

    // Just under the idle deadline: still silent, no ping cadence violated,
    // and the socket must not have failed yet.
    vi.advanceTimersByTime(RELAY_PONG_TIMEOUT_MS - 1);
    expect(handlers.onClose).not.toHaveBeenCalled();
    // Idle cadence: a ping roughly every 25s, so ~2 pings land inside a
    // window just under 60s (at 25s and 50s).
    expect(stream.pingsSent).toBeGreaterThanOrEqual(2);

    vi.advanceTimersByTime(1);
    expect(handlers.onClose).toHaveBeenCalledWith({
      code: 4004,
      reason: "relay-missed-pongs",
    });
  });

  it("after application traffic with no inbound reply: pings at 5s and fails at ~12s", () => {
    const handlers = makeHandlers({});
    const { socket } = openSocket(handlers);

    vi.advanceTimersByTime(1);
    socket.sendData(new Uint8Array([1, 2, 3]));

    // Comfortably before the fast deadline: not failed yet. The deadline is
    // only re-evaluated on the RELAY_PING_TICK_MS tick, so leave margin
    // under it rather than asserting to the exact millisecond.
    vi.advanceTimersByTime(RELAY_AWAITING_PONG_TIMEOUT_MS - RELAY_PING_TICK_MS);
    expect(handlers.onClose).not.toHaveBeenCalled();

    // The deadline is detected on the first tick at or after it elapses -
    // at most one extra tick beyond RELAY_AWAITING_PONG_TIMEOUT_MS.
    vi.advanceTimersByTime(2 * RELAY_PING_TICK_MS);
    expect(handlers.onClose).toHaveBeenCalledWith({
      code: 4004,
      reason: "relay-missed-pongs",
    });
  });

  it("pings at the fast 5s cadence once awaiting a reply to application traffic", () => {
    const handlers = makeHandlers({});
    const { socket, stream } = openSocket(handlers);

    vi.advanceTimersByTime(1);
    socket.sendData(new Uint8Array([1]));
    vi.advanceTimersByTime(RELAY_AWAITING_PING_INTERVAL_MS);
    const pingsAfterFirstFastTick = stream.pingsSent;
    expect(pingsAfterFirstFastTick).toBeGreaterThanOrEqual(1);

    vi.advanceTimersByTime(RELAY_AWAITING_PING_INTERVAL_MS);
    expect(stream.pingsSent).toBeGreaterThan(pingsAfterFirstFastTick);
  });

  it("a healthy idle socket whose last inbound was a ~25s-old pong does not fail the instant application traffic is sent", () => {
    // This is the regression the whole design exists to prevent: the fast
    // deadline must run from `awaitingSince`, never from `lastInboundAt`.
    // A stale-but-healthy `lastInboundAt` would otherwise make a brand-new
    // send look like it has already been silent for the fast deadline's
    // full duration.
    const handlers = makeHandlers({});
    const { socket, stream } = openSocket(handlers);

    // Let the idle pong arrive, then let ~25s pass with nothing else
    // happening - a perfectly healthy idle socket.
    stream.emitPong();
    vi.advanceTimersByTime(RELAY_AWAITING_PONG_TIMEOUT_MS + 5_000);
    expect(handlers.onClose).not.toHaveBeenCalled();

    // The user types: application traffic goes out with no reply yet.
    vi.advanceTimersByTime(1);
    socket.sendData(new Uint8Array([9]));

    // If the fast deadline were measured from `lastInboundAt`, the socket
    // would already look "silent" for RELAY_AWAITING_PONG_TIMEOUT_MS + 5s
    // and fail on the very next tick. It must not.
    vi.advanceTimersByTime(RELAY_PING_TICK_MS);
    expect(handlers.onClose).not.toHaveBeenCalled();

    // It only fails once the fast deadline has genuinely elapsed from the
    // moment the send opened the unanswered run - comfortably before that,
    // it must still be healthy.
    vi.advanceTimersByTime(
      RELAY_AWAITING_PONG_TIMEOUT_MS - 2 * RELAY_PING_TICK_MS,
    );
    expect(handlers.onClose).not.toHaveBeenCalled();
    // And it fails within one tick of the deadline genuinely elapsing.
    vi.advanceTimersByTime(2 * RELAY_PING_TICK_MS);
    expect(handlers.onClose).toHaveBeenCalledWith({
      code: 4004,
      reason: "relay-missed-pongs",
    });
  });

  it("any inbound frame counts as liveness, not just a pong", () => {
    const handlers = makeHandlers({});
    const { socket, stream } = openSocket(handlers);

    socket.sendData(new Uint8Array([1]));
    // Binary application data answers the send just as well as a pong would.
    vi.advanceTimersByTime(RELAY_AWAITING_PONG_TIMEOUT_MS - 1_000);
    stream.emitBinary(new Uint8Array([2]));

    // The awaiting run is now closed; a further full fast deadline must NOT
    // trip the socket, because the reply reset lastInboundAt.
    vi.advanceTimersByTime(RELAY_AWAITING_PONG_TIMEOUT_MS - 1);
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it("a send in the SAME millisecond as the last inbound frame is still awaiting a reply", () => {
    // The commonest shape there is: a stream frame arrives and its handler
    // synchronously issues the next request, so the send and the inbound land
    // on one `Date.now()` reading. A strict timestamp comparison calls that
    // "not awaiting" and parks a half-open socket on the 60s idle deadline
    // rather than the 12s detection one - the tie has to resolve in favour of
    // the unanswered send, because a send with nothing after it is exactly
    // what "awaiting" means.
    const handlers = makeHandlers({});
    const { socket, stream } = openSocket(handlers);

    stream.emitBinary(new Uint8Array([1]));
    expect(socket.sendData(new Uint8Array([2]))).toBe(true);

    // Comfortably inside the fast deadline: still healthy, so the assertion
    // below cannot pass from a socket that failed for some unrelated reason.
    vi.advanceTimersByTime(RELAY_AWAITING_PONG_TIMEOUT_MS - RELAY_PING_TICK_MS);
    expect(handlers.onClose).not.toHaveBeenCalled();

    // Past it, with nothing having come back: the fast deadline must fire.
    // On the 60s idle deadline this socket would still look perfectly fine.
    vi.advanceTimersByTime(2 * RELAY_PING_TICK_MS);
    expect(handlers.onClose).toHaveBeenCalledWith({
      code: 4004,
      reason: "relay-missed-pongs",
    });
  });

  it("a keepalive ping alone does not put the socket into the fast mode", () => {
    const handlers = makeHandlers({});
    const { stream } = openSocket(handlers);

    // Drive the idle keepalive: a ping goes out around 25s with nothing
    // outbound from the application. That must not switch the cadence to
    // the 5s/12s fast pair - only application traffic (`sendData`) does.
    vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS);
    expect(stream.pingsSent).toBeGreaterThanOrEqual(1);

    // Still on the idle cadence: surviving comfortably past the fast
    // deadline (12s), with margin for tick granularity, with no reply is
    // expected and must not fail the socket, since only the idle 60s
    // deadline governs here.
    vi.advanceTimersByTime(
      RELAY_AWAITING_PONG_TIMEOUT_MS + 2 * RELAY_PING_TICK_MS,
    );
    expect(handlers.onClose).not.toHaveBeenCalled();
  });
});
