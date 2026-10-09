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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { IRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import {
  HostRequestAbortedError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  FatalErrorDetails,
  SchemaVersion,
} from "@traycer/protocol/framework/index";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  buildRuntimeHostMessenger,
  type RuntimeHostMessengerBinding,
} from "../host-messenger";

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
  /**
   * Settable BEFORE `emitClosed()` to play a terminal session fatal (the real
   * session records the verdict, then closes and notifies). Left null,
   * `emitClosed` plays a routine cache retirement - the distinction the
   * messenger's `onClosed` handler keys on.
   */
  fatal: FatalErrorDetails | null;
  emitReady(): void;
  emitClosed(): void;
  setMethodSupport(
    support: StreamMethodSupport,
    schemaVersion: SchemaVersion | null,
  ): void;
}

function controllableSession(): ControllableSession {
  const availability = new Set<() => void>();
  const closed = new Set<() => void>();
  const methodSupportListeners = new Set<() => void>();
  let closeCalls = 0;
  let terminallyClosed = false;
  let methodSupport: StreamMethodSupport = "unknown";
  let methodSchemaVersion: SchemaVersion | null = null;
  const session: ControllableSession = {
    ready: false,
    fatal: null,
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
    // Structural member: this fake models readiness, never silence.
    isSilentFor: () => false,
    sendUnary: vi.fn(() => Promise.resolve({}) as never),
    subscribe: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    subscribeAtVersion: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    subscribeWithParamsProvider: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    notifyBearerRotated: vi.fn(),
    notifyCloudVerdictChanged: vi.fn(),
    wake: vi.fn(),
    forceReconnect: vi.fn(),
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
    subscribeReadinessLost: () => () => undefined,
    getMethodSupport: () => methodSupport,
    getMethodSchemaVersion: () => methodSchemaVersion,
    subscribeMethodSupport: (listener) => {
      methodSupportListeners.add(listener);
      return () => {
        methodSupportListeners.delete(listener);
      };
    },
    terminalFatal: () => session.fatal,
    setMethodSupport: (support, schemaVersion) => {
      methodSupport = support;
      methodSchemaVersion = schemaVersion;
      for (const listener of methodSupportListeners) listener();
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
  transportDialability: "dialable",
  remoteStatus: {
    connectivity: "connectable",
    viewerReachability: "ok",
    clientCloud: "ok",
    updateState: "current",
    appVersion: null,
    lastSeenAt: null,
  },
  publicKey: "pubkey-b",
  relayFuseGrace: false,
  sandbox: null,
};

const localEntry: HostDirectoryEntry = {
  hostId: LOCAL_HOST_ID,
  label: "This machine",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:1/",
  version: "1.2.3",
  transportDialability: "dialable",
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
  sessions: readonly ControllableSession[];
  recovered: string[];
  terminals: { readonly hostId: string; readonly fatal: FatalErrorDetails }[];
  requestRemote: () => void;
  requestRemoteRaw: () => Promise<unknown>;
  requestRemoteWithSignal: (abortSignal: AbortSignal) => Promise<unknown>;
  requestRemoteWithTimeoutAndSignal: (
    abortSignal: AbortSignal,
  ) => Promise<unknown>;
  requestLocal: () => void;
  requestLocalWithSignal: (abortSignal: AbortSignal) => Promise<unknown>;
  reset: () => void;
  dispose: () => void;
} {
  const firstSession = controllableSession();
  const sessions: ControllableSession[] = [firstSession];
  let cachedSession: ControllableSession | null = firstSession;
  mocks.createRemoteHostTransport.mockImplementation(() => {
    if (cachedSession === null || cachedSession.isClosed()) {
      cachedSession = controllableSession();
      sessions.push(cachedSession);
    }
    const session = cachedSession;
    return {
      session,
      messenger: {
        request: () => Promise.resolve({}),
        requestWithResponseTimeout: () => Promise.resolve({}),
      },
      streamClient: {},
    };
  });
  const recovered: string[] = [];
  const terminals: {
    readonly hostId: string;
    readonly fatal: FatalErrorDetails;
  }[] = [];
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
    onRemoteSessionTerminal: (hostId, fatal) => {
      terminals.push({ hostId, fatal });
    },
  });
  return {
    session: firstSession,
    sessions,
    recovered,
    terminals,
    requestRemote: () => {
      void binding.messenger
        .request(
          "host.status",
          {},
          {
            replayMustBeKeyed: false,
            requiredHostMethodVersion: null,
            idempotencyKey: null,
            authority: authorityFor(
              REMOTE_HOST_ID,
              remoteEntry.websocketUrl ?? "",
            ),
          },
        )
        .catch(() => undefined);
    },
    requestRemoteRaw: () =>
      binding.messenger.request(
        "host.status",
        {},
        {
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
          idempotencyKey: null,
          authority: authorityFor(
            REMOTE_HOST_ID,
            remoteEntry.websocketUrl ?? "",
          ),
        },
      ),
    requestRemoteWithSignal: (abortSignal: AbortSignal) =>
      binding.messenger.request(
        "host.status",
        {},
        {
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
          idempotencyKey: null,
          authority: {
            ...authorityFor(REMOTE_HOST_ID, remoteEntry.websocketUrl ?? ""),
            abortSignal,
          },
        },
      ),
    requestRemoteWithTimeoutAndSignal: (abortSignal: AbortSignal) =>
      binding.messenger.requestWithResponseTimeout("host.status", {}, 5_000, {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: {
          ...authorityFor(REMOTE_HOST_ID, remoteEntry.websocketUrl ?? ""),
          abortSignal,
        },
      }),
    requestLocalWithSignal: (abortSignal: AbortSignal) =>
      binding.messenger.request(
        "host.status",
        {},
        {
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
          idempotencyKey: null,
          authority: {
            ...authorityFor(LOCAL_HOST_ID, "ws://127.0.0.1:1/"),
            abortSignal,
          },
        },
      ),
    reset: () => {
      // Auth reset changes the cache identity even if the old shared session
      // remains warm, so the next transport construction cannot adopt it.
      cachedSession = null;
      binding.reset();
    },
    // The local branch dials for real; the dial itself is irrelevant here -
    // what matters is that taking this branch evicts the remote binding first.
    requestLocal: () => {
      void binding.messenger
        .request(
          "host.status",
          {},
          {
            replayMustBeKeyed: false,
            requiredHostMethodVersion: null,
            idempotencyKey: null,
            authority: authorityFor(LOCAL_HOST_ID, "ws://127.0.0.1:1/"),
          },
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

  it("re-arms the orphan debt when released MID-RECONNECT after a delivered boundary", () => {
    // Owedness is decided from the session's LIVE state at release, not a
    // delivered-once flag: a binding that saw its first boundary, then had
    // the session drop underneath it, still owes the queries the NEXT
    // boundary if it is released while the reconnect is in flight.
    const h = harness();
    h.requestRemote();
    h.session.emitReady();
    expect(h.recovered).toEqual([REMOTE_HOST_ID]);

    // The session drops and begins reconnecting - not closed, not ready.
    h.session.ready = false;

    h.requestLocal();
    // A first-boundary one-shot flag would detach here and the recovery
    // below would reach nobody.
    expect(h.session.availabilityListenerCount).toBe(1);

    h.session.emitReady();
    expect(h.recovered).toEqual([REMOTE_HOST_ID, REMOTE_HOST_ID]);
    expect(h.session.availabilityListenerCount).toBe(0);

    h.dispose();
  });

  it("reset() hard-detaches a still-owed orphan from the previous auth context", () => {
    const h = harness();
    h.requestRemote();
    h.requestLocal();
    expect(h.session.availabilityListenerCount).toBe(1);

    h.reset();
    expect(h.session.availabilityListenerCount).toBe(0);

    h.session.fatal = incompatibleFatal();
    h.session.emitClosed();
    expect(h.recovered).toEqual([]);

    h.dispose();
  });

  it("reset() hard-detaches the current binding from the previous auth context", () => {
    const h = harness();
    h.requestRemote();
    expect(h.session.availabilityListenerCount).toBe(1);

    h.reset();
    expect(h.session.availabilityListenerCount).toBe(0);

    h.session.fatal = incompatibleFatal();
    h.session.emitClosed();
    expect(h.recovered).toEqual([]);

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

    // Abort-classified, not the invalid-transport error: downstream surfaces
    // render the latter as an actionable failure card, which is wrong for a
    // request whose owner already moved on.
    await expect(h.requestRemoteWithSignal(aborted.signal)).rejects.toThrow(
      "Request authority was aborted before dispatch",
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

  it("an aborted authority is inert on the LOCAL branch too - it must not release the live remote binding as a side effect", async () => {
    // The local branch runs `closeRemoteTransport()` before dispatching, so
    // gating only the remote branch would let a stale aborted background
    // request for the local host tear down a binding whose owner is mid-dial.
    const h = harness();
    h.requestRemote();
    expect(h.session.closeCalls).toBe(0);

    const aborted = new AbortController();
    aborted.abort();
    const error: unknown = await h.requestLocalWithSignal(aborted.signal).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(HostRequestAbortedError);
    // The remote binding survived: no release, listener still attached.
    expect(h.session.closeCalls).toBe(0);
    expect(h.session.availabilityListenerCount).toBe(1);

    h.dispose();
  });

  it("requestWithResponseTimeout enforces the same abort gate", async () => {
    const h = harness();
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      h.requestRemoteWithTimeoutAndSignal(aborted.signal),
    ).rejects.toThrow("Request authority was aborted before dispatch");
    expect(mocks.createRemoteHostTransport).not.toHaveBeenCalled();

    h.dispose();
  });

  it("a terminal fatal close fires ONE host-scope invalidation to un-strand the spinner's cached error", () => {
    const h = harness();
    h.requestRemote();
    expect(h.recovered).toEqual([]);

    // The dial ends terminally (incompatible handshake / revoked
    // credential) - the ready boundary the stranded query was owed
    // will never come, so the close itself must deliver the invalidation.
    h.session.fatal = incompatibleFatal();
    h.session.emitClosed();
    expect(h.recovered).toEqual([REMOTE_HOST_ID]);

    h.dispose();
  });

  it("tells the terminal-session callback ONCE, with the host and the SANDBOX_FROZEN fatal it ended on", () => {
    const h = harness();
    h.requestRemote();
    expect(h.terminals).toEqual([]);

    const fatal = frozenFatal();
    h.session.fatal = fatal;
    h.session.emitClosed();

    expect(h.terminals).toEqual([{ hostId: REMOTE_HOST_ID, fatal }]);

    h.dispose();
  });

  it("passes any terminal fatal to the callback, not only the frozen one (the consumer filters)", () => {
    const h = harness();
    h.requestRemote();

    const fatal = incompatibleFatal();
    h.session.fatal = fatal;
    h.session.emitClosed();

    expect(h.terminals).toEqual([{ hostId: REMOTE_HOST_ID, fatal }]);

    h.dispose();
  });

  it("never calls the terminal-session callback for a routine close", () => {
    const h = harness();
    h.requestRemote();

    h.session.emitClosed();

    expect(h.terminals).toEqual([]);

    h.dispose();
  });

  it("auth reset clears a terminal verdict before the next credential context requests", async () => {
    const h = harness();
    h.requestRemote();
    h.session.fatal = incompatibleFatal();
    h.session.emitClosed();
    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(1);

    h.reset();
    await expect(h.requestRemoteRaw()).resolves.toEqual({});
    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(2);
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1]?.isClosed()).toBe(false);

    h.dispose();
  });

  it("rejects with the recorded verdict instead of redialing while it is fresh, then redials after the TTL", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.requestRemote();
      expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(1);

      h.session.fatal = incompatibleFatal();
      h.session.emitClosed();

      // The invalidation-triggered refetch lands HERE: a transparent rebuild
      // would dial fresh, error retryable before ITS fatal, and re-strand the
      // spinner - the exact loop the verdict exists to break. The rejection
      // carries the fatal so the surface can say why.
      const error: unknown = await h.requestRemoteRaw().then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(HostTransportFailureError);
      expect((error as HostTransportFailureError).fatalDetails).toEqual(
        incompatibleFatal(),
      );
      expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(1);

      // Terminal described the SESSION, not the host: after the TTL the next
      // request dials fresh (the host may have been updated/re-entitled).
      vi.advanceTimersByTime(30_000);
      h.requestRemote();
      expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(2);

      h.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the verdict early when the host's transport identity changes - a host update must not wait out the TTL", async () => {
    // An INCOMPATIBLE fatal is resolved exactly by a version change, and the
    // directory publishes that as a new transport key. The verdict describes
    // a session that can no longer even be built, so a key mismatch discards
    // it immediately instead of fail-fasting the just-fixed host for the
    // rest of the TTL.
    const session = controllableSession();
    mocks.createRemoteHostTransport.mockImplementation(() => ({
      session,
      messenger: {
        request: () => Promise.resolve({}),
        requestWithResponseTimeout: () => Promise.resolve({}),
      },
      streamClient: {},
    }));
    let currentRemoteEntry: RemoteHostDirectoryEntry = remoteEntry;
    const binding = buildRuntimeHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      resolveTarget: (hostId) =>
        hostId === REMOTE_HOST_ID ? currentRemoteEntry : localEntry,
      auth: null,
      authnBaseUrl: "https://authn.invalid",
      requestId: () => "req-1",
      onRemoteAvailabilityRecovered: () => undefined,
      onRemoteSessionTerminal: () => undefined,
    });
    const requestRemote = (): Promise<unknown> =>
      binding.messenger.request(
        "host.status",
        {},
        {
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
          idempotencyKey: null,
          authority: authorityFor(
            REMOTE_HOST_ID,
            remoteEntry.websocketUrl ?? "",
          ),
        },
      );

    await requestRemote().catch(() => undefined);
    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(1);
    session.fatal = incompatibleFatal();
    session.emitClosed();

    // Same identity: the fresh verdict fails fast, no rebuild.
    const error: unknown = await requestRemote().then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(HostTransportFailureError);
    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(1);

    // The host updates: new version => new transport key => the verdict is
    // discarded and the request dials fresh, well inside the TTL.
    currentRemoteEntry = { ...remoteEntry, version: "1.2.4" };
    await requestRemote().catch(() => undefined);
    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(2);

    binding.dispose();
  });

  it("rebuilds its remote transport with a session grant when a personal-looking entry is corrected to a sandbox, and not for a same-content re-emit", async () => {
    // A sandbox first projected as a personal host (a list read before the
    // sandbox facts arrived) built a user-bearer transport. Once the entry is
    // corrected that transport must not be kept.
    const session = controllableSession();
    mocks.createRemoteHostTransport.mockImplementation(() => ({
      session,
      messenger: {
        request: () => Promise.resolve({}),
        requestWithResponseTimeout: () => Promise.resolve({}),
      },
      streamClient: {},
    }));
    let currentRemoteEntry: RemoteHostDirectoryEntry = remoteEntry;
    const binding = buildRuntimeHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      resolveTarget: (hostId) =>
        hostId === REMOTE_HOST_ID ? currentRemoteEntry : localEntry,
      auth: null,
      authnBaseUrl: "https://authn.invalid",
      requestId: () => "req-1",
      onRemoteAvailabilityRecovered: () => undefined,
      onRemoteSessionTerminal: () => undefined,
    });
    const requestRemote = (): Promise<unknown> =>
      binding.messenger
        .request(
          "host.status",
          {},
          {
            replayMustBeKeyed: false,
            requiredHostMethodVersion: null,
            idempotencyKey: null,
            authority: authorityFor(
              REMOTE_HOST_ID,
              remoteEntry.websocketUrl ?? "",
            ),
          },
        )
        .catch(() => undefined);
    await requestRemote();
    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(1);
    expect(mocks.createRemoteHostTransport).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ openAuth: "user-bearer" }),
    );

    // Same content, re-emitted as a new object: the live transport is kept.
    currentRemoteEntry = { ...remoteEntry };
    await requestRemote();
    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(1);

    // The same host, now carrying its sandbox facts: rebuilt on a grant.
    currentRemoteEntry = {
      ...remoteEntry,
      sandbox: { state: "suspended", frozen: false, profile: null },
    };
    await requestRemote();
    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(2);
    expect(mocks.createRemoteHostTransport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ openAuth: "session-grant" }),
    );

    // And a same-content re-emit of the corrected entry keeps that one.
    currentRemoteEntry = {
      ...remoteEntry,
      sandbox: { state: "suspended", frozen: false, profile: null },
    };
    await requestRemote();
    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(2);

    binding.dispose();
  });

  it("a routine close (no fatal) records no verdict, fires no invalidation, and the next request rebuilds", () => {
    // Linger expiry / supersession retire a session without a verdict; the
    // host's next visit must dial normally, not land on a poisoned error.
    const h = harness();
    h.requestRemote();

    h.session.emitClosed();
    expect(h.recovered).toEqual([]);

    h.requestRemote();
    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(2);

    h.dispose();
  });
});

/**
 * A binding over ONE remote sandbox host whose directory row the test moves.
 * Every dial the messenger makes is a `createRemoteHostTransport` call, and
 * each gets a fresh session once the previous one has closed.
 */
interface SandboxVerdictRig {
  readonly binding: RuntimeHostMessengerBinding<HostRpcRegistry>;
  /** Moves the directory row; `null` is a host the list no longer holds. */
  readonly setEntry: (entry: HostDirectoryEntry | null) => void;
  readonly request: () => Promise<unknown>;
  /** Ends the live session on `fatal`, as the session does: records, closes, notifies. */
  readonly endSessionOn: (fatal: FatalErrorDetails) => void;
  readonly dials: () => number;
}

function sandboxVerdictRig(first: HostDirectoryEntry): SandboxVerdictRig {
  let current: HostDirectoryEntry | null = first;
  let live: ControllableSession | null = null;
  mocks.createRemoteHostTransport.mockImplementation(() => {
    if (live === null || live.isClosed()) {
      live = controllableSession();
    }
    return {
      session: live,
      messenger: {
        request: () => Promise.resolve({}),
        requestWithResponseTimeout: () => Promise.resolve({}),
      },
      streamClient: {},
    };
  });
  const binding = buildRuntimeHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    resolveTarget: () => current,
    auth: null,
    authnBaseUrl: "https://authn.invalid",
    requestId: () => "req-1",
    onRemoteAvailabilityRecovered: () => undefined,
    onRemoteSessionTerminal: () => undefined,
  });
  return {
    binding,
    setEntry: (entry) => {
      current = entry;
    },
    request: () =>
      binding.messenger.request(
        "host.status",
        {},
        {
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
          idempotencyKey: null,
          authority: authorityFor(
            REMOTE_HOST_ID,
            remoteEntry.websocketUrl ?? "",
          ),
        },
      ),
    endSessionOn: (fatal) => {
      if (live === null) throw new Error("no session has been dialed yet");
      live.fatal = fatal;
      live.emitClosed();
    },
    dials: () => mocks.createRemoteHostTransport.mock.calls.length,
  };
}

function sandboxRow(frozen: boolean): RemoteHostDirectoryEntry {
  return {
    ...remoteEntry,
    sandbox: { state: "awake", frozen, profile: null },
  };
}

function rejection(request: Promise<unknown>): Promise<unknown> {
  return request.then(
    () => null,
    (reason: unknown) => reason,
  );
}

function expectFrozenVerdict(error: unknown): void {
  expect(error).toBeInstanceOf(HostTransportFailureError);
  if (!(error instanceof HostTransportFailureError)) return;
  expect(error.fatalDetails).toEqual(frozenFatal());
}

describe("a SANDBOX_FROZEN verdict ends when the list shows the sandbox thawed or gone", () => {
  it("(a) dials again once the entry flips to not frozen, through the redial gate alone", async () => {
    const rig = sandboxVerdictRig(sandboxRow(true));
    await rig.request();
    expect(rig.dials()).toBe(1);
    rig.endSessionOn(frozenFatal());

    // Frozen still: the verdict holds and nothing is dialed.
    expectFrozenVerdict(await rejection(rig.request()));
    expect(rig.dials()).toBe(1);

    // A top-up: the next request dials instead of waiting out the TTL.
    rig.setEntry(sandboxRow(false));
    await rig.request();
    expect(rig.dials()).toBe(2);

    rig.binding.dispose();
  });

  it("(a) dials again after hostListChanged() sees the flip, with no request in between", async () => {
    const rig = sandboxVerdictRig(sandboxRow(true));
    await rig.request();
    rig.endSessionOn(frozenFatal());

    rig.setEntry(sandboxRow(false));
    rig.binding.hostListChanged();
    await rig.request();

    expect(rig.dials()).toBe(2);

    rig.binding.dispose();
  });

  it("(b) a verdict recorded while the entry still said not frozen is kept: the list is merely stale", async () => {
    const rig = sandboxVerdictRig(sandboxRow(false));
    await rig.request();
    rig.endSessionOn(frozenFatal());

    // The list has not yet caught up with the fatal. Refetches landing in
    // this window must not drop the verdict and mint a doomed grant again.
    rig.binding.hostListChanged();
    expectFrozenVerdict(await rejection(rig.request()));
    rig.binding.hostListChanged();
    expectFrozenVerdict(await rejection(rig.request()));
    expect(rig.dials()).toBe(1);

    rig.binding.dispose();
  });

  it("(c) stale first, then the list shows frozen, then not frozen: dials", async () => {
    const rig = sandboxVerdictRig(sandboxRow(false));
    await rig.request();
    rig.endSessionOn(frozenFatal());
    rig.binding.hostListChanged();
    expect(await rejection(rig.request())).toBeInstanceOf(
      HostTransportFailureError,
    );

    // The list agrees with the fatal: confirmed.
    rig.setEntry(sandboxRow(true));
    rig.binding.hostListChanged();
    expectFrozenVerdict(await rejection(rig.request()));
    expect(rig.dials()).toBe(1);

    // Now the top-up.
    rig.setEntry(sandboxRow(false));
    rig.binding.hostListChanged();
    await rig.request();
    expect(rig.dials()).toBe(2);

    rig.binding.dispose();
  });

  it("(c) confirmation by a request through the redial gate counts too", async () => {
    const rig = sandboxVerdictRig(sandboxRow(false));
    await rig.request();
    rig.endSessionOn(frozenFatal());

    rig.setEntry(sandboxRow(true));
    expectFrozenVerdict(await rejection(rig.request()));

    rig.setEntry(sandboxRow(false));
    await rig.request();
    expect(rig.dials()).toBe(2);

    rig.binding.dispose();
  });

  it("(d) a sandbox that is gone from the list ends the verdict: a host listed again dials", async () => {
    const rig = sandboxVerdictRig(sandboxRow(true));
    await rig.request();
    rig.endSessionOn(frozenFatal());

    rig.setEntry(null);
    rig.binding.hostListChanged();
    // It comes back (re-created under the same id) and is frozen again: the
    // old verdict described the old sandbox, so this request dials.
    rig.setEntry(sandboxRow(true));
    await rig.request();

    expect(rig.dials()).toBe(2);

    rig.binding.dispose();
  });

  it("(d) a host the list now shows as no sandbox at all dials", async () => {
    const rig = sandboxVerdictRig(sandboxRow(true));
    await rig.request();
    rig.endSessionOn(frozenFatal());

    const noSandbox: RemoteHostDirectoryEntry = {
      ...remoteEntry,
      sandbox: null,
    };
    rig.setEntry(noSandbox);
    rig.binding.hostListChanged();
    await rig.request();

    expect(rig.dials()).toBe(2);

    rig.binding.dispose();
  });

  it("(e) a different fatal on the same key keeps failing fast within the TTL, even when the entry shows not frozen", async () => {
    const rig = sandboxVerdictRig(sandboxRow(false));
    await rig.request();
    rig.endSessionOn(incompatibleFatal());

    rig.binding.hostListChanged();
    const error = await rejection(rig.request());

    expect(error).toBeInstanceOf(HostTransportFailureError);
    if (error instanceof HostTransportFailureError) {
      expect(error.fatalDetails).toEqual(incompatibleFatal());
    }
    expect(rig.dials()).toBe(1);

    rig.binding.dispose();
  });

  it("(e) nor does a thaw end it when the entry showed frozen at the time", async () => {
    const rig = sandboxVerdictRig(sandboxRow(true));
    await rig.request();
    rig.endSessionOn(incompatibleFatal());

    rig.setEntry(sandboxRow(false));
    rig.binding.hostListChanged();
    expect(await rejection(rig.request())).toBeInstanceOf(
      HostTransportFailureError,
    );
    expect(rig.dials()).toBe(1);

    rig.binding.dispose();
  });

  describe("past the 30 s TTL", () => {
    const PAST_TTL_MS = 30_001;

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("(1) a CONFIRMED frozen verdict still fails fast with the frozen fatal, and nothing is dialed", async () => {
      const rig = sandboxVerdictRig(sandboxRow(true));
      await rig.request();
      rig.endSessionOn(frozenFatal());
      expectFrozenVerdict(await rejection(rig.request()));
      expect(rig.dials()).toBe(1);

      vi.advanceTimersByTime(PAST_TTL_MS);

      expectFrozenVerdict(await rejection(rig.request()));
      // A long wait later, still: the host's billing state does not change
      // with time, so no grant is minted for a session that will end the same
      // way.
      vi.advanceTimersByTime(10 * PAST_TTL_MS);
      rig.binding.hostListChanged();
      expectFrozenVerdict(await rejection(rig.request()));
      expect(rig.dials()).toBe(1);

      rig.binding.dispose();
    });

    it("(2) control: once the list shows it thawed after that wait, the next request dials", async () => {
      const rig = sandboxVerdictRig(sandboxRow(true));
      await rig.request();
      rig.endSessionOn(frozenFatal());
      vi.advanceTimersByTime(PAST_TTL_MS);
      expectFrozenVerdict(await rejection(rig.request()));
      expect(rig.dials()).toBe(1);

      rig.setEntry(sandboxRow(false));
      rig.binding.hostListChanged();
      await rig.request();

      expect(rig.dials()).toBe(2);

      rig.binding.dispose();
    });

    it("(3) control: an UNconfirmed frozen verdict (the list never showed frozen) expires at the TTL and dials", async () => {
      const rig = sandboxVerdictRig(sandboxRow(false));
      await rig.request();
      rig.endSessionOn(frozenFatal());
      // Within the TTL it holds.
      expectFrozenVerdict(await rejection(rig.request()));
      expect(rig.dials()).toBe(1);

      vi.advanceTimersByTime(PAST_TTL_MS);
      await rig.request();

      expect(rig.dials()).toBe(2);

      rig.binding.dispose();
    });

    it("(4) control: a non-frozen fatal expires at the TTL and dials, even on an entry that shows frozen", async () => {
      const rig = sandboxVerdictRig(sandboxRow(true));
      await rig.request();
      rig.endSessionOn(incompatibleFatal());
      expect(await rejection(rig.request())).toBeInstanceOf(
        HostTransportFailureError,
      );
      expect(rig.dials()).toBe(1);

      vi.advanceTimersByTime(PAST_TTL_MS);
      await rig.request();

      expect(rig.dials()).toBe(2);

      rig.binding.dispose();
    });
  });

  it("a fresh frozen verdict still fails fast while the list agrees, and hostListChanged() with no verdict is harmless", async () => {
    const rig = sandboxVerdictRig(sandboxRow(true));
    rig.binding.hostListChanged();
    await rig.request();
    rig.endSessionOn(frozenFatal());

    rig.binding.hostListChanged();
    rig.binding.hostListChanged();
    expectFrozenVerdict(await rejection(rig.request()));
    expect(rig.dials()).toBe(1);

    rig.binding.dispose();
  });
});

function frozenFatal(): FatalErrorDetails {
  return {
    code: "SANDBOX_FROZEN",
    reason: "This sandbox is paused because your credits ran out.",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

function incompatibleFatal(): FatalErrorDetails {
  return {
    code: "INCOMPATIBLE",
    reason: "protocol manifests do not overlap",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}
