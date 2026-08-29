import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import { REMOTE_SESSION_LINGER_MS } from "../config";
import type { IRemoteSession } from "../remote-session";
import {
  acquireRemoteSession,
  hasBorrowableRemoteSession,
  remoteSessionBorrowCountForTest,
  retireAllRemoteSessions,
  tryAcquireReadyRemoteSession,
  type RemoteSessionAcquirePolicy,
  type RemoteSessionIdentity,
} from "../active-remote-sessions";

// Borrow semantics are policy-independent (the borrow surface never consults
// sweep eligibility), so one sweep-eligible policy serves every case here.
const BORROW_TEST_POLICY: RemoteSessionAcquirePolicy = {
  proactiveWakeEligible: true,
};

// `tryAcquireReadyRemoteSession` / `hasBorrowableRemoteSession` (Ticket 06):
// the narrow, non-lingering-extending surface a fleet-status poller gets. The
// whole point is a property of the SIGNATURE, not merely the body: fleet
// observation must create zero sessions, prolong zero sessions, and never
// extend the keep-warm linger. Same fake-`IRemoteSession` test-double strategy
// as `active-remote-sessions.test.ts` - this is pure timer/map logic with no
// I/O, so fake timers are the right (and only) tool; they would be the WRONG
// one if this ever touched real filesystem or network I/O, which it does not.

interface FakeSession extends IRemoteSession<
  VersionedRpcRegistry,
  VersionedStreamRpcRegistry
> {
  readonly closeCalls: number;
  ready: boolean;
  closedUnderneath: boolean;
}

function fakeSession(): FakeSession {
  let closeCalls = 0;
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
    forceReconnect: vi.fn(),
    subscribe: vi.fn(() => {
      throw new Error("not exercised by these tests");
    }),
    subscribeWithParamsProvider: vi.fn(() => {
      throw new Error("not exercised by these tests");
    }),
    notifyBearerRotated: vi.fn(),
    wake: vi.fn(),
    onClosed: () => () => undefined,
    subscribeAvailabilityRecovered: () => () => undefined,
    subscribeReadinessLost: () => () => undefined,
    terminalFatal: () => null,
    close: () => {
      closeCalls += 1;
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
  // Every entry this suite creates is module-scoped state
  // (`active-remote-sessions.ts`'s `entriesByKey` is a single shared map), so
  // a test that leaves an entry lingering or held would otherwise bleed into
  // the next one. Retiring closes/marks everything outstanding before the
  // fake-timer teardown below.
  retireAllRemoteSessions();
  vi.useRealTimers();
});

describe("tryAcquireReadyRemoteSession", () => {
  it("(1) refuses a lingering (refCount 0) entry, and the session's close() still fires at EXACTLY the linger window from the release that armed it", () => {
    const identity = freshIdentity();
    const session = fakeSession();
    session.ready = true;
    const owner = acquireRemoteSession(
      identity,
      BORROW_TEST_POLICY,
      () => session,
    );

    owner.close(); // last consumer gone: entry now lingers at refCount 0
    expect(tryAcquireReadyRemoteSession(identity.hostId)).toBeNull();
    expect(hasBorrowableRemoteSession(identity.hostId)).toBe(false);

    // The bite: a borrow that reset the timer would still pass a bare
    // "close was eventually called" assertion. Pinning the EXACT instant is
    // what would catch that regression.
    vi.advanceTimersByTime(REMOTE_SESSION_LINGER_MS - 1);
    expect(session.closeCalls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(session.closeCalls).toBe(1);
  });

  it("(2, load-bearing) a status-poll borrow does not defer teardown - close() fires at OWNER-release + linger, never at borrow-release + linger", () => {
    const identity = freshIdentity();
    const session = fakeSession();
    session.ready = true;
    const owner = acquireRemoteSession(
      identity,
      BORROW_TEST_POLICY,
      () => session,
    );

    const borrow = tryAcquireReadyRemoteSession(identity.hostId);
    expect(borrow).not.toBeNull();
    if (borrow === null) throw new Error("expected a borrow");

    // T: the owner releases - this is the instant that must arm the linger.
    owner.close();
    const DELTA_WELL_UNDER_THE_WINDOW = 10_000;
    vi.advanceTimersByTime(DELTA_WELL_UNDER_THE_WINDOW);
    // T + Δ: the poller gives its borrow back, long after the owner released.
    borrow.release();

    // If someone later folds borrows into `refCount`, release() above would
    // (re-)arm the linger at T + Δ instead, and this assertion goes red: at
    // T + LINGER the session would still be open (torn down only at
    // T + Δ + LINGER instead).
    vi.advanceTimersByTime(
      REMOTE_SESSION_LINGER_MS - DELTA_WELL_UNDER_THE_WINDOW - 1,
    );
    expect(session.closeCalls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(session.closeCalls).toBe(1);
  });

  it("(3) observing several hosts with no cached session creates ZERO sessions - witnessed against a positive control that DOES construct one", () => {
    const hostWithNoSession1 = freshIdentity().hostId;
    const hostWithNoSession2 = freshIdentity().hostId;
    const hostWithNoSession3 = freshIdentity().hostId;
    const factory = vi.fn(() => fakeSession());

    expect(tryAcquireReadyRemoteSession(hostWithNoSession1)).toBeNull();
    expect(tryAcquireReadyRemoteSession(hostWithNoSession2)).toBeNull();
    expect(tryAcquireReadyRemoteSession(hostWithNoSession3)).toBeNull();
    expect(factory).not.toHaveBeenCalled();

    // Positive control: the identical spy DOES fire for a genuine acquire, so
    // the absence above is a witnessed absence rather than a factory that was
    // never wired to fire at all (this repo has been bitten by that shape of
    // vacuous assertion four times).
    const identity = freshIdentity();
    const view = acquireRemoteSession(identity, BORROW_TEST_POLICY, factory);
    expect(factory).toHaveBeenCalledTimes(1);
    view.close();
  });

  it("(4) balances under concurrent retirement: release() after retireAllRemoteSessions() does not throw, is idempotent, and leaves the borrow count at zero with no underflow onto a successor entry", async () => {
    const identity = freshIdentity();
    const session = fakeSession();
    session.ready = true;
    const owner = acquireRemoteSession(
      identity,
      BORROW_TEST_POLICY,
      () => session,
    );

    const borrow = tryAcquireReadyRemoteSession(identity.hostId);
    expect(borrow).not.toBeNull();
    if (borrow === null) throw new Error("expected a borrow");
    expect(remoteSessionBorrowCountForTest(identity)).toBe(1);

    // The sign-out path, firing while the borrow is still outstanding.
    retireAllRemoteSessions();
    // Still held (owner has not released), so the sweep only marked it -
    // exactly the "still held" branch `closeSupersededIdentities` documents.
    expect(session.closeCalls).toBe(0);

    // BEFORE the give-back, and this is the window the balance assertions
    // below cannot see. The entry is marked but deliberately still OPEN,
    // because the owner holds it - so nothing had closed the session and the
    // borrow's only guard, `released`, was still false. It kept polling over
    // an identity the sign-out retired, under the retired credential, for as
    // long as the owner held on. The handle must refuse on its own.
    await expect(
      borrow.sendUnary("host.status" as never, {} as never, null, undefined),
    ).rejects.toThrow(/superseded/);
    expect(session.sendUnary).not.toHaveBeenCalled();
    // Refusing does not disturb the accounting the rest of this test asserts.
    expect(remoteSessionBorrowCountForTest(identity)).toBe(1);

    expect(() => borrow.release()).not.toThrow();
    expect(() => borrow.release()).not.toThrow(); // idempotent give-back
    expect(remoteSessionBorrowCountForTest(identity)).toBe(0);

    // A released handle's sendUnary rejects rather than dispatching.
    await expect(
      borrow.sendUnary("host.status" as never, {} as never, null, undefined),
    ).rejects.toThrow();

    // The owner's release finds the entry superseded and closes it on the
    // spot (never lingers a retired identity).
    owner.close();
    expect(session.closeCalls).toBe(1);

    // No underflow leaked onto a successor entry for the SAME identity: a
    // fresh acquire starts its own borrow count at zero.
    const successorSession = fakeSession();
    const successor = acquireRemoteSession(
      identity,
      BORROW_TEST_POLICY,
      () => successorSession,
    );
    expect(remoteSessionBorrowCountForTest(identity)).toBe(0);
    successor.close();
  });

  // The positive control for (4)'s supersession refusal. Without it, a
  // `sendUnary` that rejected unconditionally would pass that assertion and
  // silently break every real status poll.
  it("(4b) an UNsuperseded borrow still dispatches to the underlying session", async () => {
    const identity = freshIdentity();
    const session = fakeSession();
    session.ready = true;
    const owner = acquireRemoteSession(
      identity,
      BORROW_TEST_POLICY,
      () => session,
    );

    const borrow = tryAcquireReadyRemoteSession(identity.hostId);
    if (borrow === null) throw new Error("expected a borrow");
    await borrow.sendUnary(
      "host.status" as never,
      {} as never,
      null,
      undefined,
    );
    expect(session.sendUnary).toHaveBeenCalledTimes(1);

    borrow.release();
    owner.close();
  });

  // (4) covers supersession observed BEFORE the send. This is the window it
  // cannot see: the pre-send check is a snapshot, so a retirement that lands
  // while the unary is in flight has already passed that guard, and the retired
  // session's response is handed back — where the status reader timestamps it
  // as a fresh current observation. That is the same stale-value-as-live
  // outcome (4) exists to prevent, arriving by the one path it does not watch.
  it("(4c) refuses a response that RESOLVED after the identity was superseded mid-flight", async () => {
    const identity = freshIdentity();
    const session = fakeSession();
    session.ready = true;
    const owner = acquireRemoteSession(
      identity,
      BORROW_TEST_POLICY,
      () => session,
    );

    const borrow = tryAcquireReadyRemoteSession(identity.hostId);
    if (borrow === null) throw new Error("expected a borrow");

    // Hold the unary open so supersession lands strictly between the pre-send
    // check and the resolution, which is the ordering the bug needs.
    //
    // Assigned directly rather than via `mockImplementationOnce`: `FakeSession`
    // types `sendUnary` as the plain call signature, so the mock API is not
    // visible on it and only vitest's runtime would have accepted that - a
    // green test the type-checker rejects. The settle handle lives on an object
    // because a bare `let` assigned inside this callback narrows to `never` at
    // the read below.
    const gate: { settle: (() => void) | null } = { settle: null };
    session.sendUnary = vi.fn(
      () =>
        // `Promise<never>` (not a bare `new Promise`, which infers
        // `Promise<unknown>`) so this is assignable to `sendUnary`'s generic
        // response type - the same reason `fakeSession` writes `({}) as never`.
        new Promise<never>((resolve) => {
          gate.settle = () => resolve({} as never);
        }),
    );

    const pending = borrow.sendUnary(
      "host.status" as never,
      {} as never,
      null,
      undefined,
    );
    // It really did dispatch: this is not the pre-send arm firing early, which
    // would make the assertion below pass for the wrong reason.
    expect(session.sendUnary).toHaveBeenCalledTimes(1);

    retireAllRemoteSessions();
    if (gate.settle === null)
      throw new Error("expected the unary to be pending");
    gate.settle();

    await expect(pending).rejects.toThrow(/superseded/);

    borrow.release();
    owner.close();
  });

  // The positive control for (4c), and the one that matters most: the
  // post-resolution recheck must not reject responses that were never
  // superseded. Without this, a recheck that always threw would satisfy (4c)
  // and break every real status poll.
  it("(4d) a response that resolves while still current is returned unchanged", async () => {
    const identity = freshIdentity();
    const session = fakeSession();
    session.ready = true;
    const owner = acquireRemoteSession(
      identity,
      BORROW_TEST_POLICY,
      () => session,
    );

    const borrow = tryAcquireReadyRemoteSession(identity.hostId);
    if (borrow === null) throw new Error("expected a borrow");

    const gate: { settle: (() => void) | null } = { settle: null };
    session.sendUnary = vi.fn(
      () =>
        // `Promise<never>` (not a bare `new Promise`, which infers
        // `Promise<unknown>`) so this is assignable to `sendUnary`'s generic
        // response type - the same reason `fakeSession` writes `({}) as never`.
        new Promise<never>((resolve) => {
          gate.settle = () => resolve({} as never);
        }),
    );

    const pending = borrow.sendUnary(
      "host.status" as never,
      {} as never,
      null,
      undefined,
    );
    if (gate.settle === null)
      throw new Error("expected the unary to be pending");
    gate.settle();

    await expect(pending).resolves.toEqual({});

    borrow.release();
    owner.close();
  });

  it("a borrowed handle exposes no close() and no subscribe() - a borrower cannot tear down or open streams on a session it does not own", () => {
    const identity = freshIdentity();
    const session = fakeSession();
    session.ready = true;
    const owner = acquireRemoteSession(
      identity,
      BORROW_TEST_POLICY,
      () => session,
    );

    const borrow = tryAcquireReadyRemoteSession(identity.hostId);
    expect(borrow).not.toBeNull();
    if (borrow === null) throw new Error("expected a borrow");

    expect("close" in borrow).toBe(false);
    expect("subscribe" in borrow).toBe(false);
    expect("subscribeWithParamsProvider" in borrow).toBe(false);
    expect("start" in borrow).toBe(false);

    owner.close();
  });
});

describe("hasBorrowableRemoteSession", () => {
  it("is false for a host with no cached session at all", () => {
    const { hostId } = freshIdentity();
    expect(hasBorrowableRemoteSession(hostId)).toBe(false);
  });

  it("is true only while held by a live non-poller owner with no linger armed, and flips false the instant the linger arms", () => {
    const identity = freshIdentity();
    const session = fakeSession();
    session.ready = true;
    const owner = acquireRemoteSession(
      identity,
      BORROW_TEST_POLICY,
      () => session,
    );

    expect(hasBorrowableRemoteSession(identity.hostId)).toBe(true);
    owner.close();
    // Divergence from `hasReadyRemoteSession`, which stays true through the
    // linger: a lingering entry is honest liveness EVIDENCE but is exactly
    // the zero-consumer entry a poller must not be allowed to adopt.
    expect(hasBorrowableRemoteSession(identity.hostId)).toBe(false);
  });

  it("a ready `terminal`-policy (one-shot) session is never borrowable, even fully held and ready; a `revalidate` one for the same host is", () => {
    // `findBorrowableEntry` requires `authRecovery === "revalidate"`. A ready
    // `"terminal"` one-shot runs with `auth: null`, so the first UNAUTHORIZED
    // goes terminal-fatal - closing that owner's stream subscriptions and
    // rejecting its pending calls - which a status poll must never trigger by
    // borrowing it.
    const base = freshIdentity();
    const terminalIdentity: RemoteSessionIdentity = {
      ...base,
      authRecovery: "terminal",
    };
    const terminalSession = fakeSession();
    terminalSession.ready = true;
    const terminalOwner = acquireRemoteSession(
      terminalIdentity,
      BORROW_TEST_POLICY,
      () => terminalSession,
    );

    expect(hasBorrowableRemoteSession(base.hostId)).toBe(false);
    expect(tryAcquireReadyRemoteSession(base.hostId)).toBeNull();

    // The positive control: a `"revalidate"` entry for the SAME hostId is
    // borrowable, so the refusal above is about the policy field, not about
    // the host having no eligible entry at all.
    const revalidateIdentity: RemoteSessionIdentity = {
      ...base,
      authRecovery: "revalidate",
    };
    const revalidateSession = fakeSession();
    revalidateSession.ready = true;
    const revalidateOwner = acquireRemoteSession(
      revalidateIdentity,
      BORROW_TEST_POLICY,
      () => revalidateSession,
    );

    expect(hasBorrowableRemoteSession(base.hostId)).toBe(true);
    const borrow = tryAcquireReadyRemoteSession(base.hostId);
    expect(borrow).not.toBeNull();
    borrow?.release();

    terminalOwner.close();
    revalidateOwner.close();
  });
});
