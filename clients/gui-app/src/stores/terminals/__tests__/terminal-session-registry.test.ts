import { describe, expect, it } from "vitest";
import type { TerminalStreamCallbacks } from "@traycer-clients/shared/host-transport/terminal-stream-client";
import type { TerminalSessionKind } from "@traycer/protocol/host/terminal/unary-schemas";
import {
  createTerminalSessionStore,
  type TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";
import { TerminalSessionRegistry } from "@/stores/terminals/terminal-session-registry";

function createHandle(kind: TerminalSessionKind): {
  readonly handle: TerminalSessionStoreHandle;
  readonly closeCount: () => number;
  readonly callbacks: () => TerminalStreamCallbacks;
} {
  let closeCount = 0;
  let callbacks: TerminalStreamCallbacks | null = null;
  const handle = createTerminalSessionStore({
    epicId: "epic-1",
    sessionId: "terminal-1",
    cols: 80,
    rows: 24,
    reattachMode: "fresh",
    kind,
    streamClientFactory: (_sessionId, _cols, _rows, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        close: () => {
          closeCount += 1;
        },
      };
    },
  });
  return {
    handle,
    closeCount: () => closeCount,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

describe("TerminalSessionRegistry", () => {
  it("disposes a plain terminal when its last lease is released", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle);
    registry.release("terminal-1");

    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();
  });

  it("keeps a lease-free terminal-agent warm until the host session exits", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("terminal-1", () => owned.handle);
    registry.release("terminal-1");

    expect(owned.closeCount()).toBe(0);
    expect(registry.get("terminal-1")).toBe(owned.handle);

    owned.callbacks().onExit({
      kind: "exit",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      exitCode: 0,
    });

    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();
  });

  it("keeps a lost lease-free terminal-agent warm because the host PTY may still be running", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("terminal-1", () => owned.handle);
    owned.callbacks().onSnapshot(
      {
        kind: "snapshot",
        hasBinaryPayload: false,
        sessionId: "terminal-1",
        scrollback: "",
        session: {
          sessionId: "terminal-1",
          epicId: "epic-1",
          sessionKind: "terminal-agent",
          cwd: "/repo",
          shellCommand: "zsh",
          shellArgs: [],
          status: "running",
          exitCode: null,
          cols: 80,
          rows: 24,
          createdAt: 1,
          title: null,
        },
      },
      "",
    );
    owned.callbacks().onConnectionStatus("closed", { kind: "caller" });
    registry.release("terminal-1");

    expect(owned.handle.store.getState().status).toBe("lost");
    expect(owned.closeCount()).toBe(0);
    expect(registry.get("terminal-1")).toBe(owned.handle);
  });
});
