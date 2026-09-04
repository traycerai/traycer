import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDialGate, hostDialGate } from "../ws-dial-gate";
import { createWhatwgWebSocketFactory } from "../whatwg-ws-factory";
import { createWhatwgStreamWebSocketFactory } from "../whatwg-stream-ws-factory";
import type { WebSocketLike } from "../ws-factory";
import type { StreamWebSocketLike } from "../ws-stream-factory";

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("createDialGate: the concurrent-handshake cap and its queueing rules", () => {
  it("starts exactly MAX_CONNECTING of 20 enqueued dials, then one more per release", async () => {
    const gate = createDialGate();
    const started: number[] = [];
    const tickets = Array.from({ length: 20 }, (_unused, index) =>
      gate.acquire("interactive", () => {
        started.push(index);
      }),
    );

    await flush();
    expect(started).toHaveLength(6);

    tickets[0].release();
    await flush();
    expect(started).toHaveLength(7);
  });

  it("drains interactive fully before background, and lets a late interactive cut ahead of an earlier background", async () => {
    const gate = createDialGate();
    const started: string[] = [];

    // The reserve caps background at MAX_BACKGROUND_CONNECTING (3), so 6
    // background dials alone can no longer fill all six slots the way this
    // case's setup used to. Fill them with 3 interactive + 3 background
    // instead - still enough to show that interactive drains first - and
    // leave the "late interactive cuts ahead of earlier-queued background"
    // half of the claim to the release below.
    Array.from({ length: 3 }, (_unused, index) =>
      gate.acquire("interactive", () => {
        started.push(`interactive-${index}`);
      }),
    );
    const backgroundTickets = Array.from({ length: 3 }, (_unused, index) =>
      gate.acquire("background", () => {
        started.push(`background-${index}`);
      }),
    );
    await flush();
    expect(started).toEqual([
      "interactive-0",
      "interactive-1",
      "interactive-2",
      "background-0",
      "background-1",
      "background-2",
    ]);

    // Three more background dials queue behind the six already connecting...
    gate.acquire("background", () => started.push("background-3"));
    gate.acquire("background", () => started.push("background-4"));
    gate.acquire("background", () => started.push("background-5"));
    // ...then one interactive dial arrives after all of them.
    gate.acquire("interactive", () => started.push("interactive-3"));
    await flush();

    backgroundTickets[0].release();
    await flush();

    expect(started).toEqual([
      "interactive-0",
      "interactive-1",
      "interactive-2",
      "background-0",
      "background-1",
      "background-2",
      "interactive-3",
    ]);
  });

  it("reserves capacity for interactive: at most MAX_BACKGROUND_CONNECTING background dials start before a late interactive one", async () => {
    const gate = createDialGate();
    const started: string[] = [];

    // 6 background dials acquired first...
    Array.from({ length: 6 }, (_unused, index) =>
      gate.acquire("background", () => {
        started.push(`background-${index}`);
      }),
    );
    await flush();

    // ...then 1 interactive acquired after all of them.
    gate.acquire("interactive", () => started.push("interactive-0"));
    await flush();

    // The start ORDER, not just a count, says which dial went first: only 3
    // of the 6 background dials got a slot before the interactive one did -
    // background-3..5 are still queued behind it.
    expect(started).toEqual([
      "background-0",
      "background-1",
      "background-2",
      "interactive-0",
    ]);
  });

  it("stats() reports the reserve split while background is saturated", async () => {
    const gate = createDialGate();

    Array.from({ length: 6 }, () => gate.acquire("background", () => {}));
    await flush();

    expect(gate.stats()).toEqual({
      connecting: 3,
      connectingInteractive: 0,
      connectingBackground: 3,
      queued: 3,
    });
  });

  it("does not cap interactive: six interactive dials with nothing else queued all start", async () => {
    const gate = createDialGate();
    const started: number[] = [];

    Array.from({ length: 6 }, (_unused, index) =>
      gate.acquire("interactive", () => {
        started.push(index);
      }),
    );
    await flush();

    expect(started).toHaveLength(6);
    expect(gate.stats()).toEqual({
      connecting: 6,
      connectingInteractive: 6,
      connectingBackground: 0,
      queued: 0,
    });
  });

  it("is not a latch: releasing one of the 3 background slots re-admits a queued background dial", async () => {
    const gate = createDialGate();
    const started: string[] = [];

    const backgroundTickets = Array.from({ length: 6 }, (_unused, index) =>
      gate.acquire("background", () => {
        started.push(`background-${index}`);
      }),
    );
    await flush();
    expect(started).toHaveLength(3);

    backgroundTickets[0].release();
    await flush();

    expect(started).toHaveLength(4);
    expect(started).toContain("background-3");
    expect(gate.stats().connectingBackground).toBe(3);
  });

  it("makes release() idempotent: a second call frees no extra slot", async () => {
    const gate = createDialGate();
    const started: number[] = [];
    const tickets = Array.from({ length: 8 }, (_unused, index) =>
      gate.acquire("interactive", () => {
        started.push(index);
      }),
    );
    await flush();
    expect(gate.stats().connecting).toBe(6);

    tickets[0].release();
    tickets[0].release();
    await flush();

    // One release frees one slot for one queued entry - not two.
    expect(gate.stats().connecting).toBe(6);
    expect(started).toHaveLength(7);
  });

  it("does nothing when release() is called on an entry that never started", async () => {
    const gate = createDialGate();
    const started: number[] = [];
    const tickets = Array.from({ length: 8 }, (_unused, index) =>
      gate.acquire("interactive", () => {
        started.push(index);
      }),
    );
    await flush();
    // Index 6 and 7 are still queued (only 6 of 8 have started).
    const neverStarted = tickets[7];

    neverStarted.release();
    await flush();

    expect(gate.stats().connecting).toBe(6);
    expect(started).toHaveLength(6);
  });

  it("cancels a queued entry: cancel() returns true and it never starts", async () => {
    const gate = createDialGate();
    const started: number[] = [];
    const tickets = Array.from({ length: 8 }, (_unused, index) =>
      gate.acquire("interactive", () => {
        started.push(index);
      }),
    );
    await flush();
    const queuedTicket = tickets[7];

    expect(queuedTicket.cancel()).toBe(true);

    // Free every other slot so the whole queue would drain if it could.
    tickets.slice(0, 7).forEach((ticket) => ticket.release());
    await flush();

    expect(started).not.toContain(7);
  });

  it("refuses cancel() once an entry has already started", async () => {
    const gate = createDialGate();
    const tickets = Array.from({ length: 6 }, () =>
      gate.acquire("interactive", () => {}),
    );
    await flush();

    expect(tickets[0].cancel()).toBe(false);
  });
});

describe("the WHATWG factories: native construction stays behind the dial gate", () => {
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly url: string;
    readyState: number = FakeWebSocket.CONNECTING;
    binaryType = "blob";
    readonly closeCalls: Array<{ code: number; reason: string }> = [];
    private readonly listeners: Record<
      string,
      Array<(event: unknown) => void>
    > = {
      open: [],
      message: [],
      error: [],
      close: [],
    };

    constructor(url: string) {
      this.url = url;
      constructedSockets.push(this);
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners[type].push(listener);
    }

    send(_data: unknown): void {}

    /**
     * Mirrors the platform: closing a socket - CONNECTING or OPEN - always
     * ends in a `close` event, synchronously for this fake.
     *
     * {@link blackHoleConnectingCloses} suspends the SYNCHRONOUS half for a
     * still-CONNECTING socket, which is the only way to express the host the
     * gate's capacity bug needs: one whose handshake goes unanswered, so the
     * platform accepts `close()` (readyState -> CLOSING) but delivers the
     * `close` event minutes later, if at all. With the synchronous fire left
     * in, the native `close` listener hands the slot back on its own and a
     * capacity assertion passes whether or not `close()` releases anything.
     */
    close(code: number, reason: string): void {
      this.closeCalls.push({ code, reason });
      if (
        blackHoleConnectingCloses &&
        this.readyState === FakeWebSocket.CONNECTING
      ) {
        this.readyState = FakeWebSocket.CLOSING;
        return;
      }
      this.fireClose(code, reason, true);
    }

    fireOpen(): void {
      if (this.readyState !== FakeWebSocket.CONNECTING) return;
      this.readyState = FakeWebSocket.OPEN;
      this.listeners.open.forEach((listener) => listener({}));
    }

    fireError(): void {
      this.listeners.error.forEach((listener) => listener({}));
    }

    fireClose(code: number, reason: string, wasClean: boolean): void {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.listeners.close.forEach((listener) =>
        listener({ code, reason, wasClean }),
      );
    }
  }

  let constructedSockets: FakeWebSocket[] = [];
  /** See {@link FakeWebSocket.close}. Reset to `false` before every case. */
  let blackHoleConnectingCloses = false;

  beforeEach(() => {
    constructedSockets = [];
    blackHoleConnectingCloses = false;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Every case below must leave the shared singleton idle - a slot leaked
    // here starves every other host socket for the life of the process. Both
    // per-priority counts are asserted, not just the total: the reserve is
    // enforced off `connectingBackground`, so a leak there would narrow the
    // background allowance permanently while the total still read clean.
    expect(hostDialGate.stats()).toEqual({
      connecting: 0,
      connectingInteractive: 0,
      connectingBackground: 0,
      queued: 0,
    });
  });

  it("constructs at most MAX_CONNECTING native sockets before the first one opens", async () => {
    const factory = createWhatwgWebSocketFactory();
    const sockets: WebSocketLike[] = Array.from({ length: 20 }, (_unused, i) =>
      factory.create(`wss://host/${i}`, "interactive"),
    );
    await flush();

    expect(constructedSockets).toHaveLength(6);

    constructedSockets[0].fireOpen();
    await flush();
    expect(constructedSockets).toHaveLength(7);

    // Drain everything so the gate is idle for the afterEach assertion. A
    // still-queued entry is dequeued by its own close(); a started one
    // forwards to the native close, which the fake resolves synchronously -
    // either way the cascade empties the queue.
    sockets.forEach((socket) => socket.close(1000, "done"));
    await flush();
  });

  it("never lets the platform see a socket closed before its dial started, and still delivers exactly one onclose", async () => {
    const factory = createWhatwgWebSocketFactory();
    const sockets: WebSocketLike[] = Array.from({ length: 10 }, (_unused, i) =>
      factory.create(`wss://host/${i}`, "interactive"),
    );

    // The first 6 hold the slots; the 10th has not dialed yet. Close it
    // synchronously, before microtasks flush, so it is dequeued rather than
    // torn down mid-handshake.
    const onCloseSpy = vi.fn();
    sockets[9].onclose = onCloseSpy;
    sockets[9].close(1000, "bye");

    await flush();
    expect(constructedSockets).toHaveLength(6);

    // Release the 6 held slots so the still-queued entries (6, 7, 8) get a
    // turn - proving the cap, not just the queue order, governs how many of
    // the surviving 9 ever reach the platform.
    sockets.slice(0, 6).forEach((socket) => socket.close(1000, "done"));
    await flush();

    expect(constructedSockets).toHaveLength(9);
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(onCloseSpy).toHaveBeenCalledWith({
      code: 1000,
      reason: "bye",
      wasClean: true,
    });

    // Drain the rest so the gate ends idle.
    sockets.slice(6, 9).forEach((socket) => socket.close(1000, "done"));
    await flush();
  });

  it.each([
    ["open", (socket: FakeWebSocket) => socket.fireOpen()],
    ["error", (socket: FakeWebSocket) => socket.fireError()],
    ["close", (socket: FakeWebSocket) => socket.fireClose(1006, "lost", false)],
  ] as const)(
    "releases the slot on %s, letting the 7th dial start",
    async (_label, fire) => {
      const factory = createWhatwgWebSocketFactory();
      const sockets: WebSocketLike[] = Array.from({ length: 7 }, (_unused, i) =>
        factory.create(`wss://host/${i}`, "interactive"),
      );
      await flush();
      expect(constructedSockets).toHaveLength(6);

      fire(constructedSockets[0]);
      await flush();
      expect(constructedSockets).toHaveLength(7);

      // Drain everything so the gate ends idle.
      sockets.forEach((socket) => socket.close(1000, "done"));
      await flush();
    },
  );

  it("the stream factory aborts a still-CONNECTING socket on close() and frees its slot without waiting for the platform", async () => {
    // The host that produces this is one that never answers the handshake:
    // `WsStreamClient` gives up at `dialTimeoutMs` and calls
    // `teardownSocket(4000, "dial-timeout")`, then re-dials. The platform is
    // still sitting on the abandoned socket, so nothing releases the gate
    // ticket on its own - which is the whole failure.
    blackHoleConnectingCloses = true;
    const factory = createWhatwgStreamWebSocketFactory();
    const sockets: StreamWebSocketLike[] = Array.from(
      { length: 7 },
      (_unused, i) => factory.create(`wss://host/stream-${i}`, "interactive"),
    );
    await flush();

    // Six hold the gate; the seventh is queued behind them.
    expect(constructedSockets).toHaveLength(6);
    const native = constructedSockets[0];
    expect(native.readyState).toBe(FakeWebSocket.CONNECTING);

    const onOpenSpy = vi.fn();
    sockets[0].onopen = onOpenSpy;
    sockets[0].close(4000, "dial-timeout");

    // Half 1: the socket is CLOSED FOR REAL, not merely forgotten. A fix that
    // released the ticket without closing would satisfy Half 2 alone while
    // leaving a live pending connection against the browser's own ceiling -
    // the gate would then admit a replacement dial on top of it.
    expect(native.closeCalls).toEqual([{ code: 4000, reason: "dial-timeout" }]);

    // Half 2: the slot is back NOW. The platform has delivered no `close`
    // event (that is what `blackHoleConnectingCloses` models), so the native
    // listeners have not run and this can only be `close()`'s own release.
    await flush();
    expect(constructedSockets).toHaveLength(7);

    // A late `open` on the abandoned socket is not announced to the consumer
    // that already gave up on it. The close above left the fake in `CLOSING`,
    // where `fireOpen` is a no-op and the assertion would hold for the wrong
    // reason - so put it back to CONNECTING first and make the platform
    // genuinely complete a handshake it was told to fail. That is the only
    // state this guard exists for, and it has to be staged deliberately.
    native.readyState = FakeWebSocket.CONNECTING;
    native.fireOpen();
    expect(onOpenSpy).not.toHaveBeenCalled();

    // Drain the rest so the gate ends idle for the afterEach assertion.
    blackHoleConnectingCloses = false;
    sockets.slice(1).forEach((socket) => socket.close(1000, "done"));
    await flush();
  });
});
