import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  createSessionConnectivityStore,
  isAnnouncedInterruption,
  SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
  SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
} from "@/lib/host/session-connectivity";

/**
 * Only these tests exercise `createSessionConnectivityStore` and
 * `isAnnouncedInterruption` directly - the `isReady`, `now` and `pollMs`
 * arguments exist precisely so the store can be driven without a real
 * transport or a real clock. The React hooks built on top of it
 * (`useHostSessionConnectivity`, `useHostSessionWake`) are out of scope here.
 */

function fakeStreamSession(): IStreamSession {
  return {
    sendClientFrame: () => undefined,
    onServerFrame: () => undefined,
    onStatusChange: () => undefined,
    getNegotiatedSchemaVersion: () => null,
    requestReconnect: () => undefined,
    close: () => undefined,
  };
}

interface FakeHostStreamClient extends IHostStreamClient<HostStreamRpcRegistry> {
  /** Fires every listener registered through `subscribeAvailabilityRecovered`. */
  fireAvailabilityRecovered(): void;
  /** Fires every listener registered through `onClosed`. */
  fireClosed(): void;
  readonly recoveredListenerCount: number;
  readonly closedListenerCount: number;
}

/**
 * A minimal stand-in for the real transport client. Only
 * `subscribeAvailabilityRecovered` and `onClosed` are wired to a live listener
 * set - the store's `subscribe` calls exactly those two - and the rest of the
 * interface is stubbed with real no-op implementations so the fake type-checks
 * against `IHostStreamClient<HostStreamRpcRegistry>` unchanged.
 *
 * `isReady` is fed from the SAME source as the store's injected readiness
 * thunk. The store reads the injected one, but the two answering differently
 * would be a fake that cannot occur in production, and a later reader wiring
 * the store to `client.isReady()` would then get silently inconsistent tests.
 * `reconnectAll` belongs to `useHostSessionWake` and is never called here.
 */
function createFakeHostStreamClient(
  isReady: () => boolean,
): FakeHostStreamClient {
  const recoveredListeners = new Set<() => void>();
  const closedListeners = new Set<() => void>();
  let closed = false;
  const client: FakeHostStreamClient = {
    subscribe: () => fakeStreamSession(),
    subscribeWithParamsProvider: () => {
      throw new Error("not exercised by this test");
    },
    close: () => {
      closed = true;
    },
    isClosed: () => closed,
    isReady,
    getClosedReason: () => null,
    notifyBearerRotated: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    instanceId: "fake-stream-client",
    subscribeAvailabilityRecovered: (listener: () => void) => {
      recoveredListeners.add(listener);
      return () => {
        recoveredListeners.delete(listener);
      };
    },
    onClosed: (listener: () => void) => {
      closedListeners.add(listener);
      return () => {
        closedListeners.delete(listener);
      };
    },
    fireAvailabilityRecovered: () => {
      for (const listener of [...recoveredListeners]) listener();
    },
    fireClosed: () => {
      for (const listener of [...closedListeners]) listener();
    },
    get recoveredListenerCount() {
      return recoveredListeners.size;
    },
    get closedListenerCount() {
      return closedListeners.size;
    },
  };
  return client;
}

/** A controllable readiness double: the same thunk shape the store takes. */
function createReadyControl(initial: boolean): {
  readonly isReady: () => boolean;
  readonly setReady: (value: boolean) => void;
} {
  let ready = initial;
  return {
    isReady: () => ready,
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}

/**
 * A controllable `now` double paired with the fake timer clock. `advance`
 * moves both together: the fake timer is what fires a poll tick or an episode
 * deadline, and the injected clock is what the resulting `refresh()` reads to
 * decide the outcome - moving only one of them would either never fire the
 * timer or fire it against a clock that has not actually moved.
 */
function createControllableClock(): {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
} {
  let clock = 0;
  return {
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

/**
 * Deliberately not the production cadence. These cases are about the ORDER and
 * the boundaries of the transitions, and a poll far coarser than the announce
 * window makes it visible which of the two actually decided each one.
 */
const POLL_MS = 1_000;

/** Long enough that the poll never fires, isolating the episode deadlines. */
const POLL_NEVER_MS = SESSION_CONNECTIVITY_ESCALATE_AFTER_MS * 10;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSessionConnectivityStore", () => {
  it('reports "unknown" and registers nothing when there is no stream client', () => {
    const clock = createControllableClock();
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const store = createSessionConnectivityStore({
      streamClient: null,
      isReady: () => true,
      now: clock.now,
      pollMs: POLL_MS,
      announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
      escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
    });

    expect(store.getSnapshot()).toBe("unknown");

    const listener = vi.fn();
    const dispose = store.subscribe(listener);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    clock.advance(SESSION_CONNECTIVITY_ESCALATE_AFTER_MS * 2);
    expect(listener).not.toHaveBeenCalled();

    dispose();
    setIntervalSpy.mockRestore();
  });

  it('reports "ready" while the client\'s own session is ready', () => {
    const ready = createReadyControl(true);
    const store = createSessionConnectivityStore({
      streamClient: createFakeHostStreamClient(ready.isReady),
      isReady: ready.isReady,
      now: createControllableClock().now,
      pollMs: POLL_MS,
      announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
      escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
    });

    expect(store.getSnapshot()).toBe("ready");
  });

  it('stays "dialing" while the session has never reported ready, however long it fails', () => {
    // A first dial is not a drop. Nothing may announce here, because there is
    // no interruption to announce - the session has yet to attach once.
    const ready = createReadyControl(false);
    const clock = createControllableClock();
    const store = createSessionConnectivityStore({
      streamClient: createFakeHostStreamClient(ready.isReady),
      isReady: ready.isReady,
      now: clock.now,
      pollMs: POLL_MS,
      announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
      escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
    });

    expect(store.getSnapshot()).toBe("dialing");

    const dispose = store.subscribe(vi.fn());
    clock.advance(SESSION_CONNECTIVITY_ESCALATE_AFTER_MS * 3);
    expect(store.getSnapshot()).toBe("dialing");

    dispose();
  });

  it('holds "settling" until the announce deadline, then reports "interrupted"', () => {
    // The settling window is a real state with a real reason - a drop that has
    // not yet outlived the transport's own first-redial recovery - so it gets
    // its own assertion rather than being skipped over.
    const ready = createReadyControl(true);
    const clock = createControllableClock();
    const store = createSessionConnectivityStore({
      streamClient: createFakeHostStreamClient(ready.isReady),
      isReady: ready.isReady,
      now: clock.now,
      pollMs: POLL_MS,
      announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
      escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
    });
    const dispose = store.subscribe(vi.fn());
    expect(store.getSnapshot()).toBe("ready");

    ready.setReady(false);
    clock.advance(POLL_MS);
    expect(store.getSnapshot()).toBe("settling");

    clock.advance(SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS - 1);
    expect(store.getSnapshot()).toBe("settling");

    clock.advance(1);
    expect(store.getSnapshot()).toBe("interrupted");

    dispose();
  });

  it("announces on the episode deadline rather than on the next poll tick", () => {
    // The poll decides when a drop is NOTICED; the one-shot armed at that
    // moment decides when it is announced. With a poll far coarser than the
    // announce window, a poll-quantized implementation would still read
    // "settling" here.
    const ready = createReadyControl(true);
    const clock = createControllableClock();
    const client = createFakeHostStreamClient(ready.isReady);
    const store = createSessionConnectivityStore({
      streamClient: client,
      isReady: ready.isReady,
      now: clock.now,
      pollMs: POLL_NEVER_MS,
      announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
      escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
    });
    const dispose = store.subscribe(vi.fn());

    ready.setReady(false);
    // Any observation starts the episode; a closed emission is one the
    // transport really does deliver on a drop.
    client.fireClosed();
    expect(store.getSnapshot()).toBe("settling");

    clock.advance(SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS);
    expect(store.getSnapshot()).toBe("interrupted");

    dispose();
  });

  it('escalates to "interrupted-prolonged" once the outage runs past the escalate deadline', () => {
    const ready = createReadyControl(true);
    const clock = createControllableClock();
    const store = createSessionConnectivityStore({
      streamClient: createFakeHostStreamClient(ready.isReady),
      isReady: ready.isReady,
      now: clock.now,
      pollMs: POLL_MS,
      announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
      escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
    });
    const dispose = store.subscribe(vi.fn());

    ready.setReady(false);
    clock.advance(POLL_MS);
    expect(store.getSnapshot()).toBe("settling");

    clock.advance(SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS);
    expect(store.getSnapshot()).toBe("interrupted");

    clock.advance(SESSION_CONNECTIVITY_ESCALATE_AFTER_MS);
    expect(store.getSnapshot()).toBe("interrupted-prolonged");

    dispose();
  });

  it('stays "interrupted-prolonged" through a recovery emission whose session is still not ready', () => {
    // The stickiness this proves: a redial that gets far enough to fire the
    // recovery signal and then fails again, before the session is actually
    // ready, must not walk the verdict back down to reassuring wording.
    const ready = createReadyControl(true);
    const clock = createControllableClock();
    const client = createFakeHostStreamClient(ready.isReady);
    const store = createSessionConnectivityStore({
      streamClient: client,
      isReady: ready.isReady,
      now: clock.now,
      pollMs: POLL_MS,
      announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
      escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
    });
    const dispose = store.subscribe(vi.fn());

    ready.setReady(false);
    // Stepped, not one jump: the first advance is what lets a poll tick
    // OBSERVE the drop and start the episode. A single large advance would
    // date the outage from the end of the jump instead.
    clock.advance(POLL_MS);
    clock.advance(SESSION_CONNECTIVITY_ESCALATE_AFTER_MS);
    expect(store.getSnapshot()).toBe("interrupted-prolonged");

    client.fireAvailabilityRecovered();
    expect(store.getSnapshot()).toBe("interrupted-prolonged");

    dispose();
  });

  it('starts a fresh episode at "settling" after reaching ready again', () => {
    // A new outage is not the old one: reaching ready clears the episode, or a
    // session that recovers and drops again would skip straight back to the
    // strongest wording for a brand new drop.
    const ready = createReadyControl(true);
    const clock = createControllableClock();
    const store = createSessionConnectivityStore({
      streamClient: createFakeHostStreamClient(ready.isReady),
      isReady: ready.isReady,
      now: clock.now,
      pollMs: POLL_MS,
      announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
      escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
    });
    const dispose = store.subscribe(vi.fn());

    ready.setReady(false);
    clock.advance(POLL_MS);
    clock.advance(SESSION_CONNECTIVITY_ESCALATE_AFTER_MS);
    expect(store.getSnapshot()).toBe("interrupted-prolonged");

    ready.setReady(true);
    clock.advance(POLL_MS);
    expect(store.getSnapshot()).toBe("ready");

    ready.setReady(false);
    clock.advance(POLL_MS);
    expect(store.getSnapshot()).toBe("settling");

    dispose();
  });

  it("does not carry episode state to a fresh store built for a different client", () => {
    const readyA = createReadyControl(true);
    const clockA = createControllableClock();
    const storeA = createSessionConnectivityStore({
      streamClient: createFakeHostStreamClient(readyA.isReady),
      isReady: readyA.isReady,
      now: clockA.now,
      pollMs: POLL_MS,
      announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
      escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
    });

    const disposeA = storeA.subscribe(vi.fn());
    readyA.setReady(false);
    clockA.advance(POLL_MS);
    clockA.advance(SESSION_CONNECTIVITY_ESCALATE_AFTER_MS);
    expect(storeA.getSnapshot()).toBe("interrupted-prolonged");
    disposeA();

    const readyB = createReadyControl(false);
    const storeB = createSessionConnectivityStore({
      streamClient: createFakeHostStreamClient(readyB.isReady),
      isReady: readyB.isReady,
      now: createControllableClock().now,
      pollMs: POLL_MS,
      announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
      escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
    });
    expect(storeB.getSnapshot()).toBe("dialing");
  });

  it("keeps the surviving subscriber's signals when an overlapping subscription is disposed", () => {
    // React can hold an old and a new subscription at once across a re-render.
    // Every signal is registered ONCE for the store, so a per-subscription
    // teardown would cancel the deadlines and delete the client registrations
    // that the surviving subscriber is still relying on - leaving it attached
    // to a store that has quietly stopped listening to anything.
    const ready = createReadyControl(true);
    const clock = createControllableClock();
    const client = createFakeHostStreamClient(ready.isReady);
    const store = createSessionConnectivityStore({
      streamClient: client,
      isReady: ready.isReady,
      now: clock.now,
      pollMs: POLL_NEVER_MS,
      announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
      escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
    });

    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const disposeA = store.subscribe(listenerA);
    const disposeB = store.subscribe(listenerB);
    // Registered once for the store, not once per subscriber.
    expect(client.recoveredListenerCount).toBe(1);
    expect(client.closedListenerCount).toBe(1);

    ready.setReady(false);
    client.fireClosed();
    expect(store.getSnapshot()).toBe("settling");

    disposeA();
    expect(client.recoveredListenerCount).toBe(1);
    expect(client.closedListenerCount).toBe(1);

    // The announce deadline still lands exactly, for the subscriber that is
    // still here - not degraded to whenever the poll next happens to run.
    const callsBeforeDeadline = listenerB.mock.calls.length;
    clock.advance(SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS);
    expect(store.getSnapshot()).toBe("interrupted");
    expect(listenerB.mock.calls.length).toBeGreaterThan(callsBeforeDeadline);

    // And the client's own recovery signal still reaches it.
    ready.setReady(true);
    client.fireAvailabilityRecovered();
    expect(store.getSnapshot()).toBe("ready");

    disposeB();
  });

  it("resumes the current episode's remaining deadlines when a listener re-subscribes mid-outage", () => {
    // A remount during an outage must not restart its clock. If it did, a
    // surface that re-subscribed often enough would postpone its own
    // announcement indefinitely while the connection stayed down.
    const ready = createReadyControl(true);
    const clock = createControllableClock();
    const client = createFakeHostStreamClient(ready.isReady);
    const store = createSessionConnectivityStore({
      streamClient: client,
      isReady: ready.isReady,
      now: clock.now,
      pollMs: POLL_NEVER_MS,
      announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
      escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
    });

    const disposeA = store.subscribe(vi.fn());
    ready.setReady(false);
    client.fireClosed();
    expect(store.getSnapshot()).toBe("settling");

    const halfway = Math.floor(SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS / 2);
    clock.advance(halfway);
    expect(store.getSnapshot()).toBe("settling");

    disposeA();
    const disposeB = store.subscribe(vi.fn());

    // The remaining half of the ORIGINAL window. A restarted schedule would
    // still read "settling" here and need a full window more.
    clock.advance(SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS - halfway);
    expect(store.getSnapshot()).toBe("interrupted");

    disposeB();
  });

  it("clears the poll interval and both client subscriptions once the last listener leaves", () => {
    const ready = createReadyControl(false);
    const clock = createControllableClock();
    const client = createFakeHostStreamClient(ready.isReady);
    const store = createSessionConnectivityStore({
      streamClient: client,
      isReady: ready.isReady,
      now: clock.now,
      pollMs: POLL_MS,
      announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
      escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
    });

    const listener = vi.fn();
    const dispose = store.subscribe(listener);
    expect(client.recoveredListenerCount).toBe(1);
    expect(client.closedListenerCount).toBe(1);

    const callsBeforeDispose = listener.mock.calls.length;
    dispose();
    expect(client.recoveredListenerCount).toBe(0);
    expect(client.closedListenerCount).toBe(0);

    clock.advance(POLL_MS * 10);
    expect(listener.mock.calls.length).toBe(callsBeforeDispose);
  });

  it("clears the armed episode deadlines once the last listener leaves", () => {
    // The poll and the client subscriptions are torn down explicitly, so the
    // episode deadlines are the only timers that could still fire into a store
    // nobody is watching - and they are armed precisely when an outage is
    // live, which is when a store is most likely to be torn down. The episode
    // itself survives; only its timers stand down.
    const ready = createReadyControl(true);
    const clock = createControllableClock();
    const client = createFakeHostStreamClient(ready.isReady);
    const store = createSessionConnectivityStore({
      streamClient: client,
      isReady: ready.isReady,
      now: clock.now,
      pollMs: POLL_NEVER_MS,
      announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
      escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
    });

    const listener = vi.fn();
    const dispose = store.subscribe(listener);
    ready.setReady(false);
    // The poll never fires here, so an emission is what starts the episode and
    // arms the deadlines this case is about.
    client.fireClosed();
    expect(store.getSnapshot()).toBe("settling");

    const callsBeforeDispose = listener.mock.calls.length;
    dispose();

    clock.advance(SESSION_CONNECTIVITY_ESCALATE_AFTER_MS * 2);
    expect(listener.mock.calls.length).toBe(callsBeforeDispose);
  });

  it("notifies the listener on a recovery emission and on a closed emission", () => {
    const ready = createReadyControl(false);
    const client = createFakeHostStreamClient(ready.isReady);
    const store = createSessionConnectivityStore({
      streamClient: client,
      isReady: ready.isReady,
      now: createControllableClock().now,
      pollMs: POLL_NEVER_MS,
      announceAfterMs: SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
      escalateAfterMs: SESSION_CONNECTIVITY_ESCALATE_AFTER_MS,
    });

    const listener = vi.fn();
    const dispose = store.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();

    client.fireAvailabilityRecovered();
    expect(listener).toHaveBeenCalledTimes(1);

    client.fireClosed();
    expect(listener).toHaveBeenCalledTimes(2);

    dispose();
  });
});

describe("isAnnouncedInterruption", () => {
  it.each([
    ["ready", false] as const,
    ["settling", false] as const,
    ["interrupted", true] as const,
    ["interrupted-prolonged", true] as const,
    ["dialing", false] as const,
    ["unknown", false] as const,
  ])("reports %s as announced=%s", (connectivity, announced) => {
    expect(isAnnouncedInterruption(connectivity)).toBe(announced);
  });
});
