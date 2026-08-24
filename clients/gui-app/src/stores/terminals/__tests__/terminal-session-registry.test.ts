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

const HOST_ID = "host-1";

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

    registry.acquire("terminal-1", () => owned.handle, HOST_ID);
    registry.release("terminal-1", owned.handle);

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

    registry.acquire("terminal-1", () => owned.handle, HOST_ID);
    registry.release("terminal-1", owned.handle);

    const reacquired = registry.acquire(
      "terminal-1",
      () => {
        throw new Error("must reuse the lingering handle");
      },
      HOST_ID,
    );
    expect(reacquired).toBe(owned.handle);

    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS * 2);
    expect(owned.closeCount()).toBe(0);
    expect(registry.get("terminal-1")).toBe(owned.handle);
  });

  it("disposes a lingering plain terminal immediately when the session exits", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID);
    registry.release("terminal-1", owned.handle);

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

    registry.acquire("terminal-1", () => owned.handle, HOST_ID);
    // Two leases: the exit eviction only fires on lease-free entries, so the
    // release below is what must observe the exited state.
    registry.acquire(
      "terminal-1",
      () => {
        throw new Error("must reuse the live handle");
      },
      HOST_ID,
    );
    registry.release("terminal-1", owned.handle);
    owned.callbacks().onExit({
      kind: "exit",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      exitCode: 0,
    });
    registry.release("terminal-1", owned.handle);

    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();
  });

  it("disposes a lost plain terminal on release instead of lingering it", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID);
    owned.callbacks().onConnectionStatus("closed", { kind: "caller" });
    expect(owned.handle.store.getState().status).toBe("lost");
    registry.release("terminal-1", owned.handle);

    // A closed stream never redials, so a lingering lost handle could only be
    // revived as a permanently dead terminal.
    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();
  });

  it("evicts a lingering plain terminal whose stream is lost, so reacquire builds fresh", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID);
    registry.release("terminal-1", owned.handle);
    expect(registry.get("terminal-1")).toBe(owned.handle);

    owned.callbacks().onConnectionStatus("closed", { kind: "caller" });

    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();

    const fresh = createHandle("terminal");
    const reacquired = registry.acquire(
      "terminal-1",
      () => fresh.handle,
      HOST_ID,
    );
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
      registry.acquire(`terminal-${index}`, () => entry.handle, HOST_ID);
    });
    // All releases happen in the same synchronous batch (same tick), so
    // ordering relies entirely on the monotonic release sequence, not on
    // `Date.now()` ticking between them.
    owned.forEach((entry, index) => {
      registry.release(`terminal-${index}`, entry.handle);
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
    registry.acquire("agent-1", () => agent.handle, HOST_ID);
    registry.release("agent-1", agent.handle);

    const owned = Array.from({ length: MAX_LINGERING_PLAIN_TERMINALS }, () =>
      createHandle("terminal"),
    );
    owned.forEach((entry, index) => {
      registry.acquire(`terminal-${index}`, () => entry.handle, HOST_ID);
      registry.release(`terminal-${index}`, entry.handle);
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

    registry.acquire("terminal-1", () => owned.handle, HOST_ID);
    registry.release("terminal-1", owned.handle);
    registry.forceRelease("terminal-1");

    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();

    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(owned.closeCount()).toBe(1);
  });

  it("keeps a lease-free terminal-agent warm until the host session exits", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID);
    registry.release("terminal-1", owned.handle);

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

    registry.acquire("terminal-1", () => owned.handle, HOST_ID);
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
    registry.release("terminal-1", owned.handle);

    expect(owned.handle.store.getState().status).toBe("lost");
    expect(owned.closeCount()).toBe(0);
    expect(registry.get("terminal-1")).toBe(owned.handle);
  });

  it("adopts a closed tab's lease-free warm agent handle under a reopened tab's fresh instance id", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("tab-1", () => owned.handle, HOST_ID);
    // Tab closed: the running agent's handle is kept warm, lease-free.
    registry.release("tab-1", owned.handle);

    // Reopen mints a fresh tab instance id; the warm handle is adoptable.
    expect(
      registry.findAdoptableInstanceId(
        { hostId: HOST_ID, sessionId: "terminal-1" },
        "tab-2",
      ),
    ).toBe("tab-1");
    expect(registry.rekeyLeaseFreeEntry("tab-1", "tab-2")).toBe(true);
    expect(registry.get("tab-1")).toBeNull();
    expect(registry.get("tab-2")).toBe(owned.handle);
    expect(owned.closeCount()).toBe(0);

    // The reopened tile's acquire revives the SAME handle - no new stream.
    const reacquired = registry.acquire(
      "tab-2",
      () => {
        throw new Error("must reuse the adopted handle");
      },
      HOST_ID,
    );
    expect(reacquired).toBe(owned.handle);
  });

  it("does not adopt a session another live tab still holds (split view)", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("tab-1", () => owned.handle, HOST_ID);

    expect(
      registry.findAdoptableInstanceId(
        { hostId: HOST_ID, sessionId: "terminal-1" },
        "tab-2",
      ),
    ).toBeNull();
    expect(registry.rekeyLeaseFreeEntry("tab-1", "tab-2")).toBe(false);
    expect(registry.get("tab-1")).toBe(owned.handle);
  });

  it("evicts an adopted handle under its NEW instance id when the session exits", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("tab-1", () => owned.handle, HOST_ID);
    registry.release("tab-1", owned.handle);
    registry.rekeyLeaseFreeEntry("tab-1", "tab-2");

    // The defunct watcher must target the rekeyed entry: with the old
    // subscription (closure over "tab-1") the exit would evict nothing and
    // the dead handle would stay warm forever.
    owned.callbacks().onExit({
      kind: "exit",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      exitCode: 0,
    });

    expect(owned.closeCount()).toBe(1);
    expect(registry.get("tab-2")).toBeNull();
  });

  it("re-parks a rekeyed lingering plain terminal so it still expires", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("tab-1", () => owned.handle, HOST_ID);
    registry.release("tab-1", owned.handle);
    registry.rekeyLeaseFreeEntry("tab-1", "tab-2");

    // Adoption whose acquire never lands must not leave the plain terminal
    // warm forever - the linger clock re-arms under the new id.
    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(owned.closeCount()).toBe(1);
    expect(registry.get("tab-2")).toBeNull();
  });

  it("does not let host B adopt host A's lease-free same-id terminal", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("inst-a", () => owned.handle, "host-a");
    registry.release("inst-a", owned.handle);

    expect(
      registry.findAdoptableInstanceId(
        { hostId: "host-b", sessionId: "terminal-1" },
        "inst-b",
      ),
    ).toBeNull();
    expect(
      registry.findAdoptableInstanceId(
        { hostId: "host-a", sessionId: "terminal-1" },
        "inst-b",
      ),
    ).toBe("inst-a");
    expect(owned.closeCount()).toBe(0);
    expect(registry.get("inst-a")).toBe(owned.handle);
  });

  it("evicts a lease-free plain terminal that the host confirms is reaped (TERMINAL_NOT_FOUND)", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID);
    registry.release("terminal-1", owned.handle);
    expect(registry.get("terminal-1")).toBe(owned.handle);

    owned.callbacks().onConnectionStatus("closed", {
      kind: "fatalError",
      details: {
        code: "TERMINAL_NOT_FOUND",
        reason: "TERMINAL_NOT_FOUND: gone",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    expect(owned.handle.store.getState().status).toBe("reaped");
    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();

    // Confirmed dead must not resurrect on the linger timer either.
    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(owned.closeCount()).toBe(1);
  });

  it("evicts a lease-free terminal-agent the moment it is confirmed reaped, unlike a merely lost one", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID);
    registry.release("terminal-1", owned.handle);
    expect(registry.get("terminal-1")).toBe(owned.handle);

    owned.callbacks().onConnectionStatus("closed", {
      kind: "fatalError",
      details: {
        code: "TERMINAL_NOT_FOUND",
        reason: "TERMINAL_NOT_FOUND: gone",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    expect(owned.handle.store.getState().status).toBe("reaped");
    // Unlike a merely "lost" terminal-agent (kept warm - see the sibling test
    // above), a confirmed-reaped one is a dead end: keeping it warm would
    // shadow the fresh create-then-acquire bootstrap once the tile revives.
    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();
    // A reopened tab must never adopt the dead entry - there is nothing left
    // to adopt once the confirmed-reaped eviction above has run.
    expect(
      registry.findAdoptableInstanceId(
        { hostId: HOST_ID, sessionId: "terminal-1" },
        "tab-2",
      ),
    ).toBeNull();
  });

  it("ignores a stale release from a replaced consumer A - B's fresh entry is untouched", () => {
    const registry = new TerminalSessionRegistry();
    const ownedA = createHandle("terminal");

    registry.acquire("terminal-1", () => ownedA.handle, HOST_ID);

    // The recovery path (`useTerminalSessionRecovery`'s `doRecover`) replaces
    // A's entry outright via `forceRelease` - consumer A's React effect has
    // not unmounted yet and still holds a reference to `ownedA.handle`. B is
    // the fresh handle the remounted bootstrap subtree acquires under the
    // SAME instance id.
    registry.forceRelease("terminal-1");
    const ownedB = createHandle("terminal");
    registry.acquire("terminal-1", () => ownedB.handle, HOST_ID);
    expect(registry.get("terminal-1")).toBe(ownedB.handle);

    // Consumer A's own effect cleanup finally runs (its key-swapped subtree
    // unmounts) and releases its now-stale handle reference. Before the
    // handle-identity guard this decremented B's lease and could park B's
    // still-actively-held entry on the release-linger clock a release too
    // early.
    registry.release("terminal-1", ownedA.handle);

    // B is still actively leased - its own consumer never released it - so a
    // stale release must not start B's linger clock early.
    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(ownedB.closeCount()).toBe(0);
    expect(registry.get("terminal-1")).toBe(ownedB.handle);

    // B's own, legitimate release still behaves normally afterward - proving
    // its lease count was never touched by A's stale call.
    registry.release("terminal-1", ownedB.handle);
    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(ownedB.closeCount()).toBe(1);
  });

  it("keeps the explicit hostless path from matching a host-owned same-id entry", () => {
    const registry = new TerminalSessionRegistry();
    const hostOwned = createHandle("terminal");
    const hostless = createHandle("terminal-agent");

    registry.acquire("inst-host", () => hostOwned.handle, "host-a");
    registry.release("inst-host", hostOwned.handle);
    registry.acquire("inst-hostless", () => hostless.handle, null);
    registry.release("inst-hostless", hostless.handle);

    expect(
      registry.findAdoptableInstanceId(
        { hostId: null, sessionId: "terminal-1" },
        "inst-new",
      ),
    ).toBe("inst-hostless");
    expect(
      registry.findAdoptableInstanceId(
        { hostId: "host-a", sessionId: "terminal-1" },
        "inst-new",
      ),
    ).toBe("inst-host");
  });
});
