import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../../ws-stream-factory";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "../../ws-factory";
import {
  RELAY_AWAITING_PING_INTERVAL_MS,
  RELAY_AWAITING_PONG_TIMEOUT_MS,
  RELAY_PING_INTERVAL_MS,
  RELAY_PING_TICK_MS,
  RELAY_PONG_TIMEOUT_MS,
  RELAY_WAKE_PROBE_TIMEOUT_MS,
} from "../config";
import { RelaySocket, type RelaySocketHandlers } from "../relay-socket";
// `RelaySocket.pokeKeepalive` runs the keepalive's staleness check off the
// 25s interval schedule - the whole reason `RemoteSession.wake` can detect a
// socket the runtime's frozen interval never got the chance to notice was
// already dead (an OS sleep, a WebView suspended on app switch) - AND, for a
// socket that only LOOKS alive, holds the ping it just sent to a much
// shorter deadline than the scheduled keepalive allows, so a drop that
// happened silently during a short app switch is not mistaken for a live
// connection for the rest of a full minute. These drive the socket directly
// rather than through the full mux/Noise harness in remote-session.test.ts,
// which cannot be run under fake timers without fighting its async
// handshake dance.

class FakeSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly sent: (string | Uint8Array)[] = [];

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(_code: number, _reason: string): void {
    // The tests below only exercise `RelaySocket`'s own teardown bookkeeping,
    // never a server-initiated close, so nothing needs to happen here.
  }
}

interface FakeHandlers extends RelaySocketHandlers {
  readonly closeEvents: { code: number; reason: string }[];
}

function buildHandlers(): FakeHandlers {
  const closeEvents: { code: number; reason: string }[] = [];
  return {
    onAttachAck: () => undefined,
    onData: () => undefined,
    onHostDetached: () => undefined,
    onHostAttached: () => undefined,
    onReauthAck: () => undefined,
    onPeerGone: () => undefined,
    onError: () => undefined,
    onClose: (info) => {
      closeEvents.push(info);
    },
    closeEvents,
  };
}

describe("RelaySocket.pokeKeepalive", () => {
  let socket: FakeSocket;
  let factory: IStreamWebSocketFactory;

  beforeEach(() => {
    socket = new FakeSocket();
    factory = { create: () => socket };
  });

  it("is a no-op before the socket has opened", () => {
    const handlers = buildHandlers();
    const relaySocket = new RelaySocket({
      attachBaseUrl: "wss://relay.test/attach",
      grantJws: "grant-jws",
      webSocketFactory: factory,
      handlers,
    });

    relaySocket.pokeKeepalive();

    expect(handlers.closeEvents).toEqual([]);
    expect(socket.sent).toEqual([]);
    relaySocket.close(1000, "test-teardown");
  });

  it("sends a ping and does not close a healthy, open socket", () => {
    const handlers = buildHandlers();
    const relaySocket = new RelaySocket({
      attachBaseUrl: "wss://relay.test/attach",
      grantJws: "grant-jws",
      webSocketFactory: factory,
      handlers,
    });
    socket.onopen?.({ type: "open" });

    relaySocket.pokeKeepalive();

    expect(socket.sent).toEqual(["relay-ping"]);
    expect(handlers.closeEvents).toEqual([]);
    relaySocket.close(1000, "test-teardown");
  });

  it("fails the socket and reports the drop once the pong deadline has passed", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const handlers = buildHandlers();
      const relaySocket = new RelaySocket({
        attachBaseUrl: "wss://relay.test/attach",
        grantJws: "grant-jws",
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      // Past the pong deadline with no pong received in between - a socket
      // whose keepalive interval was frozen (device sleep, a suspended
      // WebView) and never got the chance to notice the drop on its own.
      vi.setSystemTime(RELAY_PONG_TIMEOUT_MS + 1);
      relaySocket.pokeKeepalive();

      expect(handlers.closeEvents).toEqual([
        { code: 4004, reason: "relay-missed-pongs" },
      ]);

      // The socket is already failed - a second poke must not report a
      // second drop.
      relaySocket.pokeKeepalive();
      expect(handlers.closeEvents).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op after the socket has closed", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const handlers = buildHandlers();
      const relaySocket = new RelaySocket({
        attachBaseUrl: "wss://relay.test/attach",
        grantJws: "grant-jws",
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });
      relaySocket.close(1000, "caller-teardown");

      vi.setSystemTime(RELAY_PONG_TIMEOUT_MS + 1);
      relaySocket.pokeKeepalive();

      // Caller-initiated `close()` does not itself report a drop, and a poke
      // afterwards must not manufacture one either.
      expect(handlers.closeEvents).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays open when the wake-time probe's ping is answered", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const handlers = buildHandlers();
      const relaySocket = new RelaySocket({
        attachBaseUrl: "wss://relay.test/attach",
        grantJws: "grant-jws",
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      relaySocket.pokeKeepalive();
      expect(socket.sent).toEqual(["relay-ping"]);
      // The far end answers before the probe deadline.
      socket.onmessage?.({ type: "text", data: "relay-pong" });

      vi.advanceTimersByTime(RELAY_WAKE_PROBE_TIMEOUT_MS + 1);

      expect(handlers.closeEvents).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not close immediately when the wake-time probe goes unanswered, only once its own deadline elapses", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const handlers = buildHandlers();
      const relaySocket = new RelaySocket({
        attachBaseUrl: "wss://relay.test/attach",
        grantJws: "grant-jws",
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      // The far end has gone silent - no pong ever arrives.
      relaySocket.pokeKeepalive();
      expect(handlers.closeEvents).toEqual([]);

      vi.advanceTimersByTime(RELAY_WAKE_PROBE_TIMEOUT_MS - 1);
      expect(handlers.closeEvents).toEqual([]);

      vi.advanceTimersByTime(2);
      expect(handlers.closeEvents).toEqual([
        { code: 4006, reason: "relay-wake-probe-timeout" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms a fresh probe after an earlier one was answered", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const handlers = buildHandlers();
      const relaySocket = new RelaySocket({
        attachBaseUrl: "wss://relay.test/attach",
        grantJws: "grant-jws",
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      // First wake: answered, so this probe is spent.
      relaySocket.pokeKeepalive();
      socket.onmessage?.({ type: "text", data: "relay-pong" });

      // A second wake INSIDE the first probe's original window - an app
      // switched away and back twice in quick succession. The socket died in
      // between, so nothing answers this one. It must arm a probe of its own
      // rather than being swallowed by the answered window, and the earlier
      // pong must not count as its answer.
      vi.advanceTimersByTime(RELAY_WAKE_PROBE_TIMEOUT_MS / 2);
      relaySocket.pokeKeepalive();
      expect(handlers.closeEvents).toEqual([]);

      vi.advanceTimersByTime(RELAY_WAKE_PROBE_TIMEOUT_MS + 1);

      expect(handlers.closeEvents).toEqual([
        { code: 4006, reason: "relay-wake-probe-timeout" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms a single wake-time probe across repeated pokeKeepalive calls, not one per call", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const handlers = buildHandlers();
      const relaySocket = new RelaySocket({
        attachBaseUrl: "wss://relay.test/attach",
        grantJws: "grant-jws",
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      // A burst of pokes - one per subscriber on a single visibility edge.
      // The outstanding probe is already asking this question, so the later
      // pokes send nothing at all: one ping on the wire, not one per caller.
      relaySocket.pokeKeepalive();
      relaySocket.pokeKeepalive();
      relaySocket.pokeKeepalive();
      expect(socket.sent).toEqual(["relay-ping"]);

      vi.advanceTimersByTime(RELAY_WAKE_PROBE_TIMEOUT_MS + 1);

      // One close, not three - a second and third armed probe would each
      // fire their own.
      expect(handlers.closeEvents).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still fails immediately on an already-60s-stale socket - the wake probe does not replace that verdict", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const handlers = buildHandlers();
      const relaySocket = new RelaySocket({
        attachBaseUrl: "wss://relay.test/attach",
        grantJws: "grant-jws",
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      vi.setSystemTime(RELAY_PONG_TIMEOUT_MS + 1);
      relaySocket.pokeKeepalive();

      // The scheduled-check verdict, not the shorter wake-probe one - the
      // socket never got as far as sending a fresh probe ping.
      expect(handlers.closeEvents).toEqual([
        { code: 4004, reason: "relay-missed-pongs" },
      ]);
      expect(handlers.closeEvents.some((event) => event.code === 4006)).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

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
