import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  RemoteStreamClient,
  type IRemoteSession,
} from "@traycer-clients/shared/host-transport/remote/index";
import type {
  FatalErrorDetails,
  SchemaVersion,
} from "@traycer/protocol/framework/index";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

// One global client shared between the mocked `useHostClient` and the tests.
const globalClientRef = vi.hoisted(() => ({
  value: null as HostClient<HostRpcRegistry> | null,
  // Bumped by a test to make `useHostClient()` hand back a NEW requester on
  // the next render - what production does when the effective host moves.
  requesterEpoch: 0,
  requester: null as HostClient<HostRpcRegistry> | null,
  requesterFor: -1,
}));

// Only the network boundary is replaced; every other export of this barrel
// stays REAL, matching `runtime-messenger-availability.test.ts`.
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

vi.mock("@/lib/host/runtime", () => {
  const spine = () => {
    if (globalClientRef.value === null) {
      throw new Error("test global client not configured");
    }
    return globalClientRef.value;
  };
  return {
    // A requester re-minted per `requesterEpoch`, which is what production
    // `useHostClient()` hands back whenever the effective host moves. The hook
    // under test must take its auth base from the BINDING's client (the stable
    // spine) instead - with the requester in its build effect's deps, every
    // Activate/failover tore down and re-dialed unrelated stream clients.
    useHostClient: () => {
      if (globalClientRef.requesterFor !== globalClientRef.requesterEpoch) {
        globalClientRef.requester = spine().createRequesterForHostId(null);
        globalClientRef.requesterFor = globalClientRef.requesterEpoch;
      }
      return globalClientRef.requester ?? spine();
    },
    useHostBinding: () => ({ hostClient: spine(), hostId: null }),
  };
});

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ authnBaseUrl: "http://localhost:5005" }),
}));

import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { resetHostStreamClientCacheForTest } from "@/lib/host/host-stream-client-cache";
import { useAuthStore } from "@/stores/auth/auth-store";

// The SPINE `useHostClient` hands back in this suite - never bound to any one
// host (redesign P4.2 deleted the active slot `.bind()` used to fill).
const knownHostEntries = new Map<string, HostDirectoryEntry>([
  [mockLocalHostEntry.hostId, mockLocalHostEntry],
]);

function buildGlobalClient(withContext: boolean): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) => knownHostEntries.get(hostId) ?? null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  if (withContext) {
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );
  }
  return client;
}

const TARGET_B: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "host-b",
  websocketUrl: "ws://127.0.0.1:59999/rpc",
};

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

const FROZEN_SANDBOX_TARGET: RemoteHostDirectoryEntry = {
  hostId: "sandbox-frozen-1",
  label: "Frozen sandbox",
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
  publicKey: "pubkey-frozen-sandbox",
  relayFuseGrace: false,
  sandbox: {
    state: "suspended",
    frozen: true,
    profile: "agent",
    ownerTeamName: null,
    ownerTeamId: null,
  },
};

function frozenFatal(): FatalErrorDetails {
  return {
    code: "SANDBOX_FROZEN",
    reason: "This sandbox is paused because your credits ran out.",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

describe("useHostStreamClientFor", () => {
  afterEach(() => {
    cleanup();
    globalClientRef.value = null;
    resetHostStreamClientCacheForTest();
    mocks.createRemoteHostTransport.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not rebuild its stream client in a loop when a frozen sandbox's session ends with SANDBOX_FROZEN", async () => {
    vi.useFakeTimers();
    globalClientRef.value = buildGlobalClient(true);
    const sessions: ControllableSession[] = [];
    mocks.createRemoteHostTransport.mockImplementation(() => {
      const session = controllableSession();
      sessions.push(session);
      return { session, streamClient: new RemoteStreamClient(session) };
    });

    renderHook(() => useHostStreamClientFor(FROZEN_SANDBOX_TARGET, null));
    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(1);

    act(() => {
      sessions[0].fatal = frozenFatal();
      sessions[0].emitClosed();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(1);
  });

  it("returns null when there is no target", () => {
    globalClientRef.value = buildGlobalClient(true);
    const { result } = renderHook(() => useHostStreamClientFor(null, null));
    expect(result.current).toBeNull();
  });

  it("returns null when there is no authenticated request context", () => {
    globalClientRef.value = buildGlobalClient(false);
    const { result } = renderHook(() => useHostStreamClientFor(TARGET_B, null));
    expect(result.current).toBeNull();
  });

  it("builds a stream client for the chosen host without moving the global active host", () => {
    const globalClient = buildGlobalClient(true);
    globalClientRef.value = globalClient;
    const { result } = renderHook(() => useHostStreamClientFor(TARGET_B, null));
    expect(result.current).toBeInstanceOf(WsStreamClient);
    // Building a transient stream client for host B must not give the global
    // SPINE an active host of its own (no global side effect) - it stays
    // unbound (redesign P4.2 deleted the active slot `.bind()` used to set).
    expect(globalClient.getActiveHostId()).toBeNull();
  });

  it("memoizes for a stable target and rebuilds for a different host", () => {
    globalClientRef.value = buildGlobalClient(true);
    const { result, rerender } = renderHook(
      ({ target }) => useHostStreamClientFor(target, null),
      { initialProps: { target: TARGET_B } },
    );
    const first = result.current;
    expect(first).not.toBeNull();

    rerender({ target: TARGET_B });
    expect(result.current).toBe(first);

    const targetC: HostDirectoryEntry = { ...TARGET_B, hostId: "host-c" };
    rerender({ target: targetC });
    expect(result.current).not.toBe(first);
  });

  it("does not rebuild when the app-wide requester is re-minted (an effective-host move)", () => {
    // `useHostClient()` returns a requester pinned to the effective host and
    // re-minted when that host moves. This hook needs only the transport
    // identity - request context, user id, bearer rotation - which every
    // requester binds to the same underlying client, so it reads the
    // BINDING's client. With the requester in the build effect's deps, an
    // Activate or failover tore down and re-dialed every stream this hook
    // owns, including ones bound to hosts the move never touched, and the
    // notifications provider read its local stream's fresh instance as a
    // respawn and wiped its replica.
    globalClientRef.value = buildGlobalClient(true);
    const { result, rerender } = renderHook(
      ({ target }) => useHostStreamClientFor(target, null),
      { initialProps: { target: TARGET_B } },
    );
    const first = result.current;
    expect(first).not.toBeNull();

    globalClientRef.requesterEpoch += 1;
    rerender({ target: TARGET_B });
    expect(result.current).toBe(first);
  });

  it("does not rebuild when a fresh entry has the same transport identity", async () => {
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    globalClientRef.value = buildGlobalClient(true);
    const { result, rerender } = renderHook(
      ({ target }) => useHostStreamClientFor(target, null),
      { initialProps: { target: TARGET_B } },
    );
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    rerender({
      target: {
        ...TARGET_B,
        label: "Renamed host",
      },
    });

    expect(result.current).toBe(first);
    expect(closeSpy).not.toHaveBeenCalled();

    cleanup();
    await Promise.resolve();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.contexts[0]).toBe(first);
  });

  it("rebuilds when the same host id receives a new websocket URL", async () => {
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    globalClientRef.value = buildGlobalClient(true);
    const { result, rerender } = renderHook(
      ({ target }) => useHostStreamClientFor(target, null),
      { initialProps: { target: TARGET_B } },
    );
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    rerender({
      target: {
        ...TARGET_B,
        websocketUrl: "ws://127.0.0.1:60000/rpc",
      },
    });

    expect(result.current).toBeInstanceOf(WsStreamClient);
    expect(result.current).not.toBe(first);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.contexts[0]).toBe(first);

    const second = result.current;
    cleanup();
    await Promise.resolve();
    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect(closeSpy.mock.contexts[1]).toBe(second);
  });

  it("keeps a healthy LOCAL client across a cloud-capability restoration", async () => {
    // The restoration rebuild exists for remote bindings, whose attach grant
    // consults the verdict. A local binding never asked; bumping it too
    // released the sole holder's lease and closed the working local socket.
    globalClientRef.value = buildGlobalClient(true);
    const profile = { userId: "u1", userName: "U", email: "u@example.com" };
    useAuthStore
      .getState()
      .setUnverifiedSession(profile, { userId: "u1", username: "U" });
    try {
      const { result } = renderHook(() =>
        useHostStreamClientFor(mockLocalHostEntry, null),
      );
      const first = result.current;
      expect(first).toBeInstanceOf(WsStreamClient);

      act(() => {
        useAuthStore
          .getState()
          .setSignedIn(profile, { userId: "u1", username: "U" }, []);
      });

      // RED before the fix: a new instance, the first one closed.
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current).toBe(first);
      expect(first?.isClosed()).toBe(false);
    } finally {
      useAuthStore.getState().setSignedOut();
    }
  });

  it("replaces a client that closes while its host identity remains unchanged", async () => {
    globalClientRef.value = buildGlobalClient(true);
    const { result } = renderHook(() => useHostStreamClientFor(TARGET_B, null));
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    act(() => {
      first?.close("unexpected-terminal-close");
    });

    await waitFor(() => {
      expect(result.current).toBeInstanceOf(WsStreamClient);
      expect(result.current).not.toBe(first);
      expect(result.current?.isClosed()).toBe(false);
    });
  });

  it("keeps the same stream client across a byte-identical directory re-emit (benign onLocalHostChange churn)", () => {
    // Regression for the silent chat-freeze: every `onLocalHostChange`
    // rebuilds `localEntry` and (on desktop) crosses the IPC bridge as a fresh
    // object, so even an unchanged host arrives as a NEW entry reference.
    // The memo must key on transport VALUE, not entry identity, or it tears the
    // socket down and the chat session is left holding a closed WsStreamClient.
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    globalClientRef.value = buildGlobalClient(true);
    const { result, rerender } = renderHook(
      ({ target }) => useHostStreamClientFor(target, null),
      { initialProps: { target: { ...TARGET_B } } },
    );
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    // A distinct object with byte-for-byte identical connection details.
    rerender({ target: { ...TARGET_B } });

    expect(result.current).toBe(first);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("does not rebuild when the request context object rotates for the same user", () => {
    // Credential-lease rotation swaps the `RequestContext` object but keeps the
    // same user. The live `bearer` closure re-reads the new token on the next
    // (re)connect, so the client must NOT be rebuilt - rebuilding would close
    // the active chat socket on every token refresh.
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    const globalClient = buildGlobalClient(true);
    globalClientRef.value = globalClient;
    const { result, rerender } = renderHook(
      ({ target }) => useHostStreamClientFor(target, null),
      { initialProps: { target: TARGET_B } },
    );
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    globalClient.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-2",
      }),
    );
    rerender({ target: TARGET_B });

    expect(result.current).toBe(first);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("threads a stable auth revalidator without churning the client, and rebuilds when it changes", () => {
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    globalClientRef.value = buildGlobalClient(true);
    const authA: StreamAuthRevalidator = {
      revalidateForReconnect: () => Promise.resolve("rotated"),
    };
    const { result, rerender } = renderHook(
      ({ auth }) => useHostStreamClientFor(TARGET_B, auth),
      { initialProps: { auth: authA } },
    );
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    // A stable revalidator (the production case - `useStreamAuthRevalidator`
    // returns a referentially stable object) must keep the same client.
    rerender({ auth: authA });
    expect(result.current).toBe(first);
    expect(closeSpy).not.toHaveBeenCalled();

    // A genuinely different revalidator identity rebuilds (and closes the old).
    const authB: StreamAuthRevalidator = {
      revalidateForReconnect: () => Promise.resolve("rotated"),
    };
    rerender({ auth: authB });
    expect(result.current).not.toBe(first);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.contexts[0]).toBe(first);
  });
});
