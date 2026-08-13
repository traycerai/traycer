import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostListItemToDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type {
  HostConnectivity,
  HostListItem,
} from "@traycer/protocol/host/host-status";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";

// `useChatSessionHandle`'s own module state (the process-wide registry) is
// exercised for real below - only its collaborators are mocked, so the
// rotation drives the REAL `authenticatedOwnerIdentityKey` computation, not
// the `__setChatStreamClientFactoryForTests` test seam (which collapses BOTH
// `transportKey` and `ownerIdentityKey` to one hardcoded string, structurally
// unable to prove this discriminator - see `chat-tile.test.tsx`).
vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-1",
}));

const hostEntryRef = vi.hoisted((): { value: HostDirectoryEntry | null } => ({
  value: null,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => hostEntryRef.value,
}));

// `hostTransportKey` (reached through `authenticatedHostStreamKey`, exercised
// for real below) asks this for live-session evidence. Unmocked, no test in
// this file ever registers a real remote session, so it would always answer
// `false` - fine for the "no ready session" direction, but unable to prove
// the "a ready session survives a confirmed refusal" direction the single
// transport-survival rule also requires.
const readySessionHosts = vi.hoisted(() => ({ value: new Set<string>() }));
vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    return {
      ...actual,
      hasReadyRemoteSession: (hostId: string) =>
        readySessionHosts.value.has(hostId),
    };
  },
);

const globalClientRef = vi.hoisted(
  (): { value: HostClient<HostRpcRegistry> | null } => ({ value: null }),
);
const authServiceStub = vi.hoisted(() => ({
  revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
}));
vi.mock("@/lib/host", () => ({
  useHostClient: () => {
    if (globalClientRef.value === null) {
      throw new Error("test: globalClientRef not configured");
    }
    return globalClientRef.value;
  },
  useAuthService: () => authServiceStub,
}));

// The real `useDurableStreamTransportFactory` returns a referentially-STABLE
// opener (a `useCallback` with an empty dep array) - the acquire effect below
// depends on it, so a mock returning a FRESH closure on every render would
// re-run that effect every commit and loop forever (confirmed while building
// the sibling terminal-registry rotation test). `stableOpenTransport` is
// defined once, here, and indirects through the mutable ref so tests can
// still swap behavior per-case.
const openTransportRef = vi.hoisted(
  (): { fn: ((hostId: string) => DurableStreamTransport) | null } => ({
    fn: null,
  }),
);
const stableOpenTransport = vi.hoisted(() => {
  return (hostId: string) => {
    if (openTransportRef.fn === null) {
      throw new Error("test: openTransportRef not configured");
    }
    return openTransportRef.fn(hostId);
  };
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => stableOpenTransport,
}));

import { useChatSessionHandle } from "@/lib/registries/chat-session-registry";
import { disposeAllChatSessions } from "@/lib/registries/chat-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";

/** Matches `createRequestContextFixture`'s default identity. */
const FIXTURE_USER_ID = "user-fixture-1";
const RELAY_URL = "wss://relay.test/attach";
const REMOTE_HOST_ID = "chat-registry-remote-host";
const CHAT_PROFILE_USER_ID = "chat-test-user";

function remoteTarget(publicKey: string): RemoteHostDirectoryEntry {
  return {
    hostId: REMOTE_HOST_ID,
    label: REMOTE_HOST_ID,
    kind: "remote",
    // Every remote host shares one fixed relay attach URL - a rotation is a
    // same-URL event by construction, so this stays identical across A/B.
    websocketUrl: RELAY_URL,
    version: "1.0.0",
    transportDialability: "dialable",
    publicKey,
    relayFuseGrace: false,
    remoteStatus: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
  };
}

function buildGlobalClient(): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
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

function fakeStreamSession(): IStreamSession {
  return {
    sendClientFrame: () => undefined,
    onServerFrame: () => undefined,
    onStatusChange: () => undefined,
    // Never negotiates: this fake exercises no version-dependent path.
    getNegotiatedSchemaVersion: () => null,
    requestReconnect: () => undefined,
    close: () => undefined,
  };
}

function fakeWsStreamClient(): IHostStreamClient<HostStreamRpcRegistry> {
  return {
    subscribe: () => fakeStreamSession(),
    subscribeWithParamsProvider: () => {
      throw new Error("not exercised by this test");
    },
    close: () => undefined,
    isClosed: () => false,
    notifyBearerRotated: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId: "fake-stream-client",
  };
}

interface TrackedTransportRecord {
  readonly hostId: string;
  closeCount: number;
}

function createTrackedOpenTransport(): {
  readonly openTransport: (hostId: string) => DurableStreamTransport;
  readonly records: () => ReadonlyArray<TrackedTransportRecord>;
} {
  const records: TrackedTransportRecord[] = [];
  const openTransport = (hostId: string): DurableStreamTransport => {
    const record: TrackedTransportRecord = { hostId, closeCount: 0 };
    records.push(record);
    return {
      wsStreamClient: fakeWsStreamClient(),
      close: () => {
        record.closeCount += 1;
      },
    };
  };
  return { openTransport, records: () => records };
}

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

describe("useChatSessionHandle owner identity (R-1)", () => {
  afterEach(() => {
    cleanup();
    disposeAllChatSessions();
    hostEntryRef.value = null;
    globalClientRef.value = null;
    openTransportRef.fn = null;
    readySessionHosts.value = new Set();
    useAuthStore.setState({ profile: null, status: "signed-out" });
  });

  it("forces a release + reacquire on a same-host remote public-key rotation, isolated from every other field", async () => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: CHAT_PROFILE_USER_ID,
        userName: CHAT_PROFILE_USER_ID,
        email: `${CHAT_PROFILE_USER_ID}@example.com`,
      },
    });
    const tracked = createTrackedOpenTransport();
    openTransportRef.fn = tracked.openTransport;
    const globalClient = buildGlobalClient();
    expect(globalClient.getRequestContextUserId()).toBe(FIXTURE_USER_ID);
    globalClientRef.value = globalClient;
    hostEntryRef.value = remoteTarget("pubkey-a");

    const { result, rerender } = renderHook(
      () => useChatSessionHandle("chat-1", REMOTE_HOST_ID, true),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    const firstHandle = result.current;
    if (firstHandle === null) {
      throw new Error("expected initial handle");
    }
    expect(tracked.records()).toHaveLength(1);
    expect(tracked.records()[0].closeCount).toBe(0);

    // Same chatId/epicId/hostId, same signed-in user, same
    // websocketUrl/version/status - ONLY the remote host's public key rotates
    // (re-enrollment / corruption recovery). A pass proves `ownerIdentityKey`
    // alone (folded into `chatSessionScopeKey`) forces the registry's own
    // scope-key mismatch teardown, not a coincident host/user churn.
    hostEntryRef.value = remoteTarget("pubkey-b");
    rerender();

    await waitFor(() => {
      expect(result.current).not.toBe(firstHandle);
    });

    expect(tracked.records()).toHaveLength(2);
    expect(tracked.records()[0].closeCount).toBe(1);
    expect(tracked.records()[1].closeCount).toBe(0);
  });
});

/**
 * The P0's actual user-visible failure, composed end to end.
 *
 * The isolated tests all passed while this was broken, which is the point of
 * putting it here: the mapper collapsed `unknown` into a non-dialable entry,
 * `hostTransportKey` refused anything non-dialable, THIS registry released the
 * handle on the changed key, and `chat-tile` rendered `ChatTileLoading`
 * forever — while `useHostReachability` one layer up had just decided the same
 * host was reachable. Every layer was individually defensible.
 *
 * So the entry is built by the REAL mapper from a REAL registry row, and the
 * only thing that changes between the two renders is the cloud's connectivity
 * verdict. A synthetic literal would not do: it carries no `remoteStatus`, so
 * `hostUnavailability` falls to "offline" and the case under test cannot be
 * reached.
 */
describe("a live chat session survives a degraded liveness read", () => {
  afterEach(() => {
    cleanup();
    disposeAllChatSessions();
    hostEntryRef.value = null;
    globalClientRef.value = null;
    openTransportRef.fn = null;
    readySessionHosts.value = new Set();
    useAuthStore.setState({ profile: null, status: "signed-out" });
  });

  function mappedEntry(connectivity: HostConnectivity): HostDirectoryEntry {
    const item: HostListItem = {
      hostId: REMOTE_HOST_ID,
      displayName: REMOTE_HOST_ID,
      platform: "Ubuntu",
      kind: "personal",
      publicKey: "pubkey-a",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatePolicy: "manual",
      status: {
        connectivity,
        viewerReachability: "unknown",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.0.0",
        lastSeenAt: "2026-08-01T00:00:00.000Z",
      },
    };
    return hostListItemToDirectoryEntry(item, RELAY_URL);
  }

  it("keeps the same handle and never closes the transport when connectivity goes `unknown`", async () => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: CHAT_PROFILE_USER_ID,
        userName: CHAT_PROFILE_USER_ID,
        email: `${CHAT_PROFILE_USER_ID}@example.com`,
      },
    });
    const tracked = createTrackedOpenTransport();
    openTransportRef.fn = tracked.openTransport;
    globalClientRef.value = buildGlobalClient();
    hostEntryRef.value = mappedEntry("connectable");

    const { result, rerender } = renderHook(
      () => useChatSessionHandle("chat-unknown-1", REMOTE_HOST_ID, true),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    const liveHandle = result.current;
    expect(tracked.records()).toHaveLength(1);

    // Redis liveness reads go degraded on the cloud side. Nothing about this
    // machine, this socket, or this chat changed.
    hostEntryRef.value = mappedEntry("unknown");
    rerender();

    // Flush effects and microtasks before asserting survival: release is
    // asynchronous (the release test above needs `waitFor`), so a synchronous
    // read here would stay green even if a regression released the handle one
    // microtask after the rerender.
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(liveHandle);
    expect(tracked.records()).toHaveLength(1);
    expect(tracked.records()[0].closeCount).toBe(0);
  });

  it("still releases the handle when the cloud CONFIRMS the host is offline, and no ready session is open", async () => {
    // The other direction, so the test above cannot pass by the registry
    // having simply stopped reacting to the directory at all. `readySessionHosts`
    // is empty (default) here - see the counterpart below for the same
    // transition WITH a ready session open, which must survive instead.
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: CHAT_PROFILE_USER_ID,
        userName: CHAT_PROFILE_USER_ID,
        email: `${CHAT_PROFILE_USER_ID}@example.com`,
      },
    });
    const tracked = createTrackedOpenTransport();
    openTransportRef.fn = tracked.openTransport;
    globalClientRef.value = buildGlobalClient();
    hostEntryRef.value = mappedEntry("connectable");

    const { result, rerender } = renderHook(
      () => useChatSessionHandle("chat-offline-1", REMOTE_HOST_ID, true),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });

    hostEntryRef.value = mappedEntry("offline");
    rerender();

    // The handle is released. The transport itself is not asserted here: the
    // registry lingers it deliberately, so a close count is a statement about
    // the eviction timer rather than about this decision.
    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });

  it("keeps the handle when the cloud CONFIRMS the host is offline but a ready session is open", async () => {
    // The single transport-survival rule, from the registry's side: a ready
    // live session keeps the transport alive under ANY verdict, including a
    // confirmed `offline` refusal - confirmed refusals gate NEW dials only.
    // Without this the registry released the very handle the session was
    // still using (`use-host-reachability.test.tsx` pins the hook's side of
    // the same rule).
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: CHAT_PROFILE_USER_ID,
        userName: CHAT_PROFILE_USER_ID,
        email: `${CHAT_PROFILE_USER_ID}@example.com`,
      },
    });
    const tracked = createTrackedOpenTransport();
    openTransportRef.fn = tracked.openTransport;
    globalClientRef.value = buildGlobalClient();
    hostEntryRef.value = mappedEntry("connectable");
    readySessionHosts.value = new Set([REMOTE_HOST_ID]);

    const { result, rerender } = renderHook(
      () => useChatSessionHandle("chat-offline-live-1", REMOTE_HOST_ID, true),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    const liveHandle = result.current;

    hostEntryRef.value = mappedEntry("offline");
    rerender();

    // Flush effects and microtasks before asserting survival: release is
    // asynchronous (the release test above needs `waitFor`), so a synchronous
    // read here would stay green even if a regression released the handle one
    // microtask after the rerender.
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(liveHandle);
    expect(tracked.records()).toHaveLength(1);
    expect(tracked.records()[0].closeCount).toBe(0);
  });
});
