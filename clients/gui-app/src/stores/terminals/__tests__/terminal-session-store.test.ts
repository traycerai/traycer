import { describe, expect, it, vi } from "vitest";
import type {
  TerminalSubscribeClientFrame,
  TerminalSubscribeServerFrame,
} from "@traycer/protocol/host/terminal/subscribe";
import type { TerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import type { TerminalStreamCallbacks } from "@traycer-clients/shared/host-transport/terminal-stream-client";
import {
  createTerminalSessionStore,
  type TerminalWrite,
} from "@/stores/terminals/terminal-session-store";

type TerminalSnapshotFrame = Extract<
  TerminalSubscribeServerFrame,
  { readonly kind: "snapshot" }
>;
type TerminalDataFrame = Extract<
  TerminalSubscribeServerFrame,
  { readonly kind: "data" }
>;
type TerminalSessionUpdatedFrame = Extract<
  TerminalSubscribeServerFrame,
  { readonly kind: "sessionUpdated" }
>;
type TerminalExitFrame = Extract<
  TerminalSubscribeServerFrame,
  { readonly kind: "exit" }
>;

function terminalInfoWithSize(cols: number, rows: number): TerminalSessionInfo {
  return {
    sessionId: "terminal-1",
    epicId: "epic-1",
    sessionKind: "terminal",
    cwd: "/repo",
    shellCommand: "zsh",
    shellArgs: [],
    cols,
    rows,
    status: "running",
    exitCode: null,
    createdAt: 1,
    title: null,
  };
}

function snapshot(scrollback: string): TerminalSnapshotFrame {
  return snapshotWithSize(scrollback, 80, 24);
}

function snapshotWithSize(
  scrollback: string,
  cols: number,
  rows: number,
): TerminalSnapshotFrame {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    sessionId: "terminal-1",
    session: terminalInfoWithSize(cols, rows),
    scrollback,
  };
}

function data(chunk: string): TerminalDataFrame {
  return {
    kind: "data",
    hasBinaryPayload: false,
    sessionId: "terminal-1",
    chunk,
  };
}

function sessionUpdated(
  activeProcessName: string | null,
): TerminalSessionUpdatedFrame {
  return {
    kind: "sessionUpdated",
    hasBinaryPayload: false,
    sessionId: "terminal-1",
    session: {
      ...terminalInfoWithSize(80, 24),
      activeProcessName,
    },
  };
}

function exit(exitCode: number): TerminalExitFrame {
  return {
    kind: "exit",
    hasBinaryPayload: false,
    sessionId: "terminal-1",
    exitCode,
  };
}

// A snapshot from a host that negotiated ack-credit support. The renderer
// gates sending `ack` frames on having seen this confirmed at least once
// (see `ackCreditSupported` in `terminal-session-store.ts`), so ack-credit
// tests must send one before exercising the accounting.
function snapshotWithAckCredit(scrollback: string): TerminalSnapshotFrame {
  return { ...snapshot(scrollback), ackCreditSupported: true };
}

// `onSnapshot`/`onData` take the content as a second, separate argument (see
// `TerminalStreamCallbacks`'s doc comment) so a `@1.2` binary connection can
// pass a `Uint8Array` instead of reading it off the frame. These test frame
// builders still carry the content inline for readability, so route through
// these to derive the second argument automatically.
function emitSnapshot(
  callbacks: TerminalStreamCallbacks,
  frame: TerminalSnapshotFrame,
): void {
  callbacks.onSnapshot(frame, frame.scrollback);
}

function emitData(
  callbacks: TerminalStreamCallbacks,
  frame: TerminalDataFrame,
): void {
  callbacks.onData(frame, frame.chunk);
}

function createHarness() {
  let callbacks: TerminalStreamCallbacks | null = null;
  const sendAction = vi.fn((_frame: TerminalSubscribeClientFrame) => undefined);
  const close = vi.fn();
  const handle = createTerminalSessionStore({
    scope: { kind: "epic", epicId: "epic-1" },
    sessionId: "terminal-1",
    cols: 80,
    rows: 24,
    reattachMode: "fresh",
    kind: "terminal",
    streamClientFactory: (_sessionId, _cols, _rows, nextCallbacks) => {
      callbacks = nextCallbacks;
      return { sendAction, close };
    },
  });
  return {
    handle,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected stream callbacks");
      return callbacks;
    },
    sendAction,
    close,
  };
}

describe("createTerminalSessionStore", () => {
  it("tags snapshot scrollback (with grid) and live data writes", () => {
    const harness = createHarness();
    const writes: TerminalWrite[] = [];

    harness.handle.store.getState().setWriter((write) => {
      writes.push(write);
    });

    emitSnapshot(harness.callbacks(), snapshot("\x1b[6n"));
    emitData(harness.callbacks(), data("live output"));

    expect(writes).toHaveLength(2);
    expect(writes).toMatchObject([
      { kind: "snapshot", chunk: "\x1b[6n", cols: 80, rows: 24 },
      { kind: "live", chunk: "live output" },
    ]);
    expect(writes.every((write) => typeof write.onAckable === "function")).toBe(
      true,
    );
  });

  it("preserves write order and the snapshot grid while buffering before xterm registers", () => {
    const harness = createHarness();
    const writes: TerminalWrite[] = [];

    emitSnapshot(harness.callbacks(), snapshot("historical output"));
    emitData(harness.callbacks(), data("live output"));
    harness.handle.store.getState().setWriter((write) => {
      writes.push(write);
    });

    expect(writes).toHaveLength(2);
    expect(writes).toMatchObject([
      { kind: "snapshot", chunk: "historical output", cols: 80, rows: 24 },
      { kind: "live", chunk: "live output" },
    ]);
    expect(writes.every((write) => typeof write.onAckable === "function")).toBe(
      true,
    );
  });

  it("adopts exit code and reason from a reattach snapshot of an exited session", () => {
    const harness = createHarness();

    const base = snapshot("");
    emitSnapshot(harness.callbacks(), {
      ...base,
      session: {
        ...base.session,
        status: "exited",
        exitCode: -1,
        exitReason: "reaped",
      },
    });

    expect(harness.handle.store.getState()).toMatchObject({
      status: "exited",
      exitCode: -1,
      exitReason: "reaped",
    });
  });

  it("treats a snapshot missing exitReason (host predating the field) as null", () => {
    const harness = createHarness();

    const base = snapshot("");
    emitSnapshot(harness.callbacks(), {
      ...base,
      session: { ...base.session, status: "exited", exitCode: 1 },
    });

    expect(harness.handle.store.getState()).toMatchObject({
      status: "exited",
      exitCode: 1,
      exitReason: null,
    });
  });

  it("a live exit frame does not clobber a snapshot-set exitReason (snapshot is authoritative)", () => {
    const harness = createHarness();

    // Seed a non-null reason via the authoritative snapshot path first...
    const base = snapshot("");
    emitSnapshot(harness.callbacks(), {
      ...base,
      session: {
        ...base.session,
        status: "exited",
        exitCode: -1,
        exitReason: "reaped",
      },
    });

    // ...then a live exit frame (which carries no reason) must leave it intact.
    const frame: TerminalExitFrame = {
      kind: "exit",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      exitCode: 1,
    };
    harness.callbacks().onExit(frame);

    expect(harness.handle.store.getState()).toMatchObject({
      status: "exited",
      exitCode: 1,
      exitReason: "reaped",
    });
  });

  it("marks the session lost when the stream closes before a snapshot", () => {
    const harness = createHarness();

    expect(harness.handle.store.getState().status).toBe("creating");

    harness.callbacks().onConnectionStatus("closed", null);

    expect(harness.handle.store.getState()).toMatchObject({
      connectionStatus: "closed",
      snapshotLoaded: false,
      status: "lost",
    });
  });

  it("marks the session 'reaped' (definitive) on a TERMINAL_NOT_FOUND fatal, not the recoverable 'lost'", () => {
    const harness = createHarness();
    harness.callbacks().onConnectionStatus("open", null);
    emitSnapshot(harness.callbacks(), snapshot(""));

    harness.callbacks().onConnectionStatus("closed", {
      kind: "fatalError",
      details: {
        code: "TERMINAL_NOT_FOUND",
        reason: "TERMINAL_NOT_FOUND: gone",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    expect(harness.handle.store.getState().status).toBe("reaped");
  });

  it("marks the session the recoverable 'lost' for any other closed reason (plain transport drop)", () => {
    const harness = createHarness();
    harness.callbacks().onConnectionStatus("open", null);
    emitSnapshot(harness.callbacks(), snapshot(""));

    harness.callbacks().onConnectionStatus("closed", { kind: "caller" });

    expect(harness.handle.store.getState().status).toBe("lost");
  });

  it("re-flushes a remembered resize after a reconnect snapshot reports stale dimensions", () => {
    const harness = createHarness();

    harness.callbacks().onConnectionStatus("open", null);
    harness.handle.store.getState().requestResize(105, 91);
    expect(harness.sendAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "resize",
        cols: 105,
        rows: 91,
      }),
    );

    harness.callbacks().onResized({
      kind: "resized",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      cols: 105,
      rows: 91,
    });
    harness.sendAction.mockClear();

    harness.callbacks().onConnectionStatus("reconnecting", null);
    harness.callbacks().onConnectionStatus("open", null);
    expect(harness.sendAction).not.toHaveBeenCalled();

    emitSnapshot(harness.callbacks(), snapshotWithSize("", 80, 24));

    expect(harness.handle.store.getState()).toMatchObject({
      requestedCols: 105,
      requestedRows: 91,
      effectiveCols: 80,
      effectiveRows: 24,
    });
    expect(harness.sendAction).toHaveBeenCalledTimes(1);
    expect(harness.sendAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "resize",
        cols: 105,
        rows: 91,
      }),
    );
  });

  describe("terminal action protocol (T13): replay + honest input-lost", () => {
    it("replays an unacked write verbatim (same clientActionId) after a reconnect", () => {
      const harness = createHarness();
      harness.callbacks().onConnectionStatus("open", null);
      emitSnapshot(harness.callbacks(), snapshot(""));

      const clientActionId = harness.handle.store
        .getState()
        .writeInput("echo hi\r");
      expect(clientActionId).not.toBeNull();
      harness.sendAction.mockClear();

      // Transport blip: the actionAck never arrived before the drop.
      harness.callbacks().onConnectionStatus("reconnecting", null);
      harness.callbacks().onConnectionStatus("open", null);

      expect(harness.sendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "write",
          clientActionId,
          data: "echo hi\r",
        }),
      );
      // Still pending until the host (re-)acks it.
      expect(
        Object.keys(harness.handle.store.getState().pendingActions),
      ).toContain(clientActionId);
    });

    it("does not replay a write once its actionAck has landed", () => {
      const harness = createHarness();
      harness.callbacks().onConnectionStatus("open", null);
      emitSnapshot(harness.callbacks(), snapshot(""));

      const clientActionId = harness.handle.store
        .getState()
        .writeInput("echo hi\r");
      if (clientActionId === null) throw new Error("expected an action id");
      harness.callbacks().onActionAck({
        kind: "actionAck",
        hasBinaryPayload: false,
        sessionId: "terminal-1",
        clientActionId,
        action: "write",
        status: "accepted",
        reason: null,
        code: null,
      });
      harness.sendAction.mockClear();

      harness.callbacks().onConnectionStatus("reconnecting", null);
      harness.callbacks().onConnectionStatus("open", null);

      expect(harness.sendAction).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "write", clientActionId }),
      );
    });

    it("drops a stale pending resize on reconnect instead of replaying it verbatim", () => {
      const harness = createHarness();
      harness.callbacks().onConnectionStatus("open", null);
      emitSnapshot(harness.callbacks(), snapshotWithSize("", 80, 24));

      const resizeId = harness.handle.store.getState().requestResize(120, 40);
      expect(resizeId).not.toBeNull();
      harness.sendAction.mockClear();

      harness.callbacks().onConnectionStatus("reconnecting", null);
      harness.callbacks().onConnectionStatus("open", null);
      // A fresh snapshot reports the still-stale effective size, so
      // `flushRequestedResize` reissues its own fresh resize action.
      emitSnapshot(harness.callbacks(), snapshotWithSize("", 80, 24));

      // The OLD resize id must never be replayed verbatim...
      expect(harness.sendAction).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "resize", clientActionId: resizeId }),
      );
      // ...only a fresh one reflecting the current requested size.
      expect(harness.sendAction).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "resize", cols: 120, rows: 40 }),
      );
      expect(
        Object.keys(harness.handle.store.getState().pendingActions),
      ).not.toContain(resizeId);
    });

    it("surfaces an honest 'input lost' signal when the pending-action ring evicts an unacked write", () => {
      const harness = createHarness();
      harness.callbacks().onConnectionStatus("open", null);
      emitSnapshot(harness.callbacks(), snapshot(""));

      expect(harness.handle.store.getState().lastInputLostAt).toBeNull();

      // Never ack anything - every write stays pending until the ring's
      // MAX_PENDING_ACTIONS (64) cap forces an eviction.
      for (let i = 0; i < 65; i += 1) {
        harness.handle.store.getState().writeInput(`keystroke-${i}`);
      }

      expect(harness.handle.store.getState().lastInputLostAt).not.toBeNull();
      expect(
        Object.keys(harness.handle.store.getState().pendingActions),
      ).toHaveLength(64);
    });
  });

  it("stashes a resize arriving while the session is lost and flushes it after the reconnect snapshot", () => {
    const harness = createHarness();

    harness.callbacks().onConnectionStatus("open", null);
    emitSnapshot(harness.callbacks(), snapshotWithSize("", 80, 24));
    harness.sendAction.mockClear();

    // Stream drops -> "lost". A container resize landing now (pane relayout
    // while disconnected) must be remembered, not dropped: the xterm engine
    // records every report in its own dedupe before the store sees it, so a
    // drop here is never re-offered and the session stays latched at the
    // pre-disconnect grid after the reconnect.
    harness.callbacks().onConnectionStatus("closed", null);
    expect(harness.handle.store.getState().status).toBe("lost");
    const actionId = harness.handle.store.getState().requestResize(132, 40);
    expect(actionId).toBeNull();
    expect(harness.sendAction).not.toHaveBeenCalled();
    expect(harness.handle.store.getState()).toMatchObject({
      requestedCols: 132,
      requestedRows: 40,
    });

    // Reconnect: on "open" the session is still "lost", so nothing flushes
    // yet; the snapshot restores it to running and flushes the stashed size.
    harness.callbacks().onConnectionStatus("open", null);
    expect(harness.sendAction).not.toHaveBeenCalled();
    emitSnapshot(harness.callbacks(), snapshotWithSize("", 80, 24));
    expect(harness.sendAction).toHaveBeenCalledTimes(1);
    expect(harness.sendAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "resize",
        cols: 132,
        rows: 40,
      }),
    );
  });

  it("re-dispatches a repeated resize while the host never adopted it, and dedupes once it did", () => {
    const harness = createHarness();

    harness.callbacks().onConnectionStatus("open", null);
    emitSnapshot(harness.callbacks(), snapshotWithSize("", 80, 24));
    harness.sendAction.mockClear();

    // First report: dispatched, but suppose the frame was lost in flight -
    // the host's grid never becomes 132x40.
    harness.handle.store.getState().requestResize(132, 40);
    expect(harness.sendAction).toHaveBeenCalledTimes(1);

    // The engine's latch self-heal re-reports the SAME size. Deduping on
    // `requested` alone would strand it; it must reach the wire to retry.
    harness.handle.store.getState().requestResize(132, 40);
    expect(harness.sendAction).toHaveBeenCalledTimes(2);

    // Once the host adopts the size (echo), the same request is redundant
    // and dedupes again.
    harness.callbacks().onResized({
      kind: "resized",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      cols: 132,
      rows: 40,
    });
    expect(harness.handle.store.getState().requestResize(132, 40)).toBeNull();
    expect(harness.sendAction).toHaveBeenCalledTimes(2);
  });

  it("stores active process metadata from session updates", () => {
    const harness = createHarness();

    emitSnapshot(harness.callbacks(), snapshot(""));
    harness.callbacks().onSessionUpdated(sessionUpdated("vim"));

    expect(harness.handle.store.getState()).toMatchObject({
      status: "running",
      title: null,
      activeProcessName: "vim",
    });
  });

  it("clears active process metadata when the session exits", () => {
    const harness = createHarness();

    emitSnapshot(harness.callbacks(), snapshot(""));
    harness.callbacks().onSessionUpdated(sessionUpdated("vim"));
    harness.callbacks().onExit(exit(0));

    expect(harness.handle.store.getState()).toMatchObject({
      status: "exited",
      exitCode: 0,
      activeProcessName: null,
    });
  });

  describe("ack-credit (terminal.subscribe@1.1)", () => {
    it("never sends an ack frame until a snapshot confirms ack-credit support", () => {
      const harness = createHarness();
      harness.callbacks().onConnectionStatus("open", null);
      // Old-host-style snapshot: no `ackCreditSupported` field at all, so
      // the renderer must never send an `ack` frame - a `1.0` host's frame
      // schema can't parse "ack" and would just log malformed-frame warnings.
      emitSnapshot(harness.callbacks(), snapshot(""));
      const writes: TerminalWrite[] = [];
      harness.handle.store.getState().setWriter((write) => {
        writes.push(write);
      });

      emitData(harness.callbacks(), data("x".repeat(64 * 1024)));
      writes[0].onAckable();

      expect(harness.sendAction).not.toHaveBeenCalled();
    });

    it("flushes a coalesced ack once accumulated bytes cross the coalesce threshold", () => {
      const harness = createHarness();
      harness.callbacks().onConnectionStatus("open", null);
      emitSnapshot(harness.callbacks(), snapshotWithAckCredit(""));
      const writes: TerminalWrite[] = [];
      harness.handle.store.getState().setWriter((write) => {
        writes.push(write);
      });

      const bigChunk = "x".repeat(64 * 1024);
      emitData(harness.callbacks(), data(bigChunk));
      expect(writes).toHaveLength(1);

      // Simulate xterm's own `write(data, callback)` firing once parsed.
      writes[0].onAckable();

      expect(harness.sendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "ack",
          sessionId: "terminal-1",
          bytes: 64 * 1024,
        }),
      );
    });

    it("coalesces multiple small acks and flushes them together after the debounce window", () => {
      vi.useFakeTimers();
      try {
        const harness = createHarness();
        harness.callbacks().onConnectionStatus("open", null);
        emitSnapshot(harness.callbacks(), snapshotWithAckCredit(""));
        const writes: TerminalWrite[] = [];
        harness.handle.store.getState().setWriter((write) => {
          writes.push(write);
        });

        emitData(harness.callbacks(), data("a".repeat(1000)));
        emitData(harness.callbacks(), data("b".repeat(2000)));
        writes[0].onAckable();
        writes[1].onAckable();

        expect(harness.sendAction).not.toHaveBeenCalled();

        vi.advanceTimersByTime(50);

        expect(harness.sendAction).toHaveBeenCalledTimes(1);
        expect(harness.sendAction).toHaveBeenCalledWith(
          expect.objectContaining({ kind: "ack", bytes: 3000 }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("credits bytes immediately when the pre-writer queue evicts a write, without ever reaching a writer", () => {
      const harness = createHarness();
      harness.callbacks().onConnectionStatus("open", null);
      emitSnapshot(harness.callbacks(), snapshotWithAckCredit(""));
      // No writer registered - both writes land in the pre-writer queue.

      // Exceeds MAX_PENDING_BYTES (1 MiB) on the second push, forcing the
      // queue to evict the first (oldest) write.
      emitData(harness.callbacks(), data("x".repeat(700 * 1024)));
      emitData(harness.callbacks(), data("y".repeat(700 * 1024)));

      // The evicted write's bytes are credited immediately - it will never
      // reach a writer to fire its own `onAckable`.
      expect(harness.sendAction).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "ack", bytes: 700 * 1024 }),
      );
    });

    it("clears pending ack accounting when the connection drops before the coalesce window fires", () => {
      vi.useFakeTimers();
      try {
        const harness = createHarness();
        harness.callbacks().onConnectionStatus("open", null);
        emitSnapshot(harness.callbacks(), snapshotWithAckCredit(""));
        const writes: TerminalWrite[] = [];
        harness.handle.store.getState().setWriter((write) => {
          writes.push(write);
        });

        emitData(harness.callbacks(), data("small chunk"));
        writes[0].onAckable();

        harness.callbacks().onConnectionStatus("reconnecting", null);
        vi.advanceTimersByTime(1000);

        expect(harness.sendAction).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores a stale onAckable callback that fires after a reconnect (late xterm write callback)", () => {
      vi.useFakeTimers();
      try {
        const harness = createHarness();
        harness.callbacks().onConnectionStatus("open", null);
        emitSnapshot(harness.callbacks(), snapshotWithAckCredit(""));
        const writes: TerminalWrite[] = [];
        harness.handle.store.getState().setWriter((write) => {
          writes.push(write);
        });

        // Written before the drop; xterm's own write callback for this
        // chunk hasn't fired yet.
        emitData(harness.callbacks(), data("stale chunk"));
        const staleWrite = writes[0];

        // Reconnect: the host mints a fresh subscriber with unackedBytes
        // reset to 0, and its own snapshot re-confirms ack-credit support -
        // isolating this test to the generation check, not the capability
        // gate, as the reason the stale callback is ignored.
        harness.callbacks().onConnectionStatus("reconnecting", null);
        harness.callbacks().onConnectionStatus("open", null);
        emitSnapshot(harness.callbacks(), snapshotWithAckCredit(""));

        // The stale write's parse-completion callback finally fires late,
        // after the reconnect - it must not start a new coalescing window
        // or ever be acked against the fresh subscriber.
        staleWrite.onAckable();
        vi.advanceTimersByTime(1000);

        expect(harness.sendAction).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("binary framing (terminal.subscribe@1.2)", () => {
    function binarySnapshotFrame(): Extract<
      TerminalSubscribeServerFrame,
      { readonly kind: "binarySnapshot" }
    > {
      return {
        kind: "binarySnapshot",
        hasBinaryPayload: true,
        sessionId: "terminal-1",
        session: terminalInfoWithSize(80, 24),
      };
    }

    function binaryDataFrame(): Extract<
      TerminalSubscribeServerFrame,
      { readonly kind: "binaryData" }
    > {
      return {
        kind: "binaryData",
        hasBinaryPayload: true,
        sessionId: "terminal-1",
      };
    }

    it("passes Uint8Array content straight through to the writer without decoding it", () => {
      const harness = createHarness();
      const writes: TerminalWrite[] = [];
      harness.handle.store.getState().setWriter((write) => {
        writes.push(write);
      });

      const scrollbackBytes = new TextEncoder().encode("hello");
      harness.callbacks().onSnapshot(binarySnapshotFrame(), scrollbackBytes);
      const chunkBytes = new TextEncoder().encode("world");
      harness.callbacks().onData(binaryDataFrame(), chunkBytes);

      expect(writes).toHaveLength(2);
      expect(writes[0]).toMatchObject({
        kind: "snapshot",
        chunk: scrollbackBytes,
      });
      expect(writes[1]).toMatchObject({ kind: "live", chunk: chunkBytes });
    });

    it("treats a binarySnapshot as confirming ack-credit support with no explicit field", () => {
      const harness = createHarness();
      harness.callbacks().onConnectionStatus("open", null);
      harness.callbacks().onSnapshot(binarySnapshotFrame(), new Uint8Array());
      const writes: TerminalWrite[] = [];
      harness.handle.store.getState().setWriter((write) => {
        writes.push(write);
      });

      harness.callbacks().onData(binaryDataFrame(), new Uint8Array(64 * 1024));
      writes[0].onAckable();

      expect(harness.sendAction).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "ack", bytes: 64 * 1024 }),
      );
    });

    it("accounts ack-credit bytes as UTF-8 byte length, not UTF-16 string length", () => {
      vi.useFakeTimers();
      try {
        const harness = createHarness();
        harness.callbacks().onConnectionStatus("open", null);
        harness.callbacks().onSnapshot(binarySnapshotFrame(), new Uint8Array());
        const writes: TerminalWrite[] = [];
        harness.handle.store.getState().setWriter((write) => {
          writes.push(write);
        });

        // "héllo" is 5 UTF-16 code units but 6 UTF-8 bytes (é is 2 bytes) -
        // discriminates byteLength accounting from a leftover .length mistake.
        const chunkBytes = new TextEncoder().encode("héllo");
        expect(chunkBytes.byteLength).toBe(6);
        harness.callbacks().onData(binaryDataFrame(), chunkBytes);
        writes[0].onAckable();
        vi.advanceTimersByTime(50);

        expect(harness.sendAction).toHaveBeenCalledWith(
          expect.objectContaining({ kind: "ack", bytes: 6 }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
