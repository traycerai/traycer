import { describe, expect, it, vi } from "vitest";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IRemoteSession } from "../remote-session";
import {
  acquireRemoteSession,
  hasReadyRemoteSession,
  remoteSessionRefCountForTest,
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
    start: vi.fn(),
    isClosed: () => closeCalls > 0,
    isReady: () => session.ready,
    sendUnary: vi.fn(async () => ({}) as never),
    subscribe: vi.fn(() => {
      throw new Error("not exercised by these tests");
    }),
    notifyBearerRotated: vi.fn(),
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
  };
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

  it("(a) tears the shared session down IMMEDIATELY on the last release", () => {
    const identity = freshIdentity();
    const session = fakeSession();
    const view = acquireRemoteSession(identity, () => session);

    expect(session.closeCalls).toBe(0);
    view.close();
    expect(session.closeCalls).toBe(1);
    expect(remoteSessionRefCountForTest(identity)).toBe(0);
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

    // Second release: last consumer gone, so the shared session tears down now.
    consumerB.close();
    expect(session.closeCalls).toBe(1);
    expect(remoteSessionRefCountForTest(identity)).toBe(0);
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
    expect(second.closeCalls).toBe(1);
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
    expect(sessionForUserA.closeCalls).toBe(1);
    expect(sessionForUserB.closeCalls).toBe(0);

    viewB.close();
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
    expect(sessionForKeyA.closeCalls).toBe(1);
    expect(sessionForKeyB.closeCalls).toBe(0);
    expect(remoteSessionRefCountForTest(identityKeyB)).toBe(1);

    viewB.close();
    expect(sessionForKeyB.closeCalls).toBe(1);
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

    // Both release: the original entry fully tears down and is deleted.
    viewA.close();
    viewB.close();
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
    expect(successor.closeCalls).toBe(1);
  });
});

describe("hasReadyRemoteSession", () => {
  it("is false once the last consumer releases (no lingering evidence for a torn-down session)", () => {
    const identity = freshIdentity();
    const session = fakeSession();
    session.ready = true;
    const view = acquireRemoteSession(identity, () => session);

    expect(hasReadyRemoteSession(identity.hostId)).toBe(true);
    view.close();
    expect(hasReadyRemoteSession(identity.hostId)).toBe(false);
  });

  it("is false for a host with no cached session", () => {
    const { hostId } = freshIdentity();
    expect(hasReadyRemoteSession(hostId)).toBe(false);
  });
});
