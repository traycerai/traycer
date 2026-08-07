import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import { REMOTE_SESSION_LINGER_MS } from "../config";
import type { IRemoteSession } from "../remote-session";
import {
  acquireRemoteSession,
  hasReadyRemoteSession,
  remoteSessionRefCountForTest,
  retireAllRemoteSessions,
  type RemoteSessionIdentity,
} from "../active-remote-sessions";

// `acquireRemoteSession` is the get-or-create ref-counted session cache (S1 /
// fix #4). These tests pin its lifecycle edges directly against a fake
// `IRemoteSession` - a real `RemoteSession` needs a live Noise/relay/grant
// stack, which is out of scope for a cache-lifecycle unit test; the cache
// itself only ever calls `isReady()`/`close()` on what `createSession`
// returns, so a fake exercising those is a faithful, isolated test double.
//
// The cache is a module-level singleton, so every test below uses its OWN
// unique identity - shared keys would let one test's state leak into
// another's regardless of cleanup order.

interface FakeSession extends IRemoteSession<
  VersionedRpcRegistry,
  VersionedStreamRpcRegistry
> {
  readonly closeCalls: number;
  ready: boolean;
  /**
   * Mirrors a session-level fatal: the real `RemoteSession` flips itself to
   * closed IN PLACE (no consumer called the view's `close()`), which is
   * exactly the state the cache must refuse to hand out on a later acquire.
   */
  closedUnderneath: boolean;
}

function fakeSession(): FakeSession {
  let closeCalls = 0;
  const session: FakeSession = {
    get closeCalls() {
      return closeCalls;
    },
    // Mirrors the real `RemoteSession`: not ready until it has actually
    // connected, so a fresh fake never masquerades as evidence of liveness.
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
    onClosed: () => () => undefined,
    subscribeAvailabilityRecovered: () => () => undefined,
    // These cache tests never exercise fatal verdicts; the cache view only
    // forwards this accessor.
    terminalFatal: () => null,
    close: () => {
      closeCalls += 1;
    },
  };
  return session;
}

let nextHostId = 0;
/** A fresh, fully-populated identity, so each test owns an isolated cache key. */
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

// The keep-warm linger defers the real teardown by `REMOTE_SESSION_LINGER_MS`
// after the last release, so every teardown assertion below advances fake
// time explicitly - "released" and "torn down" are now distinct states.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Advances past the keep-warm window so a zero-consumer entry tears down. */
function expireLinger(): void {
  vi.advanceTimersByTime(REMOTE_SESSION_LINGER_MS);
}

describe("acquireRemoteSession", () => {
  it("constructs a session on the first acquire and shares it on subsequent acquires for the same identity", () => {
    const identity = freshIdentity();
    const created: FakeSession[] = [];
    const createSession = () => {
      const session = fakeSession();
      created.push(session);
      return session;
    };

    const first = acquireRemoteSession(identity, createSession);
    const second = acquireRemoteSession(identity, createSession);

    // Only ONE underlying session was ever constructed for the two acquires.
    expect(created).toHaveLength(1);
    expect(remoteSessionRefCountForTest(identity)).toBe(2);

    // Both views delegate to the same shared session, not independent copies:
    // driving a state change through the first view is visible via the second.
    created[0].ready = true;
    expect(hasReadyRemoteSession(identity.hostId)).toBe(true);
    created[0].ready = false;
    expect(hasReadyRemoteSession(identity.hostId)).toBe(false);

    first.close();
    second.close();
  });

  it("(a) keeps the session warm for the linger window after the last release, then tears it down", () => {
    const identity = freshIdentity();
    const session = fakeSession();
    const view = acquireRemoteSession(identity, () => session);

    expect(session.closeCalls).toBe(0);
    view.close();
    // Released but NOT torn down: the session lingers, connected, for the
    // keep-warm window.
    expect(session.closeCalls).toBe(0);
    expect(remoteSessionRefCountForTest(identity)).toBe(0);

    vi.advanceTimersByTime(REMOTE_SESSION_LINGER_MS - 1);
    expect(session.closeCalls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(session.closeCalls).toBe(1);
  });

  it("a re-acquire within the linger window adopts the warm session and cancels the teardown", () => {
    const identity = freshIdentity();
    const session = fakeSession();
    const createSession = vi.fn(() => session);

    const first = acquireRemoteSession(identity, createSession);
    first.close();
    vi.advanceTimersByTime(REMOTE_SESSION_LINGER_MS - 1);

    // The whole point of the keep-warm: no fresh mint/dial/handshake - the
    // second acquire reuses the still-connected session.
    const second = acquireRemoteSession(identity, createSession);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(remoteSessionRefCountForTest(identity)).toBe(1);

    // The pending teardown was cancelled, not merely outpaced: even far past
    // the original window the adopted session stays open.
    vi.advanceTimersByTime(REMOTE_SESSION_LINGER_MS * 3);
    expect(session.closeCalls).toBe(0);

    // Releasing again starts a FRESH window.
    second.close();
    expect(session.closeCalls).toBe(0);
    expireLinger();
    expect(session.closeCalls).toBe(1);
  });

  it("a mid-establishment release (acquire, release before ready, prompt re-acquire) never tears the dial down", () => {
    // The measured panel-open churn shape: the messenger's single binding
    // slot released the session while its first dial was still in flight,
    // then re-acquired moments later - producing a observed double
    // mint/attach. With the linger the in-flight session survives the gap.
    const identity = freshIdentity();
    const session = fakeSession();
    const createSession = vi.fn(() => session);

    const during = acquireRemoteSession(identity, createSession);
    // Still not ready - establishment in flight.
    expect(session.ready).toBe(false);
    during.close();
    expect(session.closeCalls).toBe(0);

    vi.advanceTimersByTime(1_000);
    const reacquired = acquireRemoteSession(identity, createSession);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(session.closeCalls).toBe(0);
    reacquired.close();
  });

  it("(c) two concurrent acquires for the same identity share one session and only the SECOND release tears it down", () => {
    const identity = freshIdentity();
    const session = fakeSession();
    const createSession = vi.fn(() => session);

    const consumerA = acquireRemoteSession(identity, createSession);
    const consumerB = acquireRemoteSession(identity, createSession);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(remoteSessionRefCountForTest(identity)).toBe(2);

    // First release: one consumer remains, so the shared session survives.
    consumerA.close();
    expect(session.closeCalls).toBe(0);
    expect(remoteSessionRefCountForTest(identity)).toBe(1);

    // Second release: last consumer gone - teardown after the linger window.
    consumerB.close();
    expect(remoteSessionRefCountForTest(identity)).toBe(0);
    expireLinger();
    expect(session.closeCalls).toBe(1);
  });

  it("a view's close() is idempotent - releasing twice never double-decrements or double-closes", () => {
    const identity = freshIdentity();
    const session = fakeSession();
    const other = acquireRemoteSession(identity, () => session);
    const view = acquireRemoteSession(identity, () => session);

    view.close();
    view.close();
    expect(session.closeCalls).toBe(0);
    expect(remoteSessionRefCountForTest(identity)).toBe(1);

    other.close();
    expireLinger();
    expect(session.closeCalls).toBe(1);
  });

  it("(b) re-acquiring after teardown constructs a FRESH session, never a resurrected one", () => {
    const identity = freshIdentity();
    const first = fakeSession();
    const second = fakeSession();
    const createSession = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);

    const view1 = acquireRemoteSession(identity, createSession);
    view1.close();
    expireLinger();
    expect(first.closeCalls).toBe(1);

    const view2 = acquireRemoteSession(identity, createSession);
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(remoteSessionRefCountForTest(identity)).toBe(1);

    // The new view is backed by the FRESH session, not the torn-down one: a
    // readiness flip on the dead `first` session must not leak through.
    first.ready = true;
    expect(hasReadyRemoteSession(identity.hostId)).toBe(false);
    second.ready = true;
    expect(hasReadyRemoteSession(identity.hostId)).toBe(true);

    view2.close();
    expireLinger();
    expect(second.closeCalls).toBe(1);
  });

  it("evicts a session that terminally closed underneath (session-level fatal) and hands the next acquire a FRESH live session", () => {
    const identity = freshIdentity();
    const dead = fakeSession();
    const fresh = fakeSession();
    const createSession = vi
      .fn()
      .mockReturnValueOnce(dead)
      .mockReturnValueOnce(fresh);

    // A consumer still HOLDS a reference when the session goes terminal - the
    // bricked-session incident shape: the messenger pins the entry in the
    // cache while the provider's rebuild re-acquires the same key.
    const pinningView = acquireRemoteSession(identity, createSession);
    dead.closedUnderneath = true;
    expect(pinningView.isClosed()).toBe(true);

    // The re-acquire must NOT serve the dead entry: a closed session's
    // `start()` no-ops, so it could never carry traffic again.
    const rebuiltView = acquireRemoteSession(identity, createSession);
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(rebuiltView.isClosed()).toBe(false);
    expect(remoteSessionRefCountForTest(identity)).toBe(1);

    // The pinning consumer's late release targets the EVICTED entry - it
    // must never decrement (or tear down) the live successor.
    pinningView.close();
    expect(remoteSessionRefCountForTest(identity)).toBe(1);
    expect(fresh.closeCalls).toBe(0);

    rebuiltView.close();
    expireLinger();
    expect(fresh.closeCalls).toBe(1);
  });

  it("a session that goes fatal WHILE lingering is evicted on the next acquire, and the stale linger timer never touches the successor", () => {
    const identity = freshIdentity();
    const dead = fakeSession();
    const fresh = fakeSession();
    const createSession = vi
      .fn()
      .mockReturnValueOnce(dead)
      .mockReturnValueOnce(fresh);

    const view = acquireRemoteSession(identity, createSession);
    view.close();
    // Mid-linger, the warm session hits a session-level fatal underneath.
    vi.advanceTimersByTime(1_000);
    dead.closedUnderneath = true;

    // The next acquire must not adopt the corpse - fresh session instead.
    const rebuilt = acquireRemoteSession(identity, createSession);
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(rebuilt.isClosed()).toBe(false);
    expect(remoteSessionRefCountForTest(identity)).toBe(1);

    // Even once the ORIGINAL linger deadline passes, the successor entry is
    // untouched: the eviction cancelled/orphaned the old timer.
    expireLinger();
    expect(fresh.closeCalls).toBe(0);
    expect(remoteSessionRefCountForTest(identity)).toBe(1);

    rebuilt.close();
    expireLinger();
    expect(fresh.closeCalls).toBe(1);
  });

  it("keys are scoped per-user - a different user on the same host gets an independent session", () => {
    const base = freshIdentity();
    const identityA = base;
    const identityB: RemoteSessionIdentity = {
      ...base,
      userId: `${base.userId}-other`,
    };
    const sessionForUserA = fakeSession();
    const sessionForUserB = fakeSession();
    const createSession = vi
      .fn()
      .mockReturnValueOnce(sessionForUserA)
      .mockReturnValueOnce(sessionForUserB);

    const viewA = acquireRemoteSession(identityA, createSession);
    const viewB = acquireRemoteSession(identityB, createSession);

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(remoteSessionRefCountForTest(identityA)).toBe(1);
    expect(remoteSessionRefCountForTest(identityB)).toBe(1);

    viewA.close();
    expireLinger();
    expect(sessionForUserA.closeCalls).toBe(1);
    expect(sessionForUserB.closeCalls).toBe(0);

    viewB.close();
    expireLinger();
    expect(sessionForUserB.closeCalls).toBe(1);
  });

  it("(review finding #2) a host public-key rotation is a cache miss - a NEW session, independent lifecycle from the old (stale) key's session", () => {
    const base = freshIdentity();
    // Same hostId/userId/relayAttachUrl - only the host's static Noise key
    // rotates (e.g. corruption recovery / re-enrollment, Architecture §4
    // finding #2), mirroring exactly what the render layer already treats as
    // an identity change (`hostTransportKey`/`remoteTransportKey`).
    const identityKeyA: RemoteSessionIdentity = {
      ...base,
      hostPublicKey: "pubkey-a",
    };
    const identityKeyB: RemoteSessionIdentity = {
      ...base,
      hostPublicKey: "pubkey-b",
    };
    const sessionForKeyA = fakeSession();
    const sessionForKeyB = fakeSession();
    const createSession = vi
      .fn()
      .mockReturnValueOnce(sessionForKeyA)
      .mockReturnValueOnce(sessionForKeyB);

    const viewA = acquireRemoteSession(identityKeyA, createSession);
    expect(remoteSessionRefCountForTest(identityKeyA)).toBe(1);

    // The render layer rebuilds its transport for the NEW key - a genuinely
    // fresh acquire, not a hit reusing the stale (pinned-to-the-old-key)
    // session.
    const viewB = acquireRemoteSession(identityKeyB, createSession);
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(remoteSessionRefCountForTest(identityKeyB)).toBe(1);
    // The OLD key's entry is untouched by the new key's acquire - both
    // sessions coexist independently until each is released.
    expect(remoteSessionRefCountForTest(identityKeyA)).toBe(1);
    expect(sessionForKeyA.closeCalls).toBe(0);

    // Releasing the stale key's consumer tears down ONLY that session -
    // independent of the new key's live session.
    viewA.close();
    expireLinger();
    expect(sessionForKeyA.closeCalls).toBe(1);
    expect(sessionForKeyB.closeCalls).toBe(0);
    expect(remoteSessionRefCountForTest(identityKeyB)).toBe(1);

    viewB.close();
    expireLinger();
    expect(sessionForKeyB.closeCalls).toBe(1);
  });

  it("refuses to ADOPT a superseded-but-held entry: a re-acquire of that key displaces it and builds fresh, and the displaced holder's release closes the old session outright", () => {
    const base = freshIdentity();
    const identityKeyA: RemoteSessionIdentity = {
      ...base,
      hostPublicKey: "pubkey-a",
    };
    const identityKeyB: RemoteSessionIdentity = {
      ...base,
      hostPublicKey: "pubkey-b",
    };
    const oldSession = fakeSession();
    const newKeySession = fakeSession();
    const freshSession = fakeSession();
    const createSession = vi
      .fn()
      .mockReturnValueOnce(oldSession)
      .mockReturnValueOnce(newKeySession)
      .mockReturnValueOnce(freshSession);

    // Key A is HELD when key B's acquire supersedes it: the sweep can only
    // mark it (a session is never torn out from under a live consumer).
    const heldOldView = acquireRemoteSession(identityKeyA, createSession);
    const viewB = acquireRemoteSession(identityKeyB, createSession);

    // A second consumer still carrying identity A re-acquires. Adopting the
    // marked entry would extend its refCount - deferring the sticky verdict's
    // "closes at its first free moment" indefinitely and carrying new work on
    // the retired connection - so the acquire must displace it and build a
    // fresh session instead.
    const reacquiredView = acquireRemoteSession(identityKeyA, createSession);
    expect(createSession).toHaveBeenCalledTimes(3);
    expect(oldSession.closeCalls).toBe(0);

    // The displaced entry is no longer in the map, so its holder's release
    // cannot linger it (nothing could ever adopt it again) and must not touch
    // the successor's refCount: it closes the old session on the spot.
    heldOldView.close();
    expect(oldSession.closeCalls).toBe(1);
    expect(freshSession.closeCalls).toBe(0);
    expect(remoteSessionRefCountForTest(identityKeyA)).toBe(1);

    reacquiredView.close();
    viewB.close();
    expireLinger();
    expect(freshSession.closeCalls).toBe(1);
    expect(newKeySession.closeCalls).toBe(1);
  });

  it("(review finding #3) release() targets the entry captured at acquire time, not a key-string relookup - a stale release after a full teardown+re-acquire cycle never corrupts the successor's refCount", () => {
    const identity = freshIdentity();
    const original = fakeSession();
    const successor = fakeSession();
    const createSession = vi
      .fn()
      .mockReturnValueOnce(original)
      .mockReturnValueOnce(successor);

    // Two views share the original entry.
    const viewA = acquireRemoteSession(identity, createSession);
    const viewB = acquireRemoteSession(identity, createSession);
    expect(remoteSessionRefCountForTest(identity)).toBe(2);

    // Both release, and the linger window expires: the original entry fully
    // tears down and is deleted.
    viewA.close();
    viewB.close();
    expireLinger();
    expect(original.closeCalls).toBe(1);

    // A fresh acquire for the IDENTICAL identity creates a brand-new
    // successor entry - same key string, different entry object.
    const viewC = acquireRemoteSession(identity, createSession);
    expect(remoteSessionRefCountForTest(identity)).toBe(1);

    // A stale release reaching back for the already-released, already-torn-
    // down original views must never touch the successor's refCount. If
    // `release()` ever regressed to re-resolving the entry by key STRING
    // instead of the entry captured at acquire time, this would incorrectly
    // decrement (and could prematurely tear down) the live successor.
    viewA.close();
    viewB.close();
    expect(remoteSessionRefCountForTest(identity)).toBe(1);
    expect(successor.closeCalls).toBe(0);

    viewC.close();
    expireLinger();
    expect(successor.closeCalls).toBe(1);
  });
});

describe("hasReadyRemoteSession", () => {
  it("stays true through the keep-warm linger (the session IS still live) and goes false once the window expires", () => {
    const identity = freshIdentity();
    const session = fakeSession();
    session.ready = true;
    const view = acquireRemoteSession(identity, () => session);

    expect(hasReadyRemoteSession(identity.hostId)).toBe(true);
    view.close();
    // Lingering, still connected: honest liveness evidence.
    expect(hasReadyRemoteSession(identity.hostId)).toBe(true);
    expireLinger();
    // Torn down for real: no lingering evidence for a closed session.
    expect(hasReadyRemoteSession(identity.hostId)).toBe(false);
  });

  it("is false for a host with no cached session", () => {
    const { hostId } = freshIdentity();
    expect(hasReadyRemoteSession(hostId)).toBe(false);
  });

  it("does not answer for a host off a SUPERSEDED identity's lingering session", () => {
    // A host re-keys. The old identity is unadoptable from here on, but its
    // entry is matched by hostId alone - so left lingering it would report the
    // rotated host as live while its real session is still dialing, which is
    // enough to render it Online and pass its scope gate.
    const identity = freshIdentity();
    const stale = fakeSession();
    stale.ready = true;
    const view = acquireRemoteSession(identity, () => stale);
    view.close();
    expect(hasReadyRemoteSession(identity.hostId)).toBe(true);

    const rotated = { ...identity, hostPublicKey: "pubkey-rotated" };
    const dialing = fakeSession();
    dialing.ready = false;
    acquireRemoteSession(rotated, () => dialing);

    expect(stale.closeCalls).toBe(1);
    expect(hasReadyRemoteSession(identity.hostId)).toBe(false);
  });

  it("does not answer off an identity superseded while a consumer STILL HELD it", () => {
    // The rotation the sweep cannot act on: the old identity has a live
    // consumer at the moment the new one is acquired, so it is skipped. That
    // skip is the whole point of this test - supersession is only ever
    // detected on the NEWER identity's cache miss, which has already happened
    // by the time the straggler releases, so nothing sweeps a second time.
    // Left unmarked, the release lingers an obsolete READY session for the
    // full window and keeps answering for the host.
    const identity = freshIdentity();
    const stale = fakeSession();
    stale.ready = true;
    const straggler = acquireRemoteSession(identity, () => stale);

    const rotated = { ...identity, hostPublicKey: "pubkey-rotated" };
    const dialing = fakeSession();
    dialing.ready = false;
    acquireRemoteSession(rotated, () => dialing);

    // Still held, so the sweep left the session alone - correct, tearing a
    // live session out from under a consumer is not the sweep's call.
    expect(stale.closeCalls).toBe(0);
    // ...but it must already have stopped counting as evidence for the host:
    // it is pinned to a public key the host has moved off, and the CURRENT
    // identity is still dialing.
    expect(hasReadyRemoteSession(identity.hostId)).toBe(false);

    straggler.close();

    // Closed AT the release, not lingered - keep-warm exists so a prompt
    // re-acquire is free, and this key can never be re-acquired.
    expect(stale.closeCalls).toBe(1);
    expect(hasReadyRemoteSession(identity.hostId)).toBe(false);

    // Nothing left armed to fire into the successor's lifetime, and the
    // successor coming ready answers for the host on its own merits.
    dialing.ready = true;
    vi.advanceTimersByTime(REMOTE_SESSION_LINGER_MS * 2);
    expect(stale.closeCalls).toBe(1);
    expect(dialing.closeCalls).toBe(0);
    expect(hasReadyRemoteSession(identity.hostId)).toBe(true);
  });

  it("keeps counting a HELD session that nothing has superseded", () => {
    // The negative control for the test above: `superseded` must be set by an
    // actual rotation, not by merely being held - otherwise the mark would
    // silently blind the common case, where one consumer holds the host's
    // current session and Settings should report it Online.
    const identity = freshIdentity();
    const current = fakeSession();
    current.ready = true;
    const view = acquireRemoteSession(identity, () => current);

    // A second consumer for the SAME identity is a cache hit, not a rotation.
    const second = acquireRemoteSession(identity, () => {
      throw new Error("must not construct a second session for one identity");
    });

    expect(hasReadyRemoteSession(identity.hostId)).toBe(true);
    view.close();
    second.close();
    expect(current.closeCalls).toBe(0);
    expect(hasReadyRemoteSession(identity.hostId)).toBe(true);
  });
});

describe("auth-recovery policy is part of the session identity", () => {
  it("never hands a terminal-recovery consumer a session built to revalidate", () => {
    // `openOneShotStreamTransport` passes `auth: null` on purpose: every
    // reconnect re-sends live subscriptions, and re-sending a
    // `worktree.deleteByPath` subscribe re-runs the teardown script and git
    // removal. On a cache hit the factory never runs, so without this the
    // one-shot would silently adopt the durable session's revalidator and
    // regain exactly the replay it opted out of.
    const durable = freshIdentity();
    const durableSession = fakeSession();
    const view = acquireRemoteSession(durable, () => durableSession);
    view.close(); // released, now lingering warm

    const oneShot: RemoteSessionIdentity = {
      ...durable,
      authRecovery: "terminal",
    };
    let builtOwnSession = false;
    const oneShotSession = fakeSession();
    acquireRemoteSession(oneShot, () => {
      builtOwnSession = true;
      return oneShotSession;
    });

    expect(builtOwnSession).toBe(true);
    expect(remoteSessionRefCountForTest(durable)).toBe(0);
    expect(remoteSessionRefCountForTest(oneShot)).toBe(1);
  });

  it("never hands a revalidating consumer a session built to fail terminal", () => {
    // The inverse ordering: a durable stream adopting the one-shot's session
    // would silently lose auth recovery, so a wake-time expired bearer would
    // brick it instead of redialing.
    const oneShot: RemoteSessionIdentity = {
      ...freshIdentity(),
      authRecovery: "terminal",
    };
    const oneShotSession = fakeSession();
    const view = acquireRemoteSession(oneShot, () => oneShotSession);
    view.close();

    const durable: RemoteSessionIdentity = {
      ...oneShot,
      authRecovery: "revalidate",
    };
    let builtOwnSession = false;
    const durableSession = fakeSession();
    acquireRemoteSession(durable, () => {
      builtOwnSession = true;
      return durableSession;
    });

    expect(builtOwnSession).toBe(true);
    expect(remoteSessionRefCountForTest(durable)).toBe(1);
  });

  it("keeps the two policies' sessions independent rather than superseding each other", () => {
    // They differ only in policy, not in host identity, so neither is stale:
    // a backgrounded delete must not tear down the warm durable session, and
    // acquiring the durable one must not kill the running delete.
    const durable = freshIdentity();
    const oneShot: RemoteSessionIdentity = {
      ...durable,
      authRecovery: "terminal",
    };
    const durableSession = fakeSession();
    const oneShotSession = fakeSession();

    const durableView = acquireRemoteSession(durable, () => durableSession);
    durableView.close();
    acquireRemoteSession(oneShot, () => oneShotSession);

    expect(durableSession.closeCalls).toBe(0);
    expect(remoteSessionRefCountForTest(oneShot)).toBe(1);
  });

  it("supersedes a rotated identity ACROSS the policy split, not just within it", () => {
    // The distinction the test above is one half of. Differing in policy alone
    // means "legitimately independent"; differing in PHYSICAL identity means
    // "superseded" whatever the policy, because `hasReadyRemoteSession` matches
    // on hostId across all policies. A ready one-shot session lingering under
    // the old public key is exactly as stale as a durable one would be, and
    // left alone it reports the host Online while the rotated identity dials.
    const oneShot = { ...freshIdentity(), authRecovery: "terminal" as const };
    const staleOneShot = fakeSession();
    staleOneShot.ready = true;
    acquireRemoteSession(oneShot, () => staleOneShot).close();
    expect(hasReadyRemoteSession(oneShot.hostId)).toBe(true);

    // The host re-keys, and it is the DURABLE transport that rebuilds first -
    // a different policy from the lingering entry's.
    const rotatedDurable: RemoteSessionIdentity = {
      ...oneShot,
      hostPublicKey: "pubkey-rotated",
      authRecovery: "revalidate",
    };
    const dialing = fakeSession();
    dialing.ready = false;
    acquireRemoteSession(rotatedDurable, () => dialing);

    expect(staleOneShot.closeCalls).toBe(1);
    expect(hasReadyRemoteSession(oneShot.hostId)).toBe(false);
  });

  it("supersedes a rotated RELAY URL across the policy split too", () => {
    // The other physical-identity field, so the rule is pinned as
    // "public key OR relay URL", not just the one the rotation test happens to
    // move.
    const durable = freshIdentity();
    const staleDurable = fakeSession();
    staleDurable.ready = true;
    acquireRemoteSession(durable, () => staleDurable).close();

    const movedOneShot: RemoteSessionIdentity = {
      ...durable,
      relayAttachUrl: "wss://relay-moved.invalid/attach",
      authRecovery: "terminal",
    };
    acquireRemoteSession(movedOneShot, () => fakeSession());

    expect(staleDurable.closeCalls).toBe(1);
    expect(hasReadyRemoteSession(durable.hostId)).toBe(false);
  });

  it("never warm-adopts a lingering session across an AUTH-CONTEXT change", () => {
    // Sign out and back into the same account inside the linger window. Every
    // other identity field is identical - same user, same host, same key, same
    // relay - so without `authEpoch` this is a warm hit, and the adopted
    // session keeps minting through the PREVIOUS context's released credential
    // lease: it can look alive until its next drop and then never re-attach.
    let builds = 0;
    const firstContext = freshIdentity();
    const firstSession = fakeSession();
    acquireRemoteSession(firstContext, () => {
      builds += 1;
      return firstSession;
    }).close();
    expect(builds).toBe(1);

    // Still lingering (not yet torn down) - so a same-epoch re-acquire here
    // WOULD adopt it. That is what makes the assertion below about the epoch
    // and not merely about timing.
    expect(firstSession.closeCalls).toBe(0);

    const secondContext: RemoteSessionIdentity = {
      ...firstContext,
      authEpoch: "lease-2",
    };
    acquireRemoteSession(secondContext, () => {
      builds += 1;
      return fakeSession();
    });

    // Ran its OWN factory rather than inheriting the dead context's closures.
    expect(builds).toBe(2);
  });

  it("supersedes a RETIRED auth epoch instead of leaving it to report Online", () => {
    // Partitioning alone is not enough. The retired entry is the same physical
    // identity - same key, same relay - so the "differs only in authRecovery"
    // branch would wave it through as a parallel current entry, and
    // `hasReadyRemoteSession` matches on hostId alone. That reproduces through
    // the auth dimension exactly what supersession fixes for a rotated key: the
    // signed-out session reports the host Online, and passes its scope gate,
    // while the live context is still dialing.
    const retired = freshIdentity();
    const staleSession = fakeSession();
    staleSession.ready = true;
    acquireRemoteSession(retired, () => staleSession).close();
    expect(hasReadyRemoteSession(retired.hostId)).toBe(true);

    const signedInAgain: RemoteSessionIdentity = {
      ...retired,
      authEpoch: "lease-2",
    };
    const dialing = fakeSession();
    dialing.ready = false;
    acquireRemoteSession(signedInAgain, () => dialing);

    expect(staleSession.closeCalls).toBe(1);
    expect(hasReadyRemoteSession(retired.hostId)).toBe(false);
  });

  it("retireAllRemoteSessions retires free AND held entries at the auth boundary", () => {
    // Supersession is otherwise detected only at acquire time, and a read-only
    // surface never acquires - so on sign-out, without this sweep, a retired
    // user's still-attached session would keep answering
    // `hasReadyRemoteSession` for the whole linger window.
    const lingering = freshIdentity();
    const lingeringSession = fakeSession();
    lingeringSession.ready = true;
    acquireRemoteSession(lingering, () => lingeringSession).close();

    const held = freshIdentity();
    const heldSession = fakeSession();
    heldSession.ready = true;
    const heldView = acquireRemoteSession(held, () => heldSession);

    expect(hasReadyRemoteSession(lingering.hostId)).toBe(true);
    expect(hasReadyRemoteSession(held.hostId)).toBe(true);

    retireAllRemoteSessions();

    // The free entry closes outright; the held one stops answering
    // IMMEDIATELY and closes the moment its last consumer lets go.
    expect(lingeringSession.closeCalls).toBe(1);
    expect(hasReadyRemoteSession(lingering.hostId)).toBe(false);
    expect(heldSession.closeCalls).toBe(0);
    expect(hasReadyRemoteSession(held.hostId)).toBe(false);

    heldView.close();
    expect(heldSession.closeCalls).toBe(1);
  });

  it("drops a session that closed underneath at release instead of lingering the corpse", () => {
    // A session-level fatal closes the shared session in place while a
    // consumer still holds the view. Arming a keep-warm linger on the corpse
    // at release would occupy the key for the window with an entry no acquire
    // can ever adopt - release must treat it like a superseded entry and drop
    // it on the spot.
    const identity = freshIdentity();
    const session = fakeSession();
    const view = acquireRemoteSession(identity, () => session);

    session.closedUnderneath = true;
    view.close();

    // Closed at release, not parked behind a linger timer.
    expect(session.closeCalls).toBe(1);
  });

  it("supersedes the previous USER's session for the same host", () => {
    // The user dimension of the same retirement. This process has one
    // signed-in user at a time, so an entry under another userId is always a
    // sign-in that has since ended - and `hasReadyRemoteSession` matches on
    // hostId across users, so left current it would report the host Online
    // off the signed-out user's connection while the new user is still
    // dialing. Both identities deliberately hold the SAME epoch label, same
    // key, same relay: every equality in the parallel-entry guard holds
    // except the user, so this passes only if the user mismatch alone
    // retires the entry - the verdict must not ride on the epoch label.
    const previousUser: RemoteSessionIdentity = {
      ...freshIdentity(),
      authEpoch: "lease-shared",
    };
    const staleSession = fakeSession();
    staleSession.ready = true;
    acquireRemoteSession(previousUser, () => staleSession).close();
    expect(hasReadyRemoteSession(previousUser.hostId)).toBe(true);

    const nextUser: RemoteSessionIdentity = {
      ...previousUser,
      userId: "user-2",
    };
    const dialing = fakeSession();
    dialing.ready = false;
    acquireRemoteSession(nextUser, () => dialing);

    expect(staleSession.closeCalls).toBe(1);
    expect(hasReadyRemoteSession(previousUser.hostId)).toBe(false);
  });

  it("keeps the one-shot/durable split parallel WITHIN one auth epoch", () => {
    // The counterpart, so the epoch check reads as a narrowing rather than a
    // blanket "any key difference supersedes": two entries that differ only in
    // `authRecovery` under the SAME context are both current and neither may
    // close the other.
    const durable = freshIdentity();
    const durableSession = fakeSession();
    durableSession.ready = true;
    acquireRemoteSession(durable, () => durableSession).close();

    const oneShot: RemoteSessionIdentity = {
      ...durable,
      authRecovery: "terminal",
    };
    acquireRemoteSession(oneShot, () => fakeSession());

    expect(durableSession.closeCalls).toBe(0);
    expect(hasReadyRemoteSession(durable.hostId)).toBe(true);
  });

  it("still shares one connection across a token refresh within a context", () => {
    // The other half of the rule, and the reason the epoch is keyed on the
    // bearer SOURCE rather than the token: a same-user refresh rotates the
    // lease in place and emits no new context, so the epoch is unchanged and
    // the connection must keep being shared. Keying on the token would make
    // every refresh silently re-dial.
    let builds = 0;
    const identity = freshIdentity();
    const shared = fakeSession();
    const first = acquireRemoteSession(identity, () => {
      builds += 1;
      return shared;
    });
    const second = acquireRemoteSession(identity, () => {
      builds += 1;
      return fakeSession();
    });

    expect(builds).toBe(1);
    first.close();
    second.close();
  });
});
