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

function createHarness() {
  let callbacks: TerminalStreamCallbacks | null = null;
  const sendAction = vi.fn((_frame: TerminalSubscribeClientFrame) => undefined);
  const close = vi.fn();
  const handle = createTerminalSessionStore({
    epicId: "epic-1",
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

    harness.callbacks().onSnapshot(snapshot("\x1b[6n"));
    harness.callbacks().onData(data("live output"));

    expect(writes).toEqual([
      { kind: "snapshot", chunk: "\x1b[6n", cols: 80, rows: 24 },
      { kind: "live", chunk: "live output" },
    ]);
  });

  it("preserves write order and the snapshot grid while buffering before xterm registers", () => {
    const harness = createHarness();
    const writes: TerminalWrite[] = [];

    harness.callbacks().onSnapshot(snapshot("historical output"));
    harness.callbacks().onData(data("live output"));
    harness.handle.store.getState().setWriter((write) => {
      writes.push(write);
    });

    expect(writes).toEqual([
      { kind: "snapshot", chunk: "historical output", cols: 80, rows: 24 },
      { kind: "live", chunk: "live output" },
    ]);
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

    harness.callbacks().onSnapshot(snapshotWithSize("", 80, 24));

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
});
