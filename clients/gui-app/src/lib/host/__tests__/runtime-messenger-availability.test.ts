/**
 * `RuntimeHostMessenger`'s ready-boundary forwarding for a PICKER-selected
 * remote host - the one host scope nothing else holds a session for (the
 * active host is wired by `stream-runtime`, tab-bound hosts by the durable
 * per-tab transport).
 *
 * What these pin down is the interaction with the session cache's keep-warm
 * linger. This messenger holds ONE remote binding and ANY request for another
 * host replaces it - an interleaved background request against the active
 * local host is enough. Releasing a session no longer closes it, so a session
 * that was still dialing when the slot flipped goes on to reach its first
 * ready boundary; if the binding took its availability listener down on the
 * way out, that boundary reaches nobody and the queries that already errored
 * against it sit on an error card until their own retry backoff fires. So the
 * subscription has to outlive the binding.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { IRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { buildRuntimeHostMessenger } from "../host-messenger";

// Only the network boundary is replaced. Every other export of this barrel
// stays REAL, matching `stream-runtime.test.tsx`.
const mocks = vi.hoisted(() => ({
  createRemoteHostTransport: vi.fn(),
}));

vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    return {
      ...actual,
      createRemoteHostTransport: mocks.createRemoteHostTransport,
    };
  },
);

interface ControllableSession extends IRemoteSession<
  HostRpcRegistry,
  HostStreamRpcRegistry
> {
  /** How many availability listeners are attached RIGHT NOW - the whole point. */
  readonly availabilityListenerCount: number;
  readonly closeCalls: number;
  /**
   * Settable, because "already ready when the binding subscribes" is a state
   * the cache produces routinely (a warm keep-warm hit) and one in which NO
   * boundary will ever be emitted - `subscribeAvailabilityRecovered` reports a
   * recovery, not the current state.
   */
  ready: boolean;
  emitReady(): void;
  emitClosed(): void;
}

function controllableSession(): ControllableSession {
  const availability = new Set<() => void>();
  const closed = new Set<() => void>();
  let closeCalls = 0;
  let terminallyClosed = false;
  const session: ControllableSession = {
    ready: false,
    get availabilityListenerCount() {
      return availability.size;
    },
    get closeCalls() {
      return closeCalls;
    },
    emitReady: () => {
      // Mirror production ordering: the phase flips to ready BEFORE the
      // boundary listeners run, so a listener that re-reads `isReady()` sees
      // the state its notification describes.
      session.ready = true;
      for (const listener of [...availability]) {
        listener();
      }
    },
    emitClosed: () => {
      terminallyClosed = true;
      session.ready = false;
      for (const listener of [...closed]) {
        listener();
      }
      // Deliberately does NOT clear the listener sets, though a real session
      // does: `availabilityListenerCount` assertions must keep measuring
      // whether the code under test detached, not whether the fake swept.
    },
    start: vi.fn(),
    // False while merely RELEASED - a released session lingers, which is
    // exactly the state this file is about - but true once `emitClosed` has
    // fired, matching a real session that is already closed when it notifies
    // its closed-listeners. NOT flipped by `close()`, which plays the cache
    // view's release, not a terminal close.
    isClosed: () => terminallyClosed,
    isReady: () => session.ready,
    sendUnary: vi.fn(() => Promise.resolve({}) as never),
    subscribe: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    subscribeWithParamsProvider: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    notifyBearerRotated: vi.fn(),
    onClosed: (listener) => {
      // Production refuses new listeners once closed and hands back a noop
      // unsubscribe; a fake that kept accepting them could mint a
      // wrong-reason pass for lifecycle tests.
      if (terminallyClosed) {
        return () => undefined;
      }
      closed.add(listener);
      return () => closed.delete(listener);
    },
    subscribeAvailabilityRecovered: (listener) => {
      if (terminallyClosed) {
        return () => undefined;
      }
      availability.add(listener);
      return () => availability.delete(listener);
    },
    close: () => {
      closeCalls += 1;
    },
  };
  return session;
}

const REMOTE_HOST_ID = "remote-host-b";
const LOCAL_HOST_ID = "local-host-a";

const remoteEntry: RemoteHostDirectoryEntry = {
  hostId: REMOTE_HOST_ID,
  label: "Remote B",
  kind: "remote",
  websocketUrl: "wss://relay.invalid/attach",
  version: "1.2.3",
  status: "available",
  remoteStatus: {
    presenceLease: "fresh",
    hostRelayAttached: true,
    viewerReachability: "ok",
    clientCloud: "ok",
    busy: false,
    busySessionCount: 0,
    updateState: "current",
    appVersion: null,
    lastSeenAt: null,
  },
  publicKey: "pubkey-b",
};

const localEntry: HostDirectoryEntry = {
  hostId: LOCAL_HOST_ID,
  label: "This machine",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:1/",
  version: "1.2.3",
  status: "available",
};

const bearer = {
  getBearerToken: () => "bearer-token",
  identity: { userId: "user-1" },
};

function authorityFor(hostId: string, websocketUrl: string) {
  return {
    endpoint: { hostId, websocketUrl },
    bearer,
    abortSignal: new AbortController().signal,
  };
}

function harness(): {
  session: ControllableSession;
  recovered: string[];
  requestRemote: () => void;
  requestRemoteRaw: () => Promise<unknown>;
  requestRemoteWithSignal: (abortSignal: AbortSignal) => Promise<unknown>;
  requestLocal: () => void;
  reset: () => void;
  dispose: () => void;
} {
  const session = controllableSession();
  mocks.createRemoteHostTransport.mockImplementation(() => ({
    session,
    messenger: {
      request: () => Promise.resolve({}),
      requestWithResponseTimeout: () => Promise.resolve({}),
    },
    streamClient: {},
  }));
  const recovered: string[] = [];
  const binding = buildRuntimeHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    resolveTarget: (hostId) =>
      hostId === REMOTE_HOST_ID ? remoteEntry : localEntry,
    auth: null,
    authnBaseUrl: "https://authn.invalid",
    requestId: () => "req-1",
    onRemoteAvailabilityRecovered: (hostId) => {
      recovered.push(hostId);
    },
  });
  return {
    session,
    recovered,
    requestRemote: () => {
      void binding.messenger
        .request(
          "host.status",
          {},
          authorityFor(REMOTE_HOST_ID, remoteEntry.websocketUrl ?? ""),
        )
        .catch(() => undefined);
    },
    requestRemoteRaw: () =>
      binding.messenger.request(
        "host.status",
        {},
        authorityFor(REMOTE_HOST_ID, remoteEntry.websocketUrl ?? ""),
      ),
    requestRemoteWithSignal: (abortSignal: AbortSignal) =>
      binding.messenger.request(
        "host.status",
        {},
        {
          ...authorityFor(REMOTE_HOST_ID, remoteEntry.websocketUrl ?? ""),
          abortSignal,
        },
      ),
    reset: () => binding.reset(),
    // The local branch dials for real; the dial itself is irrelevant here -
    // what matters is that taking this branch evicts the remote binding first.
    requestLocal: () => {
      void binding.messenger
        .request(
          "host.status",
          {},
          authorityFor(LOCAL_HOST_ID, "ws://127.0.0.1:1/"),
        )
        .catch(() => undefined);
    },
    dispose: () => binding.dispose(),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("RuntimeHostMessenger availability forwarding", () => {
  it("still delivers the ready boundary after an interleaved local request replaced the binding", () => {
    const h = harness();
    h.requestRemote();
    expect(h.session.availabilityListenerCount).toBe(1);

    // The interleaving the fix is about: a background request for the active
    // local host flips the single binding slot while the remote session is
    // still dialing. The session is RELEASED, not closed - it keeps dialing.
    h.requestLocal();
    expect(h.session.closeCalls).toBe(1);
    expect(h.session.availabilityListenerCount).toBe(1);

    // ...and when it finally gets ready, the queries that errored against it
    // still hear about it.
    h.session.emitReady();
    expect(h.recovered).toEqual([REMOTE_HOST_ID]);

    h.dispose();
  });

  it("drops an orphaned subscription after it has fired once", () => {
    const h = harness();
    h.requestRemote();
    h.requestLocal();

    h.session.emitReady();
    h.session.emitReady();
    h.session.emitReady();
    // One delivery, then the listener removes itself: a host picker churning
    // between hosts must not pile subscriptions onto a shared warm session.
    expect(h.recovered).toEqual([REMOTE_HOST_ID]);
    expect(h.session.availabilityListenerCount).toBe(0);

    h.dispose();
  });

  it("keeps forwarding EVERY boundary while the binding is still current", () => {
    const h = harness();
    h.requestRemote();

    // A live binding is not one-shot - a reconnect after a drop is the ordinary
    // recovery case and has to keep re-arming host-scoped queries.
    h.session.emitReady();
    h.session.emitReady();
    expect(h.recovered).toEqual([REMOTE_HOST_ID, REMOTE_HOST_ID]);
    expect(h.session.availabilityListenerCount).toBe(1);

    h.dispose();
  });

  it("detaches on release once a boundary has already been delivered", () => {
    const h = harness();
    h.requestRemote();

    // The binding saw its ready boundary while still current, so the queries
    // it would un-strand were re-armed then and it is owed nothing further.
    h.session.emitReady();
    expect(h.recovered).toEqual([REMOTE_HOST_ID]);

    h.requestLocal();
    // Keeping it attached here is what accumulates listeners: a picker toggled
    // N times would leave N of them on a session another consumer holds open,
    // and every later reconnect would fan out N duplicate invalidations.
    expect(h.session.availabilityListenerCount).toBe(0);

    h.session.emitReady();
    expect(h.recovered).toEqual([REMOTE_HOST_ID]);

    h.dispose();
  });

  it("does not accumulate listeners across repeated picker switches", () => {
    const h = harness();
    for (let visit = 0; visit < 5; visit += 1) {
      h.requestRemote();
      h.session.emitReady();
      h.requestLocal();
    }
    // Every visit's listener is settled: each delivered its boundary and left.
    expect(h.session.availabilityListenerCount).toBe(0);

    h.dispose();
  });

  it("detaches on release when the session was ALREADY ready at subscribe time", () => {
    // The warm keep-warm hit: the cache hands this binding a session that is
    // already up. `subscribeAvailabilityRecovered` reports a RECOVERY, not the
    // current state, so no boundary will ever arrive for it - the orphan would
    // wait on one forever and never detach.
    const h = harness();
    h.session.ready = true;

    h.requestRemote();
    expect(h.session.availabilityListenerCount).toBe(1);

    h.requestLocal();
    // Nothing was owed, so nothing is kept waiting.
    expect(h.session.availabilityListenerCount).toBe(0);

    h.dispose();
  });

  it("does not accumulate listeners across picker switches over a WARM session", () => {
    // The accumulation the previous test's single case adds up to, and the one
    // actually reachable in the app: after the first visit the session stays
    // ready, so every later visit adopts it warm and would strand a listener.
    const h = harness();
    h.requestRemote();
    h.session.emitReady();
    h.requestLocal();
    h.session.ready = true;

    for (let visit = 0; visit < 5; visit += 1) {
      h.requestRemote();
      h.requestLocal();
    }
    expect(h.session.availabilityListenerCount).toBe(0);

    // A later real reconnect therefore invalidates ONCE, not once per visit.
    const recoveredBefore = h.recovered.length;
    h.requestRemote();
    h.session.ready = false;
    h.session.emitReady();
    expect(h.recovered.length).toBe(recoveredBefore + 1);

    h.dispose();
  });

  it("still keeps an orphan attached when the session is NOT yet ready", () => {
    // The negative control: the readiness check must not swallow the case the
    // orphan exists for - a session still dialing when the picker flipped away
    // owes its boundary to the queries that already errored against it.
    const h = harness();
    h.requestRemote();
    h.requestLocal();
    expect(h.session.availabilityListenerCount).toBe(1);

    h.session.emitReady();
    expect(h.recovered).toEqual([REMOTE_HOST_ID]);
    expect(h.session.availabilityListenerCount).toBe(0);

    h.dispose();
  });

  it("detaches when the session closes without ever getting ready", () => {
    const h = harness();
    h.requestRemote();
    h.requestLocal();
    expect(h.session.availabilityListenerCount).toBe(1);

    // The keep-warm window expires (or the session goes fatal) with the dial
    // never having succeeded. Nothing is owed to a dead session.
    h.session.emitClosed();
    expect(h.session.availabilityListenerCount).toBe(0);

    h.session.emitReady();
    expect(h.recovered).toEqual([]);

    h.dispose();
  });

  it("a mid-dial re-visit takes over the orphan's debt - one boundary, one delivery", () => {
    // Without the takeover, the warm re-adopt of the SAME still-dialing
    // session leaves the old orphan AND the new binding's listener attached,
    // and the one ready boundary would deliver twice in the same tick.
    const h = harness();
    h.requestRemote();
    h.requestLocal();
    expect(h.session.availabilityListenerCount).toBe(1);

    h.requestRemote();
    // The new binding's listener now carries the host's debt; the retired
    // orphan is gone rather than doubling up.
    expect(h.session.availabilityListenerCount).toBe(1);

    h.session.emitReady();
    expect(h.recovered).toEqual([REMOTE_HOST_ID]);

    h.dispose();
  });

  it("does not accumulate orphans across visits to a NEVER-ready host", () => {
    // The documented no-pile-up promise, for the host that never gets ready:
    // each visit releases while still owed, and each new visit must retire
    // the previous orphan - otherwise the host's eventual recovery fans out
    // one invalidation per abandoned visit.
    const h = harness();
    for (let visit = 0; visit < 5; visit += 1) {
      h.requestRemote();
      h.requestLocal();
    }
    expect(h.session.availabilityListenerCount).toBe(1);

    h.session.emitReady();
    expect(h.recovered).toEqual([REMOTE_HOST_ID]);

    h.dispose();
  });

  it("reset() keeps a still-owed orphan attached", () => {
    // reset() fires on every hostClient change event - including the
    // host-bound promotion that lands while this binding's session is still
    // dialing, which is precisely the window the orphan exists for. Teardown
    // semantics here would drop the promoted host's first ready boundary.
    const h = harness();
    h.requestRemote();
    h.reset();
    expect(h.session.availabilityListenerCount).toBe(1);

    h.session.emitReady();
    expect(h.recovered).toEqual([REMOTE_HOST_ID]);

    h.dispose();
  });

  it("dispose() hard-detaches the current binding's listener", () => {
    // Terminal teardown: after dispose there is no runtime left to receive a
    // boundary, so unlike reset/replacement the listener must NOT survive as
    // an orphan - a late delivery would fire into a torn-down provider.
    const h = harness();
    h.requestRemote();
    expect(h.session.availabilityListenerCount).toBe(1);

    h.dispose();
    expect(h.session.availabilityListenerCount).toBe(0);

    h.session.emitReady();
    expect(h.recovered).toEqual([]);
  });

  it("dispose() also retires an orphan left by a replaced binding", () => {
    const h = harness();
    h.requestRemote();
    h.requestLocal();
    expect(h.session.availabilityListenerCount).toBe(1);

    h.dispose();
    expect(h.session.availabilityListenerCount).toBe(0);

    h.session.emitReady();
    expect(h.recovered).toEqual([]);
  });

  it("refuses an already-aborted authority before it reaches the session cache", async () => {
    // The cache's supersession sweep treats the acquiring identity as the
    // NEWEST auth context. A retired (aborted) authority reaching it would
    // supersede the live entry and build a doomed successor - the retrying
    // wrapper gates this three layers up, but the assumption is load-bearing
    // HERE, so the seam enforces it itself.
    const h = harness();
    const aborted = new AbortController();
    aborted.abort();

    await expect(h.requestRemoteWithSignal(aborted.signal)).rejects.toThrow(
      "does not expose a valid remote transport",
    );
    expect(mocks.createRemoteHostTransport).not.toHaveBeenCalled();
    expect(h.session.availabilityListenerCount).toBe(0);

    h.dispose();
  });

  it("rejects a request after dispose instead of rebuilding a binding", async () => {
    // A rebuilt post-dispose binding would re-subscribe with nothing left to
    // ever release it. The messenger's own contract has to refuse, not rely
    // on upstream fences.
    const h = harness();
    h.dispose();

    await expect(h.requestRemoteRaw()).rejects.toThrow(
      "Host messenger has been disposed",
    );
    expect(h.session.availabilityListenerCount).toBe(0);
  });
});
