import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalStreamCallbacks } from "@traycer-clients/shared/host-transport/terminal-stream-client";
import type { TerminalSessionKind } from "@traycer/protocol/host/terminal/unary-schemas";
import {
  createTerminalSessionStore,
  type TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";
import {
  MAX_LINGERING_PLAIN_TERMINALS,
  PLAIN_TERMINAL_RELEASE_LINGER_MS,
  TerminalSessionRegistry,
} from "@/stores/terminals/terminal-session-registry";

function createHandle(kind: TerminalSessionKind): {
  readonly handle: TerminalSessionStoreHandle;
  readonly closeCount: () => number;
  readonly callbacks: () => TerminalStreamCallbacks;
} {
  let closeCount = 0;
  let callbacks: TerminalStreamCallbacks | null = null;
  const handle = createTerminalSessionStore({
    scope: { kind: "epic", epicId: "epic-1" },
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
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lingers a released running plain terminal, then disposes at window expiry", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle);
    registry.release("terminal-1");

    // Still a live registry member for the linger window: the stream stays
    // open and the xterm follower keeps its engine.
    expect(owned.closeCount()).toBe(0);
    expect(registry.get("terminal-1")).toBe(owned.handle);

    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS - 1);
    expect(owned.closeCount()).toBe(0);

    vi.advanceTimersByTime(1);
    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();
  });

  it("reacquiring within the linger window reuses the handle and cancels eviction", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle);
    registry.release("terminal-1");

    const reacquired = registry.acquire("terminal-1", () => {
      throw new Error("must reuse the lingering handle");
    });
    expect(reacquired).toBe(owned.handle);

    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS * 2);
    expect(owned.closeCount()).toBe(0);
    expect(registry.get("terminal-1")).toBe(owned.handle);
  });

  it("disposes a lingering plain terminal immediately when the session exits", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle);
    registry.release("terminal-1");

    owned.callbacks().onExit({
      kind: "exit",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      exitCode: 0,
    });

    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();

    // The cancelled linger timer must not double-dispose or resurrect.
    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(owned.closeCount()).toBe(1);
  });

  it("disposes an exited plain terminal without lingering when its last lease is released", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle);
    // Two leases: the exit eviction only fires on lease-free entries, so the
    // release below is what must observe the exited state.
    registry.acquire("terminal-1", () => {
      throw new Error("must reuse the live handle");
    });
    registry.release("terminal-1");
    owned.callbacks().onExit({
      kind: "exit",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      exitCode: 0,
    });
    registry.release("terminal-1");

    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();
  });

  it("disposes a lost plain terminal on release instead of lingering it", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle);
    owned.callbacks().onConnectionStatus("closed", { kind: "caller" });
    expect(owned.handle.store.getState().status).toBe("lost");
    registry.release("terminal-1");

    // A closed stream never redials, so a lingering lost handle could only be
    // revived as a permanently dead terminal.
    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();
  });

  it("evicts a lingering plain terminal whose stream is lost, so reacquire builds fresh", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle);
    registry.release("terminal-1");
    expect(registry.get("terminal-1")).toBe(owned.handle);

    owned.callbacks().onConnectionStatus("closed", { kind: "caller" });

    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();

    const fresh = createHandle("terminal");
    const reacquired = registry.acquire("terminal-1", () => fresh.handle);
    expect(reacquired).toBe(fresh.handle);
    expect(fresh.closeCount()).toBe(0);
  });

  it("caps the linger pool, evicting the oldest-released plain terminal first", () => {
    const registry = new TerminalSessionRegistry();
    const owned = Array.from(
      { length: MAX_LINGERING_PLAIN_TERMINALS + 1 },
      () => createHandle("terminal"),
    );

    owned.forEach((entry, index) => {
      registry.acquire(`terminal-${index}`, () => entry.handle);
    });
    // All releases happen in the same synchronous batch (same tick), so
    // ordering relies entirely on the monotonic release sequence, not on
    // `Date.now()` ticking between them.
    owned.forEach((_entry, index) => {
      registry.release(`terminal-${index}`);
    });

    expect(owned[0].closeCount()).toBe(1);
    expect(registry.get("terminal-0")).toBeNull();
    owned.slice(1).forEach((entry, index) => {
      expect(entry.closeCount()).toBe(0);
      expect(registry.get(`terminal-${index + 1}`)).toBe(entry.handle);
    });
  });

  it("excludes warm terminal-agents from the linger pool count and candidacy", () => {
    const registry = new TerminalSessionRegistry();
    const agent = createHandle("terminal-agent");
    registry.acquire("agent-1", () => agent.handle);
    registry.release("agent-1");

    const owned = Array.from({ length: MAX_LINGERING_PLAIN_TERMINALS }, () =>
      createHandle("terminal"),
    );
    owned.forEach((entry, index) => {
      registry.acquire(`terminal-${index}`, () => entry.handle);
      registry.release(`terminal-${index}`);
    });

    // The warm agent neither counts toward the cap (all plains retained) nor
    // gets evicted by it.
    expect(agent.closeCount()).toBe(0);
    expect(registry.get("agent-1")).toBe(agent.handle);
    owned.forEach((entry) => {
      expect(entry.closeCount()).toBe(0);
    });
  });

  it("forceRelease during the linger window disposes once and cancels the timer", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle);
    registry.release("terminal-1");
    registry.forceRelease("terminal-1");

    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();

    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(owned.closeCount()).toBe(1);
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
