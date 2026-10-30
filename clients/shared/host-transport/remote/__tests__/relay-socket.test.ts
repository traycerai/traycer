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
  RELAY_AWAITING_DEADLINE_CAP_MULTIPLE,
  RELAY_AWAITING_PING_INTERVAL_MS,
  RELAY_AWAITING_PONG_TIMEOUT_MS,
  RELAY_PING_INTERVAL_MS,
  RELAY_PING_TICK_MS,
  RELAY_PONG_TIMEOUT_MS,
  RELAY_WAKE_PROBE_TIMEOUT_MS,
} from "../config";
import { InsecureRelaySchemeError } from "@traycer/protocol/host-transport/relay-attach-url";
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
      previousLeg: null,
      resumeClaim: null,
      webSocketFactory: factory,
      handlers,
    });

    relaySocket.pokeKeepalive(RELAY_WAKE_PROBE_TIMEOUT_MS, false);

    expect(handlers.closeEvents).toEqual([]);
    expect(socket.sent).toEqual([]);
    relaySocket.close(1000, "test-teardown");
  });

  it("sends a ping and does not close a healthy, open socket", () => {
    const handlers = buildHandlers();
    const relaySocket = new RelaySocket({
      attachBaseUrl: "wss://relay.test/attach",
      grantJws: "grant-jws",
      previousLeg: null,
      resumeClaim: null,
      webSocketFactory: factory,
      handlers,
    });
    socket.onopen?.({ type: "open" });

    relaySocket.pokeKeepalive(RELAY_WAKE_PROBE_TIMEOUT_MS, false);

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
        previousLeg: null,
        resumeClaim: null,
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      // Past the pong deadline with no pong received in between - a socket
      // whose keepalive interval was frozen (device sleep, a suspended
      // WebView) and never got the chance to notice the drop on its own.
      vi.setSystemTime(RELAY_PONG_TIMEOUT_MS + 1);
      relaySocket.pokeKeepalive(RELAY_WAKE_PROBE_TIMEOUT_MS, false);

      expect(handlers.closeEvents).toEqual([
        { code: 4004, reason: "relay-missed-pongs" },
      ]);

      // The socket is already failed - a second poke must not report a
      // second drop.
      relaySocket.pokeKeepalive(RELAY_WAKE_PROBE_TIMEOUT_MS, false);
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
        previousLeg: null,
        resumeClaim: null,
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });
      relaySocket.close(1000, "caller-teardown");

      vi.setSystemTime(RELAY_PONG_TIMEOUT_MS + 1);
      relaySocket.pokeKeepalive(RELAY_WAKE_PROBE_TIMEOUT_MS, false);

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
        previousLeg: null,
        resumeClaim: null,
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      relaySocket.pokeKeepalive(RELAY_WAKE_PROBE_TIMEOUT_MS, false);
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
        previousLeg: null,
        resumeClaim: null,
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      // The far end has gone silent - no pong ever arrives.
      relaySocket.pokeKeepalive(RELAY_WAKE_PROBE_TIMEOUT_MS, false);
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

  it("a retired arm's captured deadline callback is inert against the fresh arm", () => {
    vi.useFakeTimers();
    const scheduledCallbacks: Array<() => void> = [];
    const originalSetTimeout = globalThis.setTimeout;
    vi.stubGlobal(
      "setTimeout",
      (callback: () => void, delayMs: number): NodeJS.Timeout => {
        scheduledCallbacks.push(callback);
        return originalSetTimeout(callback, delayMs);
      },
    );
    try {
      vi.setSystemTime(0);
      const handlers = buildHandlers();
      const relaySocket = new RelaySocket({
        attachBaseUrl: "wss://relay.test/attach",
        grantJws: "grant-jws",
        previousLeg: null,
        resumeClaim: null,
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      // Arm A with a short deadline and a strong policy, then answer it.
      const beforeArmA = scheduledCallbacks.length;
      relaySocket.pokeKeepalive(1_000, true);
      expect(scheduledCallbacks.length).toBe(beforeArmA + 1);
      const armADeadline = scheduledCallbacks[beforeArmA];
      socket.onmessage?.({ type: "text", data: "relay-pong" });
      expect(relaySocket.hasUnansweredImmediateRedialProbe()).toBe(false);

      // Arm B: longer deadline, weaker policy.
      relaySocket.pokeKeepalive(5_000, false);
      expect(relaySocket.hasUnansweredImmediateRedialProbe()).toBe(false);

      // The stale capture of A's deadline fires anyway - a runtime is free to
      // deliver it however late. Manual invocation (not timer advancement) is
      // the point: `clearTimeout` would hide a broken token guard.
      armADeadline();
      expect(handlers.closeEvents).toEqual([]);
      expect(relaySocket.hasUnansweredImmediateRedialProbe()).toBe(false);

      // B still runs to ITS OWN deadline, producing exactly one close.
      vi.advanceTimersByTime(4_999);
      expect(handlers.closeEvents).toEqual([]);
      vi.advanceTimersByTime(2);
      expect(handlers.closeEvents).toEqual([
        { code: 4006, reason: "relay-wake-probe-timeout" },
      ]);
    } finally {
      vi.unstubAllGlobals();
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
        previousLeg: null,
        resumeClaim: null,
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      // First wake: answered, so this probe is spent.
      relaySocket.pokeKeepalive(RELAY_WAKE_PROBE_TIMEOUT_MS, false);
      socket.onmessage?.({ type: "text", data: "relay-pong" });

      // A second wake INSIDE the first probe's original window - an app
      // switched away and back twice in quick succession. The socket died in
      // between, so nothing answers this one. It must arm a probe of its own
      // rather than being swallowed by the answered window, and the earlier
      // pong must not count as its answer.
      vi.advanceTimersByTime(RELAY_WAKE_PROBE_TIMEOUT_MS / 2);
      relaySocket.pokeKeepalive(RELAY_WAKE_PROBE_TIMEOUT_MS, false);
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
        previousLeg: null,
        resumeClaim: null,
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      // A burst of pokes - one per subscriber on a single visibility edge.
      // The outstanding probe is already asking this question, so the later
      // pokes send nothing at all: one ping on the wire, not one per caller.
      relaySocket.pokeKeepalive(RELAY_WAKE_PROBE_TIMEOUT_MS, false);
      relaySocket.pokeKeepalive(RELAY_WAKE_PROBE_TIMEOUT_MS, false);
      relaySocket.pokeKeepalive(RELAY_WAKE_PROBE_TIMEOUT_MS, false);
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
        previousLeg: null,
        resumeClaim: null,
        webSocketFactory: factory,
        handlers,
      });
      socket.onopen?.({ type: "open" });

      vi.setSystemTime(RELAY_PONG_TIMEOUT_MS + 1);
      relaySocket.pokeKeepalive(RELAY_WAKE_PROBE_TIMEOUT_MS, false);

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
    previousLeg: null,
    resumeClaim: null,
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

  it("regression floor: an unmeasured path fails at exactly the old fixed RELAY_PONG_TIMEOUT_MS constant, not before", () => {
    // No pong is ever answered here, so the path estimator never gets a
    // sample and `path.deadlineMs` returns its floor argument unchanged
    // (ticket 24, A8) - the socket must behave EXACTLY as the fixed
    // constant did before the estimator existed.
    const handlers = makeHandlers({});
    openSocket(handlers);

    vi.advanceTimersByTime(RELAY_PONG_TIMEOUT_MS - 1);
    expect(handlers.onClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(handlers.onClose).toHaveBeenCalledWith({
      code: 4004,
      reason: "relay-missed-pongs",
    });
  });

  it("the path estimator only times a ping it actually sent - an orphaned pong leaves the deadline at the floor", () => {
    // A `relay-pong` that arrives with no outstanding ping (immediately
    // after open, before the keepalive's first tick has sent one) must not
    // produce a round-trip sample. Proven behaviourally: if it wrongly fed a
    // sample, the derived deadline would move off the exact
    // RELAY_PONG_TIMEOUT_MS floor asserted below - it would either fail
    // early (a spuriously short sample) or survive well past it (Date.now()
    // minus a null/garbage baseline clamped to MAX_RELAY_PATH_RTT_MS).
    const handlers = makeHandlers({});
    const { stream } = openSocket(handlers);

    stream.emitPong();
    expect(stream.pingsSent).toBe(0);

    vi.advanceTimersByTime(RELAY_PONG_TIMEOUT_MS - 1);
    expect(handlers.onClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(handlers.onClose).toHaveBeenCalledWith({
      code: 4004,
      reason: "relay-missed-pongs",
    });
  });

  it("derived lengthening: slow round trips push the missed-pong deadline past the old fixed constant", () => {
    // The keepalive's own ping/pong drives `path.notePingSent` /
    // `path.notePongReceived` (the estimator times the round trip; there is no
    // `noteRoundTrip` on its surface for a caller to feed), so a SLOW
    // but genuinely live path measures its own headroom and stops reading
    // its propagation delay as backlog (F11's false-positive teardowns).
    const handlers = makeHandlers({});
    const { stream } = openSocket(handlers);

    // Let the idle keepalive send its first ping.
    vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS);
    expect(stream.pingsSent).toBe(1);

    // Answer it 8s later - a slow but real round trip.
    const SLOW_ROUND_TRIP_MS = 8_000;
    vi.advanceTimersByTime(SLOW_ROUND_TRIP_MS);
    stream.emitPong();

    // relay-liveness.ts: first sample seeds srtt=sample, rttvar=sample/2, so
    // srtt=8000, rttvar=4000. deadlineMs(floor, roundTrips) =
    // max(floor, round(roundTrips * (srtt + 4 * rttvar))) =
    // max(60_000, round(3 * (8_000 + 4 * 4_000))) = max(60_000, 72_000) =
    // 72_000 - strictly larger than the RELAY_PONG_TIMEOUT_MS floor it
    // replaces.
    const DERIVED_DEADLINE_MS = 72_000;

    // Silence past the OLD fixed constant (60s) since this last inbound
    // frame (the pong itself) must no longer tear the socket down.
    vi.advanceTimersByTime(RELAY_PONG_TIMEOUT_MS + 1_000);
    expect(handlers.onClose).not.toHaveBeenCalled();

    // Only silence past the DERIVED deadline does.
    const remainingToDerivedDeadline =
      DERIVED_DEADLINE_MS - (RELAY_PONG_TIMEOUT_MS + 1_000);
    vi.advanceTimersByTime(remainingToDerivedDeadline + 1_000);
    expect(handlers.onClose).toHaveBeenCalledWith({
      code: 4004,
      reason: "relay-missed-pongs",
    });
  });

  it("Karn (RFC 6298 §3): an ambiguous run - a second ping sent before the first is answered - records no sample", () => {
    // Two idle-cadence pings go out with neither answered before the
    // second, so the run is ambiguous; the one slow pong that eventually
    // lands must not be credited to either ping.
    const handlers = makeHandlers({});
    const { stream } = openSocket(handlers);

    vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS);
    expect(stream.pingsSent).toBe(1);

    vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS);
    expect(stream.pingsSent).toBe(2);

    // A single slow pong answers the ambiguous run.
    stream.emitPong();

    // With no sample recorded, the idle deadline still floors at
    // RELAY_PONG_TIMEOUT_MS - measured from THIS pong (the last inbound
    // frame), not lengthened by the run it just closed.
    vi.advanceTimersByTime(RELAY_PONG_TIMEOUT_MS - RELAY_PING_TICK_MS);
    expect(handlers.onClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2 * RELAY_PING_TICK_MS);
    expect(handlers.onClose).toHaveBeenCalledWith({
      code: 4004,
      reason: "relay-missed-pongs",
    });
  });

  it("the awaiting-lane deadline is capped at RELAY_AWAITING_DEADLINE_CAP_MULTIPLE x RELAY_AWAITING_PONG_TIMEOUT_MS however slow the measured path is", () => {
    const handlers = makeHandlers({});
    const { socket, stream } = openSocket(handlers);

    // One slow-but-UNAMBIGUOUS idle round trip, fed before any application
    // traffic, is enough on its own to push the estimator's uncapped
    // computation past the cap: first-sample seed srtt=4_500, rttvar=2_250,
    // so round(3 * (4_500 + 4 * 2_250)) = 40_500ms - above the cap below.
    vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS);
    expect(stream.pingsSent).toBe(1);
    const SLOW_ROUND_TRIP_MS = 4_500;
    vi.advanceTimersByTime(SLOW_ROUND_TRIP_MS);
    stream.emitPong();

    // Now enter the awaiting lane with application traffic that never gets
    // a reply - the same (already-inflated) estimator sizes this deadline.
    vi.advanceTimersByTime(1);
    socket.sendData(new Uint8Array([1]));

    const CAP_MS =
      RELAY_AWAITING_DEADLINE_CAP_MULTIPLE * RELAY_AWAITING_PONG_TIMEOUT_MS;
    expect(CAP_MS).toBe(36_000);

    // Comfortably before the capped deadline: still open, despite the
    // uncapped 40_500ms the estimator alone would derive.
    vi.advanceTimersByTime(CAP_MS - RELAY_PING_TICK_MS);
    expect(handlers.onClose).not.toHaveBeenCalled();

    // The cap - not the uncapped derived value - is what closes it.
    vi.advanceTimersByTime(2 * RELAY_PING_TICK_MS);
    expect(handlers.onClose).toHaveBeenCalledWith({
      code: 4004,
      reason: "relay-missed-pongs",
    });
  });

  it("a pong arriving after a wake probe retires a pre-suspend scheduled ping's ambiguity - no sample recorded", () => {
    // A scheduled keepalive ping goes out and is left outstanding across a
    // simulated suspend (nothing answers it before the wake probe fires).
    const handlers = makeHandlers({});
    const { socket, stream } = openSocket(handlers);

    vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS);
    expect(stream.pingsSent).toBe(1);

    // The runtime freezes: the clock jumps but NO timer callback runs across
    // the gap (unlike `advanceTimersByTime`, which would fire every
    // intervening tick) - the exact condition `pokeKeepalive` exists to
    // catch, per its own doc comment. Kept short enough that the raw elapsed
    // time alone does not already exceed the still-unmeasured floor
    // (RELAY_PONG_TIMEOUT_MS), so the poke's own staleness check does not
    // fail the socket before the retirement behaviour under test runs.
    const SUSPEND_GAP_MS = 30_000;
    vi.setSystemTime(Date.now() + SUSPEND_GAP_MS);

    // On wake, `runKeepaliveTick` retires the pre-suspend ping
    // (`pingSentAt = null; pingAmbiguous = true`) and force-sends its own
    // ping, deliberately excluded from measurement - its round trip would
    // otherwise carry the whole suspend gap as "path latency".
    socket.pokeKeepalive(RELAY_WAKE_PROBE_TIMEOUT_MS, false);
    expect(stream.pingsSent).toBe(2);

    // The pong that eventually lands answers both the retired ping and the
    // wake ping indistinguishably. If the retirement did not happen, this
    // pong would be timed against the PRE-SUSPEND ping - a ~30s round trip,
    // clamped to MAX_RELAY_PATH_RTT_MS but still ballooning the deadline
    // (round(3 * (10_000 + 4 * 5_000)) = 90_000ms) well past the floor
    // asserted below.
    vi.advanceTimersByTime(1);
    stream.emitPong();

    vi.advanceTimersByTime(RELAY_PONG_TIMEOUT_MS - RELAY_PING_TICK_MS);
    expect(handlers.onClose).not.toHaveBeenCalled();

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

/**
 * The sibling of the host leg's own gate (browser-security-hardening H11).
 * Both legs build the same grant-in-query URL from the same configured base,
 * so both refuse the same schemes - the shared assertion lives in
 * `@traycer/protocol/host-transport/relay-attach-url`.
 */
describe("RelaySocket (client leg) attach-URL scheme gate", () => {
  it("refuses a remote cleartext dial before any socket is created", () => {
    const socket = new FakeSocket();
    let created = 0;
    const factory: IStreamWebSocketFactory = {
      create: () => {
        created += 1;
        return socket;
      },
    };

    expect(
      () =>
        new RelaySocket({
          attachBaseUrl: "ws://relay.test/attach",
          grantJws: "grant-jws",
          previousLeg: null,
          resumeClaim: null,
          webSocketFactory: factory,
          handlers: buildHandlers(),
        }),
    ).toThrow(InsecureRelaySchemeError);
    expect(created).toBe(0);
  });

  it("still dials wss: and cleartext loopback", () => {
    for (const attachBaseUrl of [
      "wss://relay.test/attach",
      "ws://localhost:8787/attach",
      "ws://127.0.0.1:8787/attach",
    ]) {
      const socket = new FakeSocket();
      const relaySocket = new RelaySocket({
        attachBaseUrl,
        grantJws: "grant-jws",
        previousLeg: null,
        resumeClaim: null,
        webSocketFactory: { create: () => socket },
        handlers: buildHandlers(),
      });
      relaySocket.close(1000, "test-teardown");
    }
  });
});

describe("RelaySocket onTextBytes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a text frame's exact UTF-8 byte length, not its UTF-16 string length", () => {
    const onTextBytes = vi.fn();
    const handlers = makeHandlers({ onTextBytes });
    const { stream } = openSocket(handlers);

    // Two emoji: 2 UTF-16 code units each (a surrogate pair), 4 UTF-8 bytes
    // each. `"\u{1F600}".length` is 2, but its UTF-8 encoding is 4 bytes -
    // counting `.length` would report 4 for this frame, not 8.
    const text = "\u{1F600}\u{1F600}";
    expect(text.length).toBe(4);

    stream.emitText(text);

    expect(onTextBytes).toHaveBeenCalledTimes(1);
    expect(onTextBytes).toHaveBeenCalledWith(8);
  });
});

/**
 * The direct leg (`directUrl`): the server pool, dialed with no relay in
 * between. The socket's own open is the attach, relay control frames have no
 * standing from a direct peer, and the keepalive pair is the one the pool
 * answers.
 */
describe("RelaySocket direct leg", () => {
  const RELAY_CONTROL_FRAMES: readonly string[] = [
    JSON.stringify({ type: "host_detached" }),
    JSON.stringify({ type: "host_attached" }),
    JSON.stringify({ type: "reauth_ack" }),
    JSON.stringify({ type: "peer_gone", reason: "host-gone" }),
    JSON.stringify({ type: "killed", reason: "revoked" }),
    JSON.stringify({ type: "error", code: "E_X", message: "nope" }),
  ];

  function openDirect(handlers: RelaySocketHandlers): {
    readonly socket: RelaySocket;
    readonly stream: FakeStreamSocket;
    readonly dialedUrls: string[];
  } {
    const dialedUrls: string[] = [];
    const stream = new FakeStreamSocket();
    const socket = new RelaySocket({
      directUrl: "wss://pool.test/v1/session",
      webSocketFactory: {
        create: (url) => {
          dialedUrls.push(url);
          return stream;
        },
      },
      handlers,
    });
    return { socket, stream, dialedUrls };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dials the pool URL as given, with no grant, and fires attach exactly when the socket opens", () => {
    const handlers = makeHandlers({});
    const { socket, stream, dialedUrls } = openDirect(handlers);

    expect(dialedUrls).toEqual(["wss://pool.test/v1/session"]);
    expect(handlers.onAttachAck).not.toHaveBeenCalled();

    stream.open();

    expect(handlers.onAttachAck).toHaveBeenCalledTimes(1);
    socket.close(1000, "test-teardown");
  });

  it("drops every relay control frame, while the relay leg still acts on them", () => {
    const direct = makeHandlers({});
    const { socket: directSocket, stream: directStream } = openDirect(direct);
    directStream.open();
    for (const frame of RELAY_CONTROL_FRAMES) {
      directStream.emitText(frame);
    }

    expect(direct.onHostDetached).not.toHaveBeenCalled();
    expect(direct.onHostAttached).not.toHaveBeenCalled();
    expect(direct.onReauthAck).not.toHaveBeenCalled();
    expect(direct.onPeerGone).not.toHaveBeenCalled();
    expect(direct.onError).not.toHaveBeenCalled();
    // A control frame a relay may legitimately send must not be able to
    // re-fire attach on a direct leg either: attach fired once, at open.
    expect(direct.onAttachAck).toHaveBeenCalledTimes(1);

    const relay = makeHandlers({});
    const { socket: relaySocket, stream: relayStream } = openSocket(relay);
    relayStream.emitText(RELAY_CONTROL_FRAMES[0]);
    expect(relay.onHostDetached).toHaveBeenCalledTimes(1);

    directSocket.close(1000, "test-teardown");
    relaySocket.close(1000, "test-teardown");
  });

  it("refuses a cleartext non-loopback URL before any socket is created, and still dials loopback", () => {
    let created = 0;
    const factory: IStreamWebSocketFactory = {
      create: () => {
        created += 1;
        return new FakeStreamSocket();
      },
    };

    expect(
      () =>
        new RelaySocket({
          directUrl: "ws://pool.test/v1/session",
          webSocketFactory: factory,
          handlers: makeHandlers({}),
        }),
    ).toThrow(InsecureRelaySchemeError);
    expect(created).toBe(0);

    const loopback = new RelaySocket({
      directUrl: "ws://127.0.0.1:8788/v1/session",
      webSocketFactory: factory,
      handlers: makeHandlers({}),
    });
    expect(created).toBe(1);
    loopback.close(1000, "test-teardown");
  });

  it("pings with exactly relay-ping, answers a peer relay-ping with exactly relay-pong, and passes a received relay-pong to no handler", () => {
    const handlers = makeHandlers({});
    const { socket, stream } = openDirect(handlers);
    stream.open();

    vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS);
    expect(stream.sent).toEqual(["relay-ping"]);

    stream.emitText("relay-ping");
    expect(stream.sent).toEqual(["relay-ping", "relay-pong"]);

    stream.emitPong();
    expect(handlers.onData).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onPeerGone).not.toHaveBeenCalled();
    expect(handlers.onHostDetached).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
    socket.close(1000, "test-teardown");
  });

  it("closes at RELAY_PONG_TIMEOUT_MS when nothing at all comes back", () => {
    const handlers = makeHandlers({});
    const { stream } = openDirect(handlers);
    stream.open();

    vi.advanceTimersByTime(RELAY_PONG_TIMEOUT_MS - 1);
    expect(handlers.onClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(handlers.onClose).toHaveBeenCalledWith({
      code: 4004,
      reason: "relay-missed-pongs",
    });
  });
});

describe("RelaySocket attach URL", () => {
  /** The `prev` the URL handed to the WebSocket factory carries. */
  function prevOf(previousLeg: {
    code: number;
    reason: string;
  }): string | null {
    const urls: string[] = [];
    const relaySocket = new RelaySocket({
      attachBaseUrl: "wss://relay.test/attach",
      grantJws: "grant-jws",
      previousLeg,
      resumeClaim: null,
      webSocketFactory: {
        create: (url) => {
          urls.push(url);
          return new FakeSocket();
        },
      },
      handlers: buildHandlers(),
    });
    relaySocket.close(1000, "test-teardown");
    return new URL(urls[0] ?? "").searchParams.get("prev");
  }

  it("keeps the reason of a previous leg whose reason is a known one", () => {
    expect(prevOf({ code: 4007, reason: "relay-relink" })).toBe(
      "4007:relay-relink",
    );
  });

  it("sends the code with an empty reason for a reason outside the known set", () => {
    expect(prevOf({ code: 1000, reason: "forced-reconnect:wake" })).toBe(
      "1000:",
    );
  });
});
