import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  RemoteHostMessenger,
  RemoteStreamClient,
  type IRemoteSession,
} from "@traycer-clients/shared/host-transport/remote/index";
import {
  acquireRemoteSession,
  remoteSessionRefCountForTest,
  type RemoteSessionIdentity,
} from "@traycer-clients/shared/host-transport/remote/active-remote-sessions";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

const bindingRef = vi.hoisted(() => ({
  value: null as {
    readonly hostClient: HostClient<HostRpcRegistry>;
  } | null,
}));

// Stable hoisted stubs: both feed the value-memo / effect deps, so a fresh
// reference each render would churn the stream client.
const authServiceRef = vi.hoisted(() => ({
  value: { revalidateCurrentContext: () => Promise.resolve(null) },
}));

const runnerHostRef = vi.hoisted(() => {
  const handlers = new Set<() => void>();
  return {
    handlers,
    host: {
      onSystemResumed: (handler: () => void) => {
        handlers.add(handler);
        return { dispose: () => handlers.delete(handler) };
      },
    },
  };
});

vi.mock("@/lib/host/runtime", () => ({
  useHostBinding: () => bindingRef.value,
  useAuthService: () => authServiceRef.value,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => runnerHostRef.host,
}));

// `createRemoteHostTransport` is the network boundary a remote-kind target
// crosses (Noise-NK handshake + relay socket) - out of scope for a React
// stream-lifecycle test. Every other named export of this barrel (notably
// `RemoteHostMessenger` / `RemoteStreamClient`) stays REAL, and the mock
// implementation below drives the REAL `acquireRemoteSession` cache, so the
// test exercises the actual production ref-counting/rotation behavior, not a
// hand-rolled substitute (mirrors `use-host-client-for-strict-mode.test.tsx`).
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

import { HostStreamProvider } from "@/lib/host/stream-runtime";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";

function buildClient(): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  return client;
}

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return <HostStreamProvider>{props.children}</HostStreamProvider>;
}

const RELAY_URL = "wss://relay.test/attach";

function remoteTarget(publicKey: string): RemoteHostDirectoryEntry {
  return {
    hostId: "remote-host-a",
    label: "remote-host-a",
    kind: "remote",
    // Every remote host shares one fixed relay attach URL - a rotation is a
    // same-URL event by construction, so this stays identical across A/B.
    websocketUrl: RELAY_URL,
    version: "1.0.0",
    status: "available",
    publicKey,
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
  };
}

interface FakeRemoteSession extends IRemoteSession<
  HostRpcRegistry,
  HostStreamRpcRegistry
> {
  readonly closeCalls: number;
}

// A plain `closeCalls` counter - not a `vi.fn()` reference - so assertions
// read `session.closeCalls` instead of the bare method (`@typescript-eslint/
// unbound-method` flags referencing an interface method, since `close(): void`
// is method-shorthand syntax). Mirrors `active-remote-sessions.test.ts`'s
// `fakeSession()`.
function fakeRemoteSession(): FakeRemoteSession {
  let closeCalls = 0;
  const session: FakeRemoteSession = {
    get closeCalls() {
      return closeCalls;
    },
    start: vi.fn(),
    isClosed: () => closeCalls > 0,
    isReady: () => true,
    sendUnary: vi.fn(() => Promise.resolve({}) as never),
    subscribe: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    notifyBearerRotated: vi.fn(),
    close: () => {
      closeCalls += 1;
    },
  };
  return session;
}

/** Matches `createRequestContextFixture`'s default identity. */
const FIXTURE_USER_ID = "user-fixture-1";

function remoteIdentity(publicKey: string): RemoteSessionIdentity {
  return {
    hostId: "remote-host-a",
    userId: FIXTURE_USER_ID,
    hostPublicKey: publicKey,
    relayAttachUrl: RELAY_URL,
  };
}

describe("HostStreamProvider", () => {
  afterEach(() => {
    cleanup();
    bindingRef.value = null;
    runnerHostRef.handlers.clear();
    mocks.createRemoteHostTransport.mockReset();
    vi.restoreAllMocks();
  });

  it("force-reconnects all stream sessions on a shell system-resume signal", () => {
    const reconnectSpy = vi.spyOn(WsStreamClient.prototype, "reconnectAll");
    const hostClient = buildClient();
    bindingRef.value = { hostClient };
    act(() => {
      hostClient.bind(mockLocalHostEntry);
    });

    const { result } = renderHook(() => useWsStreamClient(), { wrapper });
    expect(result.current).toBeInstanceOf(WsStreamClient);
    expect(runnerHostRef.handlers.size).toBe(1);

    act(() => {
      for (const handler of runnerHostRef.handlers) {
        handler();
      }
    });

    expect(reconnectSpy).toHaveBeenCalledWith("wake-resume");
  });

  it("keeps the SAME client across a same-host endpoint change and nudges an immediate re-dial", () => {
    const reconnectSpy = vi.spyOn(WsStreamClient.prototype, "reconnectAll");
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    const hostClient = buildClient();
    bindingRef.value = { hostClient };
    act(() => {
      hostClient.bind(mockLocalHostEntry);
    });

    const { result } = renderHook(() => useWsStreamClient(), { wrapper });
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    // A host restart keeps the same hostId but moves to a new websocketUrl. The
    // client is keyed on host IDENTITY, so the same instance survives - it is
    // neither rebuilt nor closed - and the live `endpoint()` re-dials the new
    // address. The endpoint move nudges an immediate re-dial instead of waiting
    // out the reconnect backoff.
    act(() => {
      hostClient.bind({
        ...mockLocalHostEntry,
        websocketUrl: "ws://127.0.0.1:4918/rpc",
        status: "available",
      });
    });

    expect(result.current).toBe(first);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(reconnectSpy).toHaveBeenCalledWith("host-endpoint-change");
  });

  it("rebuilds and closes the client only on a host identity change", () => {
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    const hostClient = buildClient();
    bindingRef.value = { hostClient };
    act(() => {
      hostClient.bind(mockLocalHostEntry);
    });

    const { result } = renderHook(() => useWsStreamClient(), { wrapper });
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    // A DIFFERENT hostId is a genuine identity change (host swap): the old
    // client is replaced and closed, a fresh one built for the new host.
    act(() => {
      hostClient.bind({
        ...mockLocalHostEntry,
        hostId: "host-other",
        websocketUrl: "ws://127.0.0.1:4918/rpc",
      });
    });

    expect(result.current).toBeInstanceOf(WsStreamClient);
    expect(result.current).not.toBe(first);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.contexts[0]).toBe(first);
  });

  it("rebuilds the client when it is closed underneath the provider", () => {
    const hostClient = buildClient();
    bindingRef.value = { hostClient };
    act(() => {
      hostClient.bind(mockLocalHostEntry);
    });

    const { result } = renderHook(() => useWsStreamClient(), { wrapper });
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    // Nothing legitimate closes the served client without also replacing it;
    // if it happens anyway (the closed-client-in-context wedge), the liveness
    // guard must mint a fresh client instead of serving the dead one until a
    // window reload.
    act(() => {
      first?.close("test-external-close");
    });

    expect(first?.isClosed()).toBe(true);
    expect(result.current).toBeInstanceOf(WsStreamClient);
    expect(result.current).not.toBe(first);
    expect(result.current?.isClosed()).toBe(false);
  });

  it("nudges a re-dial exactly once under a StrictMode double-invoke", () => {
    const reconnectSpy = vi.spyOn(WsStreamClient.prototype, "reconnectAll");
    const hostClient = buildClient();
    bindingRef.value = { hostClient };
    act(() => {
      hostClient.bind(mockLocalHostEntry);
    });

    // StrictMode runs each effect setup -> cleanup -> setup on mount. The
    // ref-based dedup in `useReconnectStreamOnEndpointChange` must absorb the
    // double-invoke: a stable mount fires NO nudge, and a later same-host
    // endpoint change fires EXACTLY one - never a spurious or doubled re-dial.
    const strictWrapper = (props: {
      readonly children: ReactNode;
    }): ReactNode => (
      <StrictMode>
        <HostStreamProvider>{props.children}</HostStreamProvider>
      </StrictMode>
    );
    const { result } = renderHook(() => useWsStreamClient(), {
      wrapper: strictWrapper,
    });
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);
    expect(reconnectSpy).not.toHaveBeenCalled();

    act(() => {
      hostClient.bind({
        ...mockLocalHostEntry,
        websocketUrl: "ws://127.0.0.1:4918/rpc",
        status: "available",
      });
    });

    expect(result.current).toBe(first);
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    expect(reconnectSpy).toHaveBeenCalledWith("host-endpoint-change");
  });

  // R-1: the owner-layer discriminator the S1 cache test cannot provide (see
  // `active-remote-sessions.test.ts` "review finding #2" for the cache-layer
  // half). Drives the REAL production chain end to end - `HostClient.bind`'s
  // `sameHostTransport` check, this provider's `remoteAwareOwnerIdentity`
  // `identityKey`, and the shared `acquireRemoteSession` cache - so a
  // regression in any one of those layers fails this test.
  it("rebuilds and closes the client on a same-host remote public-key rotation, isolated from every other field", () => {
    const sessionForKeyA = fakeRemoteSession();
    const sessionForKeyB = fakeRemoteSession();
    mocks.createRemoteHostTransport.mockImplementation(
      (options: {
        readonly hostId: string;
        readonly userId: string;
        readonly relayAttachUrl: string;
        readonly hostPublicKey: string;
      }) => {
        const session = acquireRemoteSession(
          {
            hostId: options.hostId,
            userId: options.userId,
            hostPublicKey: options.hostPublicKey,
            relayAttachUrl: options.relayAttachUrl,
          },
          options.hostPublicKey === "pubkey-a"
            ? () => sessionForKeyA
            : () => sessionForKeyB,
        );
        return {
          session,
          messenger: new RemoteHostMessenger(session),
          streamClient: new RemoteStreamClient(session),
        };
      },
    );

    const hostClient = buildClient();
    bindingRef.value = { hostClient };
    act(() => {
      hostClient.bind(remoteTarget("pubkey-a"));
    });

    const { result } = renderHook(() => useWsStreamClient(), { wrapper });
    expect(result.current).toBeInstanceOf(RemoteStreamClient);
    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(1);
    expect(remoteSessionRefCountForTest(remoteIdentity("pubkey-a"))).toBe(1);
    expect(sessionForKeyA.closeCalls).toBe(0);

    // hostId / kind / websocketUrl / version / status all held stable - ONLY
    // the public key rotates (re-enrollment / corruption recovery). A
    // coincident URL/version move would mask the gap this test targets.
    act(() => {
      hostClient.bind(remoteTarget("pubkey-b"));
    });

    // The old owner closed...
    expect(sessionForKeyA.closeCalls).toBe(1);
    expect(remoteSessionRefCountForTest(remoteIdentity("pubkey-a"))).toBe(0);
    // ...and a FRESH one was acquired for the new key, not a resurrected
    // stale-key session.
    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(2);
    expect(remoteSessionRefCountForTest(remoteIdentity("pubkey-b"))).toBe(1);
    expect(sessionForKeyB.closeCalls).toBe(0);
  });
});
