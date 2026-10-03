import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalStreamCallbacks } from "@traycer-clients/shared/host-transport/terminal-stream-client";
import type {
  TerminalSubscribeClientFrameV17,
  TerminalSubscribeViewer,
} from "@traycer/protocol/host/terminal/subscribe";
import type { TerminalSessionKind } from "@traycer/protocol/host/terminal/unary-schemas";
import {
  createTerminalSessionStore,
  type TerminalSessionStoreHandle,
  type TerminalWrite,
} from "@/stores/terminals/terminal-session-store";
import {
  MAX_LINGERING_PLAIN_TERMINALS,
  PLAIN_TERMINAL_RELEASE_LINGER_MS,
  TerminalSessionRegistry,
} from "@/stores/terminals/terminal-session-registry";
import {
  DESKTOP_RETENTION_PROFILE,
  MOBILE_RETENTION_PROFILE,
  setRetentionProfile,
} from "@/stores/replica-memory/retention-profile";

const HOST_ID = "host-1";

interface CreatedHandle {
  readonly handle: TerminalSessionStoreHandle;
  readonly closeCount: () => number;
  readonly callbacks: () => TerminalStreamCallbacks;
  readonly viewers: () => readonly TerminalSubscribeViewer[];
  /** Every client frame ever dispatched, across reconnects (a fresh stream
   * client is a new `streamClientFactory` call, but this array is shared). */
  readonly sentFrames: () => readonly TerminalSubscribeClientFrameV17[];
}

function createHandle(kind: TerminalSessionKind): CreatedHandle {
  return createHandleWithViewer(kind, "presentation");
}

/** A store created with the intent its first stream opens with. */
function createHandleWithViewer(
  kind: TerminalSessionKind,
  viewer: TerminalSubscribeViewer,
): CreatedHandle {
  let closeCount = 0;
  let callbacks: TerminalStreamCallbacks | null = null;
  const viewers: TerminalSubscribeViewer[] = [];
  const sentFrames: TerminalSubscribeClientFrameV17[] = [];
  const handle = createTerminalSessionStore({
    scope: { kind: "epic", epicId: "epic-1" },
    sessionId: "terminal-1",
    cols: 80,
    rows: 24,
    reattachMode: "fresh",
    kind,
    viewer,
    streamClientFactory: (streamArgs) => {
      callbacks = streamArgs.callbacks;
      viewers.push(streamArgs.viewer);
      return {
        sendAction: (frame) => {
          sentFrames.push(frame);
        },
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
    viewers: () => viewers,
    sentFrames: () => sentFrames,
  };
}

describe("TerminalSessionRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
  });

  it("lingers a released running plain terminal, then disposes at window expiry", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID, "presentation");
    registry.release("terminal-1", owned.handle, true);

    // Still a live registry member for the linger window: subscribe was
    // reopened as cache (the presentation stream closed) and the xterm
    // follower keeps its engine.
    expect(owned.closeCount()).toBe(1);
    expect(owned.viewers()).toEqual(["presentation", "cache"]);
    expect(registry.get("terminal-1")).toBe(owned.handle);

    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS - 1);
    expect(owned.closeCount()).toBe(1);

    vi.advanceTimersByTime(1);
    expect(owned.closeCount()).toBe(2);
    expect(registry.get("terminal-1")).toBeNull();
  });

  it("reacquiring within the linger window reuses the handle and cancels eviction", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID, "presentation");
    registry.release("terminal-1", owned.handle, true);

    const reacquired = registry.acquire(
      "terminal-1",
      () => {
        throw new Error("must reuse the lingering handle");
      },
      HOST_ID,
      "presentation",
    );
    expect(reacquired).toBe(owned.handle);
    expect(owned.viewers()).toEqual(["presentation", "cache", "presentation"]);

    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS * 2);
    expect(owned.closeCount()).toBe(2);
    expect(registry.get("terminal-1")).toBe(owned.handle);
  });

  it("disposes a lingering plain terminal immediately when the session exits", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID, "presentation");
    registry.release("terminal-1", owned.handle, true);

    owned.callbacks().onExit({
      kind: "exit",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      exitCode: 0,
    });

    expect(owned.closeCount()).toBe(2);
    expect(registry.get("terminal-1")).toBeNull();

    // The cancelled linger timer must not double-dispose or resurrect.
    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(owned.closeCount()).toBe(2);
  });

  it("disposes an exited plain terminal without lingering when its last lease is released", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID, "presentation");
    // Two leases: the exit eviction only fires on lease-free entries, so the
    // release below is what must observe the exited state.
    registry.acquire(
      "terminal-1",
      () => {
        throw new Error("must reuse the live handle");
      },
      HOST_ID,
      "presentation",
    );
    registry.release("terminal-1", owned.handle, true);
    owned.callbacks().onExit({
      kind: "exit",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      exitCode: 0,
    });
    registry.release("terminal-1", owned.handle, true);

    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();
  });

  it("disposes a lost plain terminal on release instead of lingering it", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID, "presentation");
    owned.callbacks().onConnectionStatus("closed", { kind: "caller" });
    expect(owned.handle.store.getState().status).toBe("lost");
    registry.release("terminal-1", owned.handle, true);

    // A closed stream never redials, so a lingering lost handle could only be
    // revived as a permanently dead terminal.
    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();
  });

  it("evicts a lingering plain terminal whose stream is lost, so reacquire builds fresh", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID, "presentation");
    registry.release("terminal-1", owned.handle, true);
    expect(registry.get("terminal-1")).toBe(owned.handle);

    owned.callbacks().onConnectionStatus("closed", { kind: "caller" });

    expect(owned.closeCount()).toBe(2);
    expect(registry.get("terminal-1")).toBeNull();

    const fresh = createHandle("terminal");
    const reacquired = registry.acquire(
      "terminal-1",
      () => fresh.handle,
      HOST_ID,
      "presentation",
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
      registry.acquire(
        `terminal-${index}`,
        () => entry.handle,
        HOST_ID,
        "presentation",
      );
    });
    // All releases happen in the same synchronous batch (same tick), so
    // ordering relies entirely on the monotonic release sequence, not on
    // `Date.now()` ticking between them.
    owned.forEach((entry, index) => {
      registry.release(`terminal-${index}`, entry.handle, true);
    });

    expect(owned[0].closeCount()).toBe(2);
    expect(registry.get("terminal-0")).toBeNull();
    owned.slice(1).forEach((entry, index) => {
      expect(entry.closeCount()).toBe(1);
      expect(registry.get(`terminal-${index + 1}`)).toBe(entry.handle);
    });
  });

  it("folds a released terminal-agent into the shared linger pool - same cap and release order as shells", () => {
    const registry = new TerminalSessionRegistry();
    const agent = createHandle("terminal-agent");
    registry.acquire("agent-1", () => agent.handle, HOST_ID, "presentation");
    registry.release("agent-1", agent.handle, true);

    // The agent released first, so it is the oldest entry in the shared pool.
    // Filling the rest of the cap with plains must evict the agent, not spare
    // it - agents no longer have their own uncapped class.
    const owned = Array.from({ length: MAX_LINGERING_PLAIN_TERMINALS }, () =>
      createHandle("terminal"),
    );
    owned.forEach((entry, index) => {
      registry.acquire(
        `terminal-${index}`,
        () => entry.handle,
        HOST_ID,
        "presentation",
      );
      registry.release(`terminal-${index}`, entry.handle, true);
    });

    expect(agent.closeCount()).toBe(2);
    expect(registry.get("agent-1")).toBeNull();
    owned.forEach((entry, index) => {
      expect(entry.closeCount()).toBe(1);
      expect(registry.get(`terminal-${index}`)).toBe(entry.handle);
    });
  });

  it("shares the release-linger TTL with plain terminals for a released running agent", () => {
    const registry = new TerminalSessionRegistry();
    const agent = createHandle("terminal-agent");

    registry.acquire("agent-ttl", () => agent.handle, HOST_ID, "presentation");
    registry.release("agent-ttl", agent.handle, true);

    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS - 1);
    expect(agent.closeCount()).toBe(1);
    expect(registry.get("agent-ttl")).toBe(agent.handle);

    vi.advanceTimersByTime(1);
    expect(agent.closeCount()).toBe(2);
    expect(registry.get("agent-ttl")).toBeNull();
  });

  it("never evicts a leased (presented) terminal-agent through the shared cap, however many lease-free entries cycle through", () => {
    const registry = new TerminalSessionRegistry();
    const agent = createHandle("terminal-agent");
    // Leased for the whole test - never released, so it carries demand and is
    // outside the demand-free cap walk regardless of pool pressure.
    registry.acquire(
      "agent-leased",
      () => agent.handle,
      HOST_ID,
      "presentation",
    );

    const owned = Array.from(
      { length: MAX_LINGERING_PLAIN_TERMINALS + 5 },
      () => createHandle("terminal"),
    );
    owned.forEach((entry, index) => {
      registry.acquire(
        `terminal-${index}`,
        () => entry.handle,
        HOST_ID,
        "presentation",
      );
      registry.release(`terminal-${index}`, entry.handle, true);
    });

    expect(agent.closeCount()).toBe(0);
    expect(registry.get("agent-leased")).toBe(agent.handle);
  });

  it("forceRelease during the linger window disposes once and cancels the timer", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID, "presentation");
    registry.release("terminal-1", owned.handle, true);
    registry.forceRelease("terminal-1");

    expect(owned.closeCount()).toBe(2);
    expect(registry.get("terminal-1")).toBeNull();

    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(owned.closeCount()).toBe(2);
  });

  it("keeps a lease-free terminal-agent warm until the host session exits", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID, "presentation");
    registry.release("terminal-1", owned.handle, true);

    expect(owned.closeCount()).toBe(1);
    expect(owned.viewers()).toEqual(["presentation", "cache"]);
    expect(registry.get("terminal-1")).toBe(owned.handle);

    owned.callbacks().onExit({
      kind: "exit",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      exitCode: 0,
    });

    expect(owned.closeCount()).toBe(2);
    expect(registry.get("terminal-1")).toBeNull();
  });

  it("evicts a lease-free terminal-agent immediately once its stream is lost, sharing the plain-terminal defunct predicate", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID, "presentation");
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
    registry.release("terminal-1", owned.handle, true);

    // A closed stream never redials for either kind now, so a lease-free
    // "lost" agent is disposed on release instead of lingering - the same
    // predicate a lost plain terminal already gets, not the previous
    // agent-only exemption.
    expect(owned.handle.store.getState().status).toBe("lost");
    expect(owned.closeCount()).toBe(1);
    expect(registry.get("terminal-1")).toBeNull();

    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(owned.closeCount()).toBe(1);
  });

  it("evicts a lingering terminal-agent the instant its stream is lost, so reacquire builds fresh", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID, "presentation");
    registry.release("terminal-1", owned.handle, true);
    expect(registry.get("terminal-1")).toBe(owned.handle);

    owned.callbacks().onConnectionStatus("closed", { kind: "caller" });

    expect(owned.closeCount()).toBe(2);
    expect(registry.get("terminal-1")).toBeNull();

    const fresh = createHandle("terminal-agent");
    const reacquired = registry.acquire(
      "terminal-1",
      () => fresh.handle,
      HOST_ID,
      "presentation",
    );
    expect(reacquired).toBe(fresh.handle);
    expect(fresh.closeCount()).toBe(0);
  });

  it("adopts a closed tab's lease-free warm agent handle under a reopened tab's fresh instance id", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("tab-1", () => owned.handle, HOST_ID, "presentation");
    // Tab closed: the running agent's handle is kept warm, lease-free.
    registry.release("tab-1", owned.handle, true);

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
    expect(owned.closeCount()).toBe(1);
    expect(owned.viewers()).toEqual(["presentation", "cache"]);

    // The reopened tile's acquire revives the SAME handle; subscribe
    // reopens as presentation (open-frame-only viewer intent).
    const reacquired = registry.acquire(
      "tab-2",
      () => {
        throw new Error("must reuse the adopted handle");
      },
      HOST_ID,
      "presentation",
    );
    expect(reacquired).toBe(owned.handle);
    expect(owned.viewers()).toEqual(["presentation", "cache", "presentation"]);
  });

  it("does not adopt a session another live tab still holds (split view)", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("tab-1", () => owned.handle, HOST_ID, "presentation");

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

    registry.acquire("tab-1", () => owned.handle, HOST_ID, "presentation");
    registry.release("tab-1", owned.handle, true);
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

    expect(owned.closeCount()).toBe(2);
    expect(registry.get("tab-2")).toBeNull();
  });

  it("re-parks a rekeyed lingering plain terminal so it still expires", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("tab-1", () => owned.handle, HOST_ID, "presentation");
    registry.release("tab-1", owned.handle, true);
    registry.rekeyLeaseFreeEntry("tab-1", "tab-2");

    // Adoption whose acquire never lands must not leave the plain terminal
    // warm forever - the linger clock re-arms under the new id.
    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(owned.closeCount()).toBe(2);
    expect(registry.get("tab-2")).toBeNull();
  });

  it("does not let host B adopt host A's lease-free same-id terminal", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("inst-a", () => owned.handle, "host-a", "presentation");
    registry.release("inst-a", owned.handle, true);

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
    expect(owned.closeCount()).toBe(1);
    expect(registry.get("inst-a")).toBe(owned.handle);
  });

  it("evicts a lease-free plain terminal that the host confirms is reaped (TERMINAL_NOT_FOUND)", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID, "presentation");
    registry.release("terminal-1", owned.handle, true);
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
    expect(owned.closeCount()).toBe(2);
    expect(registry.get("terminal-1")).toBeNull();

    // Confirmed dead must not resurrect on the linger timer either.
    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(owned.closeCount()).toBe(2);
  });

  it("evicts a lease-free terminal-agent the moment it is confirmed reaped", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("terminal-1", () => owned.handle, HOST_ID, "presentation");
    registry.release("terminal-1", owned.handle, true);
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
    // A confirmed-reaped agent is a dead end just like a lost one: keeping it
    // warm would shadow the fresh create-then-acquire bootstrap once the tile
    // revives.
    expect(owned.closeCount()).toBe(2);
    expect(registry.get("terminal-1")).toBeNull();
    // A reopened tab must never adopt the dead entry - there is nothing left
    // to adopt once the confirmed-reaped eviction above has run.
    expect(
      registry.findAdoptableInstanceId(
        { hostId: HOST_ID, sessionId: "terminal-1" },
        "tab-2",
      ),
    ).toBeNull();

    const fresh = createHandle("terminal-agent");
    const reacquired = registry.acquire(
      "tab-2",
      () => fresh.handle,
      HOST_ID,
      "presentation",
    );
    expect(reacquired).toBe(fresh.handle);
    expect(fresh.viewers()).toEqual(["presentation"]);
    expect(fresh.handle.store.getState().status).toBe("creating");
  });

  it("ignores a stale release from a replaced consumer A - B's fresh entry is untouched", () => {
    const registry = new TerminalSessionRegistry();
    const ownedA = createHandle("terminal");

    registry.acquire(
      "terminal-1",
      () => ownedA.handle,
      HOST_ID,
      "presentation",
    );

    // The recovery path (`useTerminalSessionRecovery`'s `doRecover`) replaces
    // A's entry outright via `forceRelease` - consumer A's React effect has
    // not unmounted yet and still holds a reference to `ownedA.handle`. B is
    // the fresh handle the remounted bootstrap subtree acquires under the
    // SAME instance id.
    registry.forceRelease("terminal-1");
    const ownedB = createHandle("terminal");
    registry.acquire(
      "terminal-1",
      () => ownedB.handle,
      HOST_ID,
      "presentation",
    );
    expect(registry.get("terminal-1")).toBe(ownedB.handle);

    // Consumer A's own effect cleanup finally runs (its key-swapped subtree
    // unmounts) and releases its now-stale handle reference. Before the
    // handle-identity guard this decremented B's lease and could park B's
    // still-actively-held entry on the release-linger clock a release too
    // early.
    registry.release("terminal-1", ownedA.handle, true);

    // B is still actively leased - its own consumer never released it - so a
    // stale release must not start B's linger clock early.
    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(ownedB.closeCount()).toBe(0);
    expect(registry.get("terminal-1")).toBe(ownedB.handle);

    // B's own, legitimate release still behaves normally afterward - proving
    // its lease count was never touched by A's stale call.
    registry.release("terminal-1", ownedB.handle, true);
    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS);
    expect(ownedB.closeCount()).toBe(2);
  });

  it("keeps the explicit hostless path from matching a host-owned same-id entry", () => {
    const registry = new TerminalSessionRegistry();
    const hostOwned = createHandle("terminal");
    const hostless = createHandle("terminal-agent");

    registry.acquire(
      "inst-host",
      () => hostOwned.handle,
      "host-a",
      "presentation",
    );
    registry.release("inst-host", hostOwned.handle, true);
    registry.acquire(
      "inst-hostless",
      () => hostless.handle,
      null,
      "presentation",
    );
    registry.release("inst-hostless", hostless.handle, true);

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

  it("tags subscribe viewer from lease state: presentation while leased, cache when keep-warm, presentation on reacquire", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("tab-1", () => owned.handle, HOST_ID, "presentation");
    expect(owned.viewers()).toEqual(["presentation"]);
    expect(owned.handle.store.getState().viewer).toBe("presentation");

    // StrictMode / split: a second lease on the same instance must not
    // reopen. Intent stays presentation for as long as anyone is looking.
    registry.acquire(
      "tab-1",
      () => {
        throw new Error("must reuse the live handle");
      },
      HOST_ID,
      "presentation",
    );
    expect(owned.viewers()).toEqual(["presentation"]);
    registry.release("tab-1", owned.handle, true);
    expect(owned.viewers()).toEqual(["presentation"]);
    expect(owned.handle.store.getState().viewer).toBe("presentation");

    registry.release("tab-1", owned.handle, true);
    expect(owned.viewers()).toEqual(["presentation", "cache"]);
    expect(owned.handle.store.getState().viewer).toBe("cache");
    expect(registry.get("tab-1")).toBe(owned.handle);

    const reacquired = registry.acquire(
      "tab-1",
      () => {
        throw new Error("must reuse the keep-warm handle");
      },
      HOST_ID,
      "presentation",
    );
    expect(reacquired).toBe(owned.handle);
    expect(owned.viewers()).toEqual(["presentation", "cache", "presentation"]);
    expect(owned.handle.store.getState().viewer).toBe("presentation");
  });

  it("tags a lingering plain terminal cache on release and presentation on reacquire", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("tab-1", () => owned.handle, HOST_ID, "presentation");
    expect(owned.viewers()).toEqual(["presentation"]);
    registry.release("tab-1", owned.handle, true);
    expect(owned.viewers()).toEqual(["presentation", "cache"]);
    expect(owned.handle.store.getState().viewer).toBe("cache");

    registry.acquire(
      "tab-1",
      () => {
        throw new Error("must reuse the lingering handle");
      },
      HOST_ID,
      "presentation",
    );
    expect(owned.viewers()).toEqual(["presentation", "cache", "presentation"]);
    expect(owned.handle.store.getState().viewer).toBe("presentation");
  });

  it("disposes a last-lease keep-warm terminal when transport is gone instead of retagging cache", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("tab-1", () => owned.handle, HOST_ID, "presentation");
    expect(() => {
      registry.release("tab-1", owned.handle, false);
    }).not.toThrow();

    expect(owned.viewers()).toEqual(["presentation"]);
    expect(registry.get("tab-1")).toBeNull();
    expect(owned.closeCount()).toBe(1);
  });

  it("disposes instead of wedging when cache retag throws", () => {
    const registry = new TerminalSessionRegistry();
    const viewers: TerminalSubscribeViewer[] = [];
    const handle = createTerminalSessionStore({
      scope: { kind: "epic", epicId: "epic-1" },
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      reattachMode: "fresh",
      kind: "terminal-agent",
      viewer: "presentation",
      streamClientFactory: (streamArgs) => {
        if (streamArgs.viewer === "cache") {
          throw new Error("No directory entry for host host-1");
        }
        viewers.push(streamArgs.viewer);
        return { sendAction: () => undefined, close: () => undefined };
      },
    });

    registry.acquire("tab-1", () => handle, HOST_ID, "presentation");
    expect(() => {
      registry.release("tab-1", handle, true);
    }).not.toThrow();

    expect(viewers).toEqual(["presentation"]);
    expect(registry.get("tab-1")).toBeNull();
  });

  it("revives a parked entry for an off-screen tile without reopening its stream", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("tab-1", () => owned.handle, HOST_ID, "presentation");
    registry.release("tab-1", owned.handle, true);
    // Parking reopened the stream as cache and nothing else.
    expect(owned.viewers()).toEqual(["presentation", "cache"]);
    expect(owned.closeCount()).toBe(1);

    const reacquired = registry.acquire(
      "tab-1",
      () => {
        throw new Error("must reuse the keep-warm handle");
      },
      HOST_ID,
      "cache",
    );

    expect(reacquired).toBe(owned.handle);
    // Same stream: no new subscribe, no close, still a cache attachment.
    expect(owned.viewers()).toEqual(["presentation", "cache"]);
    expect(owned.closeCount()).toBe(1);
    expect(owned.handle.store.getState().viewer).toBe("cache");
  });

  it("revives a parked entry for an on-screen tile by reopening it as presentation", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal-agent");

    registry.acquire("tab-1", () => owned.handle, HOST_ID, "presentation");
    registry.release("tab-1", owned.handle, true);
    expect(owned.viewers()).toEqual(["presentation", "cache"]);

    registry.acquire(
      "tab-1",
      () => {
        throw new Error("must reuse the keep-warm handle");
      },
      HOST_ID,
      "presentation",
    );

    expect(owned.viewers()).toEqual(["presentation", "cache", "presentation"]);
    expect(owned.closeCount()).toBe(2);
    expect(owned.handle.store.getState().viewer).toBe("presentation");
  });

  it("revives a lingering plain terminal for an off-screen tile without reopening it, and cancels the linger", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandle("terminal");

    registry.acquire("tab-1", () => owned.handle, HOST_ID, "presentation");
    registry.release("tab-1", owned.handle, true);
    expect(owned.viewers()).toEqual(["presentation", "cache"]);

    registry.acquire(
      "tab-1",
      () => {
        throw new Error("must reuse the lingering handle");
      },
      HOST_ID,
      "cache",
    );

    expect(owned.viewers()).toEqual(["presentation", "cache"]);
    expect(owned.handle.store.getState().viewer).toBe("cache");
    // The lease is back, so the linger clock no longer evicts it.
    vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS * 2);
    expect(registry.get("tab-1")).toBe(owned.handle);
    expect(owned.closeCount()).toBe(1);
  });

  it("keeps an off-screen tile's fresh entry a cache attachment through its whole lease, opening one stream", () => {
    const registry = new TerminalSessionRegistry();
    const owned = createHandleWithViewer("terminal-agent", "cache");

    registry.acquire("tab-1", () => owned.handle, HOST_ID, "cache");
    expect(owned.viewers()).toEqual(["cache"]);
    expect(owned.handle.store.getState().viewer).toBe("cache");

    // Releasing parks it as cache, which it already is: no reopen.
    registry.release("tab-1", owned.handle, true);
    expect(owned.viewers()).toEqual(["cache"]);
    expect(owned.closeCount()).toBe(0);
    expect(registry.get("tab-1")).toBe(owned.handle);
  });

  it("membershipIdsForHost lists instance ids of that host only", () => {
    const registry = new TerminalSessionRegistry();
    const hostA = createHandle("terminal");
    const hostB = createHandle("terminal");
    const hostless = createHandle("terminal-agent");

    registry.acquire("inst-a", () => hostA.handle, "host-a", "presentation");
    registry.acquire("inst-b", () => hostB.handle, "host-b", "presentation");
    registry.acquire(
      "inst-hostless",
      () => hostless.handle,
      null,
      "presentation",
    );

    expect(registry.membershipIdsForHost("host-a")).toEqual(["inst-a"]);
    expect(registry.membershipIdsForHost("host-b")).toEqual(["inst-b"]);
    expect(registry.membershipIdsForHost("host-none")).toEqual([]);
  });

  it("follows the active retention profile's linger cap, not the desktop constant", () => {
    // `TerminalSessionRegistry` has no constructor option for this cap - it
    // reads `getRetentionProfile().maxLingeringPlainTerminals` fresh on every
    // warm-pool walk (see `terminal-session-registry.ts`'s `maxWarm` getter).
    // Mirrors the desktop-cap fixture above ("caps the linger pool..."), but
    // proves the SMALLER mobile number is what actually governs once that
    // profile is active, not `MAX_LINGERING_PLAIN_TERMINALS`.
    setRetentionProfile(MOBILE_RETENTION_PROFILE);
    const registry = new TerminalSessionRegistry();
    const owned = Array.from(
      { length: MOBILE_RETENTION_PROFILE.maxLingeringPlainTerminals + 1 },
      () => createHandle("terminal"),
    );

    owned.forEach((entry, index) => {
      registry.acquire(
        `terminal-${index}`,
        () => entry.handle,
        HOST_ID,
        "presentation",
      );
    });
    owned.forEach((entry, index) => {
      registry.release(`terminal-${index}`, entry.handle, true);
    });

    expect(owned[0].closeCount()).toBe(2);
    expect(registry.get("terminal-0")).toBeNull();
    owned.slice(1).forEach((entry, index) => {
      expect(entry.closeCount()).toBe(1);
      expect(registry.get(`terminal-${index + 1}`)).toBe(entry.handle);
    });
  });

  it("replays the host snapshot into a fresh handle once the shared cap evicts the prior one", () => {
    const registry = new TerminalSessionRegistry();
    const evicted = createHandle("terminal-agent");

    registry.acquire(
      "terminal-1",
      () => evicted.handle,
      HOST_ID,
      "presentation",
    );
    registry.release("terminal-1", evicted.handle, true);

    // Push the evicted agent out through the shared cap - the same eviction
    // path a shell now takes, since agents no longer have an uncapped class.
    const fillers = Array.from({ length: MAX_LINGERING_PLAIN_TERMINALS }, () =>
      createHandle("terminal"),
    );
    fillers.forEach((filler, index) => {
      registry.acquire(
        `filler-${index}`,
        () => filler.handle,
        HOST_ID,
        "presentation",
      );
      registry.release(`filler-${index}`, filler.handle, true);
    });
    expect(registry.get("terminal-1")).toBeNull();
    expect(evicted.closeCount()).toBe(2);

    // Reopening the tab mints a fresh handle - the evicted one is gone for
    // good; the host-side PTY is untouched and replays its snapshot (the
    // host's own scrollback, which can truncate at 2MiB - not a promise of
    // full history).
    const reopened = createHandle("terminal-agent");
    const writes: TerminalWrite[] = [];
    reopened.handle.store.getState().setWriter((write) => writes.push(write));
    const reacquired = registry.acquire(
      "terminal-1",
      () => reopened.handle,
      HOST_ID,
      "presentation",
    );
    expect(reacquired).toBe(reopened.handle);

    const hostSnapshot = "line\n".repeat(5_000) + "final-line";
    reopened.callbacks().onSnapshot(
      {
        kind: "snapshot",
        hasBinaryPayload: false,
        sessionId: "terminal-1",
        scrollback: hostSnapshot,
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
      hostSnapshot,
    );

    // The host snapshot lands as one write - not a partial or merged
    // continuation of the evicted engine's stale content.
    expect(writes).toEqual([
      expect.objectContaining({ kind: "snapshot", chunk: hostSnapshot }),
    ]);
    expect(reopened.handle.store.getState().snapshotLoaded).toBe(true);
  });

  describe("pending-write protection (W3-L)", () => {
    it.each([
      {
        label: "before release (the retainWhenIdle gate at park time)",
        dropBeforeRelease: true,
        expectedCloseCountAfterRelease: 0,
      },
      {
        label:
          "after release (the watchDefunct subscriber on an already-warm entry)",
        dropBeforeRelease: false,
        expectedCloseCountAfterRelease: 1,
      },
    ])(
      "protects a lease-free entry with an unacked write through loss $label, then through the cap walk and TTL expiry",
      ({ dropBeforeRelease, expectedCloseCountAfterRelease }) => {
        const registry = new TerminalSessionRegistry();
        const owned = createHandle("terminal");

        registry.acquire(
          "terminal-1",
          () => owned.handle,
          HOST_ID,
          "presentation",
        );
        owned.callbacks().onConnectionStatus("open", null);
        const clientActionId = owned.handle.store
          .getState()
          .writeInput("echo hi\r");
        expect(clientActionId).not.toBeNull();

        if (dropBeforeRelease) {
          // The transport drops before the host ever acks the write, and
          // before the last lease releases - `retainWhenIdle` is the gate
          // that has to notice the pending write at park time.
          owned.callbacks().onConnectionStatus("closed", { kind: "caller" });
          expect(owned.handle.store.getState().status).toBe("lost");
        }

        registry.release("terminal-1", owned.handle, true);
        // Before: the plain "lost" predicate would have disposed this
        // immediately (see "disposes a lost plain terminal on release
        // instead of lingering it" above) - the unacked write is what keeps
        // it parked instead. After: parking while still healthy reopens the
        // stream as "cache" (one close of the pre-park client), and the
        // transport has not dropped yet.
        expect(owned.closeCount()).toBe(expectedCloseCountAfterRelease);
        expect(registry.get("terminal-1")).toBe(owned.handle);

        if (!dropBeforeRelease) {
          // The transport drops NOW, on the already-warm "cache" entry.
          // `retainWhenIdle` already ran once at park time and will not run
          // again - only the live `watchDefunct` subscriber sees this
          // transition, and it has to respect the pending write on its own.
          owned.callbacks().onConnectionStatus("closed", { kind: "caller" });
          expect(owned.handle.store.getState().status).toBe("lost");
          expect(registry.get("terminal-1")).toBe(owned.handle);
          expect(owned.closeCount()).toBe(expectedCloseCountAfterRelease);
        }

        // Pool pressure: fill the linger cap past its limit with ordinary
        // released terminals that carry no pending work.
        const fillers = Array.from(
          { length: MAX_LINGERING_PLAIN_TERMINALS + 5 },
          () => createHandle("terminal"),
        );
        fillers.forEach((filler, index) => {
          registry.acquire(
            `filler-${index}`,
            () => filler.handle,
            HOST_ID,
            "presentation",
          );
          registry.release(`filler-${index}`, filler.handle, true);
        });
        expect(registry.get("terminal-1")).toBe(owned.handle);

        // TTL pressure: the window elapses too - no expiry timer was ever
        // armed for it while the write was outstanding.
        vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS * 3);
        expect(registry.get("terminal-1")).toBe(owned.handle);
        expect(owned.closeCount()).toBe(expectedCloseCountAfterRelease);
      },
    );

    it("replays an unacked terminal-agent write with the SAME clientActionId exactly once on reconnect, under real pool+TTL pressure, then evicts on ack because the original TTL had already elapsed", () => {
      const registry = new TerminalSessionRegistry();
      const owned = createHandle("terminal-agent");

      registry.acquire("agent-1", () => owned.handle, HOST_ID, "presentation");
      owned.callbacks().onConnectionStatus("open", null);
      const clientActionId = owned.handle.store
        .getState()
        .writeInput("echo hi\r");
      if (clientActionId === null) throw new Error("expected an action id");

      // A transient blip while still leased - harmless, demand is still
      // held. Isolates the fix from the "lost" retention branch entirely:
      // the session never goes lost or exited here, so any protection below
      // can only come from `hasActiveWork` reading the pending write.
      owned.callbacks().onConnectionStatus("reconnecting", null);

      registry.release("agent-1", owned.handle, true);
      // Released while merely reconnecting (not dead): `onParked`'s cache
      // retag reopens the stream, closing the pre-park client once.
      expect(owned.closeCount()).toBe(1);
      expect(registry.get("agent-1")).toBe(owned.handle);

      // Pool pressure: fill the linger cap past its limit with ordinary
      // released terminals sharing the same cap.
      const fillers = Array.from(
        { length: MAX_LINGERING_PLAIN_TERMINALS + 5 },
        () => createHandle("terminal"),
      );
      fillers.forEach((filler, index) => {
        registry.acquire(
          `filler-${index}`,
          () => filler.handle,
          HOST_ID,
          "presentation",
        );
        registry.release(`filler-${index}`, filler.handle, true);
      });
      expect(registry.get("agent-1")).toBe(owned.handle);

      // TTL pressure: the window elapses while still merely "reconnecting"
      // (never lost/exited) - protection holds with no timer ever armed,
      // proving `hasActiveWork` alone (not the lost-handle branch) is what
      // guards the cap and TTL here.
      vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS * 3);
      expect(registry.get("agent-1")).toBe(owned.handle);

      // The real reconnect: a natural reconnecting -> open cycle on the
      // CURRENT (already-reopened "cache") stream replays every
      // still-unacked write verbatim: the existing stream client redials
      // itself.
      const beforeReconnectFrameCount = owned.sentFrames().length;
      owned.callbacks().onConnectionStatus("open", null);

      const replayedWrites = owned
        .sentFrames()
        .slice(beforeReconnectFrameCount)
        .filter(
          (frame) =>
            frame.kind === "write" && frame.clientActionId === clientActionId,
        );
      expect(replayedWrites).toEqual([
        expect.objectContaining({ clientActionId, data: "echo hi\r" }),
      ]);
      expect(
        Object.keys(owned.handle.store.getState().pendingActions),
      ).toContain(clientActionId);
      expect(registry.get("agent-1")).toBe(owned.handle);

      // The host finally acks it.
      owned.callbacks().onActionAck({
        kind: "actionAck",
        hasBinaryPayload: false,
        sessionId: "terminal-1",
        clientActionId,
        action: "write",
        status: "accepted",
        reason: null,
        code: null,
      });

      // The original TTL window had already elapsed while the write
      // protected the entry - the ack must evict it immediately against
      // that original deadline, not restart a fresh window from now.
      expect(registry.get("agent-1")).toBeNull();
      expect(owned.closeCount()).toBe(2); // the pre-park client, then dispose
    });

    it("does not let a resize-only pending action protect an entry from ordinary TTL eviction", () => {
      const registry = new TerminalSessionRegistry();
      const owned = createHandle("terminal");

      registry.acquire(
        "terminal-1",
        () => owned.handle,
        HOST_ID,
        "presentation",
      );
      owned.callbacks().onConnectionStatus("open", null);
      // Bypass the dedupe: the store starts at 80x24, so this is a genuine
      // resize request.
      const resizeId = owned.handle.store.getState().requestResize(120, 40);
      expect(resizeId).not.toBeNull();
      expect(
        Object.keys(owned.handle.store.getState().pendingActions),
      ).toContain(resizeId);

      registry.release("terminal-1", owned.handle, true);
      expect(registry.get("terminal-1")).toBe(owned.handle);

      // A resize-only pending action never counts as active work - the
      // linger TTL runs on schedule exactly as it would with nothing
      // pending at all.
      vi.advanceTimersByTime(PLAIN_TERMINAL_RELEASE_LINGER_MS - 1);
      expect(owned.closeCount()).toBe(1);
      vi.advanceTimersByTime(1);
      expect(owned.closeCount()).toBe(2);
      expect(registry.get("terminal-1")).toBeNull();
    });
  });
});
