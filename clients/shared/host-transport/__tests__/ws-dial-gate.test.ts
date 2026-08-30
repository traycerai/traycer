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

    const backgroundTickets = Array.from({ length: 6 }, (_unused, index) =>
      gate.acquire("background", () => {
        started.push(`background-${index}`);
      }),
    );
    await flush();
    expect(started).toEqual([
      "background-0",
      "background-1",
      "background-2",
      "background-3",
      "background-4",
      "background-5",
    ]);

    // Three more background dials queue behind the six already connecting...
    gate.acquire("background", () => started.push("background-6"));
    gate.acquire("background", () => started.push("background-7"));
    gate.acquire("background", () => started.push("background-8"));
    // ...then one interactive dial arrives after all of them.
    gate.acquire("interactive", () => started.push("interactive-0"));
    await flush();

    backgroundTickets[0].release();
    await flush();

    expect(started).toEqual([
      "background-0",
      "background-1",
      "background-2",
      "background-3",
      "background-4",
      "background-5",
      "interactive-0",
    ]);
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
     * ends in a `close` event, synchronously for this fake. The stream
     * factory's `pendingClose` deferral relies on this never being called
     * while `readyState` is still `CONNECTING`.
     */
    close(code: number, reason: string): void {
      this.closeCalls.push({ code, reason });
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

  beforeEach(() => {
    constructedSockets = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Every case below must leave the shared singleton idle - a slot leaked
    // here starves every other host socket for the life of the process.
    expect(hostDialGate.stats()).toEqual({ connecting: 0, queued: 0 });
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

  it("the stream factory defers close() on a still-CONNECTING socket, and drops onopen once it does", async () => {
    const factory = createWhatwgStreamWebSocketFactory();
    const socket: StreamWebSocketLike = factory.create(
      "wss://host/stream",
      "interactive",
    );
    await flush();

    const native = constructedSockets[0];
    expect(native.readyState).toBe(FakeWebSocket.CONNECTING);

    const onOpenSpy = vi.fn();
    socket.onopen = onOpenSpy;
    socket.close(4000, "closing-mid-dial");

    // Not honored yet - the handshake has not finished, so the fake's own
    // `close` must not have run.
    expect(native.closeCalls).toHaveLength(0);

    // Firing `open` both releases the slot and, seeing the pending close,
    // issues it - which the fake resolves synchronously, ending the gate
    // idle without any further draining.
    native.fireOpen();

    expect(native.closeCalls).toEqual([
      { code: 4000, reason: "closing-mid-dial" },
    ]);
    expect(onOpenSpy).not.toHaveBeenCalled();

    await flush();
  });
});
