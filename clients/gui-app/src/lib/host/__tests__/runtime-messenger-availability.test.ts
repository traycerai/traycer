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
  emitReady(): void;
  emitClosed(): void;
}

function controllableSession(): ControllableSession {
  const availability = new Set<() => void>();
  const closed = new Set<() => void>();
  let closeCalls = 0;
  return {
    get availabilityListenerCount() {
      return availability.size;
    },
    get closeCalls() {
      return closeCalls;
    },
    emitReady: () => {
      for (const listener of [...availability]) {
        listener();
      }
    },
    emitClosed: () => {
      for (const listener of [...closed]) {
        listener();
      }
    },
    start: vi.fn(),
    // Never "closed": a released session lingers, which is exactly the state
    // this file is about. A closed one would just be rebuilt.
    isClosed: () => false,
    isReady: () => false,
    sendUnary: vi.fn(() => Promise.resolve({}) as never),
    subscribe: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    subscribeWithParamsProvider: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    notifyBearerRotated: vi.fn(),
    onClosed: (listener) => {
      closed.add(listener);
      return () => closed.delete(listener);
    },
    subscribeAvailabilityRecovered: (listener) => {
      availability.add(listener);
      return () => availability.delete(listener);
    },
    close: () => {
      closeCalls += 1;
    },
  };
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
  requestLocal: () => void;
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
});
