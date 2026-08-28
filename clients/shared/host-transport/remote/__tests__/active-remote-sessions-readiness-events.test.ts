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
  tryAcquireReadyRemoteSession,
  type RemoteSessionAcquirePolicy,
  type RemoteSessionIdentity,
} from "../active-remote-sessions";

/**
 * The default acquire policy for these lifecycle tests: a durable consumer,
 * eligible for the proactive sweep. Sweep-eligibility cases build their own.
 */
const ELIGIBLE_POLICY: RemoteSessionAcquirePolicy = {
  proactiveWakeEligible: true,
};

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
    forceReconnect: vi.fn(),
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

    const view = acquireRemoteSession(identity, ELIGIBLE_POLICY, () => session);
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

    const view = acquireRemoteSession(identity, ELIGIBLE_POLICY, () => session);
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

    acquireRemoteSession(identity, ELIGIBLE_POLICY, () => session);
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
    acquireRemoteSession(
      identityKeyA,
      ELIGIBLE_POLICY,
      () => staleSession,
    ).close();

    const listener = vi.fn();
    subscribeRemoteSessionReadiness(listener);

    // Key A is free (released above), so this supersession closes it outright.
    acquireRemoteSession(identityKeyB, ELIGIBLE_POLICY, () => fakeSession());
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(staleSession.closeCalls).toBe(1);
  });

  it("fires on eviction of a closed entry at the next acquire for that identity", async () => {
    const identity = freshIdentity();
    const dead = fakeSession();
    const view = acquireRemoteSession(identity, ELIGIBLE_POLICY, () => dead);
    dead.closedUnderneath = true;
    expect(view.isClosed()).toBe(true);

    const listener = vi.fn();
    subscribeRemoteSessionReadiness(listener);

    // The re-acquire evicts the closed entry before building a fresh one -
    // that eviction is its own notify, distinct from the fatal that closed it.
    acquireRemoteSession(identity, ELIGIBLE_POLICY, () => fakeSession());
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fires when the keep-warm linger expires", async () => {
    const identity = freshIdentity();
    const session = fakeSession();
    const view = acquireRemoteSession(identity, ELIGIBLE_POLICY, () => session);
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
    const viewA = acquireRemoteSession(
      identityA,
      ELIGIBLE_POLICY,
      () => sessionA,
    );
    sessionA.fireAvailabilityRecovered();
    acquireRemoteSession(identityB, ELIGIBLE_POLICY, () => sessionB);
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
    acquireRemoteSession(identity, ELIGIBLE_POLICY, () => dead);
    dead.closedUnderneath = true;

    const order: string[] = [];
    subscribeRemoteSessionReadiness(() => order.push("notified"));

    order.push("before-reacquire");
    const rebuilt = acquireRemoteSession(identity, ELIGIBLE_POLICY, () =>
      fakeSession(),
    );
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

describe("subscribeRemoteSessionReadiness — the BORROWABILITY edges (Ticket 06)", () => {
  // `hasBorrowableRemoteSession` answers a DIFFERENT question from every
  // pre-existing wiring above: who holds the entry, not whether the session
  // itself is ready. Two notify() calls exist for exactly that reason - one
  // on the 0->1 consumer transition (acquire), one on the 1->0 transition
  // that arms the keep-warm linger (release) - and without them a subscriber
  // holds a stale borrowable answer across the one transition it exists to
  // observe, silently. Nothing throws, nothing fails a type check: the only
  // way to catch a regression here is to witness the wake.

  it("fires on the 0 -> 1 consumer transition (acquire), positively witnessed by ALSO firing on a pre-existing edge (a session closing underneath)", async () => {
    const identity = freshIdentity();
    const session = fakeSession();
    const listener = vi.fn();
    subscribeRemoteSessionReadiness(listener);

    // Edge under test: the very first acquire for this identity.
    const view = acquireRemoteSession(identity, ELIGIBLE_POLICY, () => session);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);

    // Positive control, epic-standard: the SAME subscriber must also wake on
    // an edge that already worked before this ticket, so "it fired" is known
    // to mean something in this harness rather than a listener nobody wired.
    listener.mockClear();
    session.fireClosedUnderneath();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);

    view.close();
  });

  it("fires on a warm re-acquire of a lingering entry (also a 0 -> 1 transition, and it cancels the pending linger)", async () => {
    const identity = freshIdentity();
    const session = fakeSession();
    const view = acquireRemoteSession(identity, ELIGIBLE_POLICY, () => session);
    view.close(); // now lingering at refCount 0
    // Drain the release's OWN notify (a different edge, already covered
    // below) before subscribing - otherwise it is still pending on the
    // microtask queue and the flush after the reacquire would deliver THAT
    // one to the listener, making the assertion below pass regardless of
    // whether the reacquire's own notify fires at all.
    await Promise.resolve();

    const listener = vi.fn();
    subscribeRemoteSessionReadiness(listener);

    const reacquired = acquireRemoteSession(identity, ELIGIBLE_POLICY, () => {
      throw new Error("must adopt the warm session, not build a new one");
    });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);

    reacquired.close();
  });

  it("fires on the 1 -> 0 transition that ARMS the keep-warm linger (release), positively witnessed against the same pre-existing edge", async () => {
    const identity = freshIdentity();
    const session = fakeSession();
    const view = acquireRemoteSession(identity, ELIGIBLE_POLICY, () => session);
    // Drain the ACQUIRE's own notify (the 0 -> 1 edge, covered above) before
    // subscribing - otherwise it is still pending on the microtask queue and
    // the flush below would deliver THAT one, making the assertion pass
    // regardless of whether the release's own notify fires at all.
    await Promise.resolve();

    const listener = vi.fn();
    subscribeRemoteSessionReadiness(listener);

    // Edge under test: the release that brings refCount to zero and arms the
    // linger timer (not the linger's later expiry - that edge is already
    // covered above by "fires when the keep-warm linger expires").
    view.close();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);

    // Positive control, same subscriber, a pre-existing edge.
    listener.mockClear();
    vi.advanceTimersByTime(REMOTE_SESSION_LINGER_MS);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.closeCalls).toBe(1);
  });

  it("the borrowable predicate is reactive across both edges - a poller subscribed once observes both the gain and the loss of a borrowable session", async () => {
    // Not an ablation target on its own (that is the two tests below); this
    // pins the OBSERVABLE property the two notify() calls exist to produce -
    // a subscriber's next read of `tryAcquireReadyRemoteSession` reflects
    // reality on both sides of the borrow window, not just one.
    const identity = freshIdentity();
    const session = fakeSession();
    session.ready = true;
    const readings: boolean[] = [];
    subscribeRemoteSessionReadiness(() => {
      // Capture and release the borrow rather than discarding the handle: a
      // leaked borrow would inflate `borrowCount` for every other test that
      // shares this module's `entriesByKey` map.
      const borrow = tryAcquireReadyRemoteSession(identity.hostId);
      readings.push(borrow !== null);
      borrow?.release();
    });

    const view = acquireRemoteSession(identity, ELIGIBLE_POLICY, () => session);
    await Promise.resolve();
    view.close();
    await Promise.resolve();

    expect(readings).toEqual([true, false]);
  });
});
