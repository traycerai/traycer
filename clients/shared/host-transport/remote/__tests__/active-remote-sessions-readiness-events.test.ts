import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import { REMOTE_SESSION_LINGER_MS } from "../config";
import type { IRemoteSession } from "../remote-session";
import {
  acquireRemoteSession,
  hasReadyRemoteSession,
  resetRemoteSessionReadinessListenersForTest,
  subscribeRemoteSessionReadiness,
  type RemoteSessionIdentity,
} from "../active-remote-sessions";

// `subscribeRemoteSessionReadiness` (redesign P4.1 / connection-registry §6):
// the cache now reports its own transitions instead of being polled. This
// suite pins WHICH transitions notify and the two properties of the delivery
// mechanism itself - coalescing and deferral onto a microtask - using a fake
// `IRemoteSession` whose readiness/close listeners the test can fire
// directly, the same test-double strategy `active-remote-sessions.test.ts`
// uses for the cache's ref-count/linger lifecycle.

interface FakeSession extends IRemoteSession<
  VersionedRpcRegistry,
  VersionedStreamRpcRegistry
> {
  readonly closeCalls: number;
  ready: boolean;
  closedUnderneath: boolean;
  /** Simulates the session reaching its ready boundary (clean open or recovery). */
  fireAvailabilityRecovered(): void;
  /**
   * Simulates the DOWN edge - a relay `host_detached` or a drop into
   * `reconnecting`. Flips `ready` false as the real session does, so a test
   * asserting the published snapshot sees what a subscriber would.
   */
  fireReadinessLost(): void;
  /** Simulates a session-level fatal closing the session IN PLACE. */
  fireClosedUnderneath(): void;
}

function fakeSession(): FakeSession {
  let closeCalls = 0;
  const recoveredListeners = new Set<() => void>();
  const readinessLostListeners = new Set<() => void>();
  const closedListeners = new Set<() => void>();
  const session: FakeSession = {
    get closeCalls() {
      return closeCalls;
    },
    ready: false,
    closedUnderneath: false,
    start: vi.fn(),
    isClosed: () => closeCalls > 0 || session.closedUnderneath,
    isReady: () => session.ready,
    sendUnary: vi.fn(async () => ({}) as never),
    subscribe: vi.fn(() => {
      throw new Error("not exercised by these tests");
    }),
    subscribeWithParamsProvider: vi.fn(() => {
      throw new Error("not exercised by these tests");
    }),
    notifyBearerRotated: vi.fn(),
    wake: vi.fn(),
    onClosed: (listener) => {
      closedListeners.add(listener);
      return () => {
        closedListeners.delete(listener);
      };
    },
    subscribeAvailabilityRecovered: (listener) => {
      recoveredListeners.add(listener);
      return () => {
        recoveredListeners.delete(listener);
      };
    },
    subscribeReadinessLost: (listener) => {
      readinessLostListeners.add(listener);
      return () => {
        readinessLostListeners.delete(listener);
      };
    },
    terminalFatal: () => null,
    close: () => {
      closeCalls += 1;
    },
    fireAvailabilityRecovered: () => {
      for (const listener of [...recoveredListeners]) listener();
    },
    fireReadinessLost: () => {
      session.ready = false;
      for (const listener of [...readinessLostListeners]) listener();
    },
    fireClosedUnderneath: () => {
      session.closedUnderneath = true;
      for (const listener of [...closedListeners]) listener();
    },
  };
  return session;
}

let nextHostId = 0;
function freshIdentity(): RemoteSessionIdentity {
  nextHostId += 1;
  return {
    hostId: `host-${nextHostId}`,
    userId: `user-${nextHostId}`,
    hostPublicKey: `pubkey-${nextHostId}`,
    relayAttachUrl: `wss://relay.test/attach-${nextHostId}`,
    authRecovery: "revalidate",
    authEpoch: "lease-1",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // The module is shared across suites - a listener left registered here
  // would fire into an unrelated test's assertions.
  resetRemoteSessionReadinessListenersForTest();
  vi.useRealTimers();
});

describe("subscribeRemoteSessionReadiness — which transitions notify", () => {
  it("fires on a ready boundary (subscribeAvailabilityRecovered)", async () => {
    const identity = freshIdentity();
    const session = fakeSession();
    const listener = vi.fn();
    subscribeRemoteSessionReadiness(listener);

    const view = acquireRemoteSession(identity, () => session);
    session.fireAvailabilityRecovered();
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
    view.close();
  });

  it("fires when a READY session loses readiness without closing (the down edge)", async () => {
    // The transition the poll-to-event migration dropped. `host_detached` and
    // a drop into `reconnecting` both flip `isReady()` false while the session
    // stays alive, so neither of the other two edges fires - `onClosed` is for
    // a session that DIED, and `subscribeAvailabilityRecovered` is the way up.
    const identity = freshIdentity();
    const session = fakeSession();
    const listener = vi.fn();
    subscribeRemoteSessionReadiness(listener);

    const view = acquireRemoteSession(identity, () => session);
    // Premise, positively: the host really is ready and really is being
    // reported as such. Without this the assertion below is satisfied by a
    // host that was never ready, which is the state a broken wiring produces.
    session.ready = true;
    session.fireAvailabilityRecovered();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(hasReadyRemoteSession(identity.hostId)).toBe(true);

    listener.mockClear();
    session.fireReadinessLost();
    await Promise.resolve();

    // The notification, and the value it makes readable. Asserting only the
    // second would pass on the unfixed tree: `hasReadyRemoteSession` reads
    // `isReady()` live, so it was ALREADY correct - what was missing is that
    // nobody was told to re-read it.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(hasReadyRemoteSession(identity.hostId)).toBe(false);
    expect(session.isClosed()).toBe(false);
    view.close();
  });

  it("fires on a session closing underneath (onClosed, a session-level fatal)", async () => {
    const identity = freshIdentity();
    const session = fakeSession();
    const listener = vi.fn();
    subscribeRemoteSessionReadiness(listener);

    acquireRemoteSession(identity, () => session);
    session.fireClosedUnderneath();
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fires on supersession — a NEW identity's acquire retiring an old FREE entry for the same host", async () => {
    const base = freshIdentity();
    const identityKeyA: RemoteSessionIdentity = {
      ...base,
      hostPublicKey: "pubkey-a",
    };
    const identityKeyB: RemoteSessionIdentity = {
      ...base,
      hostPublicKey: "pubkey-b",
    };
    const staleSession = fakeSession();
    acquireRemoteSession(identityKeyA, () => staleSession).close();

    const listener = vi.fn();
    subscribeRemoteSessionReadiness(listener);

    // Key A is free (released above), so this supersession closes it outright.
    acquireRemoteSession(identityKeyB, () => fakeSession());
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(staleSession.closeCalls).toBe(1);
  });

  it("fires on eviction of a closed entry at the next acquire for that identity", async () => {
    const identity = freshIdentity();
    const dead = fakeSession();
    const view = acquireRemoteSession(identity, () => dead);
    dead.closedUnderneath = true;
    expect(view.isClosed()).toBe(true);

    const listener = vi.fn();
    subscribeRemoteSessionReadiness(listener);

    // The re-acquire evicts the closed entry before building a fresh one -
    // that eviction is its own notify, distinct from the fatal that closed it.
    acquireRemoteSession(identity, () => fakeSession());
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fires when the keep-warm linger expires", async () => {
    const identity = freshIdentity();
    const session = fakeSession();
    const view = acquireRemoteSession(identity, () => session);
    view.close();

    const listener = vi.fn();
    subscribeRemoteSessionReadiness(listener);

    vi.advanceTimersByTime(REMOTE_SESSION_LINGER_MS);
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.closeCalls).toBe(1);
  });
});

describe("delivery mechanics — coalescing and deferral", () => {
  it("coalesces several transitions inside one tick into ONE notification", async () => {
    const identityA = freshIdentity();
    const identityB = freshIdentity();
    const sessionA = fakeSession();
    const sessionB = fakeSession();

    const listener = vi.fn();
    subscribeRemoteSessionReadiness(listener);

    // Three distinct transitions, all synchronous, all in the same tick.
    const viewA = acquireRemoteSession(identityA, () => sessionA);
    sessionA.fireAvailabilityRecovered();
    acquireRemoteSession(identityB, () => sessionB);
    sessionB.fireClosedUnderneath();

    // Not yet delivered - coalescing defers past the synchronous burst.
    expect(listener).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
    viewA.close();
  });

  it("is NOT invoked synchronously inside the cache mutation that triggered it — the mutation completes first, delivery follows on a later microtask turn", async () => {
    // This is the load-bearing property, not a cosmetic detail: `close()`
    // fires `onClosed` listeners synchronously from inside the cache's own
    // mutation paths, and a synchronous notify would re-enter the cache
    // mid-mutation. The eviction-on-reacquire path exercises exactly that:
    // the whole eviction (dispose wiring, delete the old entry, notify,
    // build the fresh session, insert it) must finish BEFORE any readiness
    // listener runs.
    const identity = freshIdentity();
    const dead = fakeSession();
    acquireRemoteSession(identity, () => dead);
    dead.closedUnderneath = true;

    const order: string[] = [];
    subscribeRemoteSessionReadiness(() => order.push("notified"));

    order.push("before-reacquire");
    const rebuilt = acquireRemoteSession(identity, () => fakeSession());
    order.push("after-reacquire");

    // The reacquire's full mutation (eviction + fresh construction) ran to
    // completion, ordering "after-reacquire" right behind it, with no
    // "notified" spliced in between - proof the listener did not fire from
    // inside that call.
    expect(order).toEqual(["before-reacquire", "after-reacquire"]);
    expect(rebuilt.isClosed()).toBe(false);

    await Promise.resolve();
    order.push("after-microtask");

    expect(order).toEqual([
      "before-reacquire",
      "after-reacquire",
      "notified",
      "after-microtask",
    ]);
  });
});
