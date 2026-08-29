import { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";

// `attached` mirrors the sibling suite's shape even though every test here
// leaves it `true` - the hooks below are mocked identically so the provider
// never sees a difference between the two files.
const hostState = vi.hoisted((): { id: string | null; attached: boolean } => ({
  id: "host-a",
  attached: true,
}));
const authServiceStub = vi.hoisted(() => ({
  revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
}));
const navigateMock = vi.hoisted(() => vi.fn());
const hostBindingRef = vi.hoisted(
  (): {
    value: { readonly hostClient: unknown } | null;
  } => ({
    value: null,
  }),
);
const sessionHostRows = vi.hoisted(
  (): { byHostId: Map<string, unknown>; userId: string | null } => ({
    byHostId: new Map(),
    userId: null,
  }),
);
interface StubSessionHostClient {
  readonly request: Mock;
  readonly getActiveHost: () => unknown;
  readonly getActiveHostId: () => string;
  readonly getRequestContextUserId: () => string | null;
}
const sessionHostClients = vi.hoisted(
  (): { byHostId: Map<string, StubSessionHostClient> } => ({
    byHostId: new Map(),
  }),
);
const resolveSessionHostClient = vi.hoisted(
  () =>
    (hostId: string | null): unknown => {
      if (hostId === null) return null;
      const existing = sessionHostClients.byHostId.get(hostId);
      if (existing !== undefined) return existing;
      const created = {
        request: vi.fn(),
        getActiveHost: () => sessionHostRows.byHostId.get(hostId) ?? null,
        getActiveHostId: () => hostId,
        getRequestContextUserId: () => sessionHostRows.userId,
      };
      sessionHostClients.byHostId.set(hostId, created);
      return created;
    },
);

/**
 * Every `DurableStreamTransport` this suite's fake `openTransport` has ever
 * minted, in open order.
 *
 * THIS is the seam the whole file pins: the transport is opened by the fake
 * itself (counted here), never by a stream client - unlike the sibling
 * `epic-session-provider.test.tsx`, whose stub `openTransport` throws because
 * every one of its tests overrides the stream factory instead.
 */
interface FakeTransportRecord {
  readonly hostId: string;
  closeCount: number;
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
}
const transportRegistry = vi.hoisted(() => {
  const records: FakeTransportRecord[] = [];

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

  function createWsStreamClient(): IHostStreamClient<HostStreamRpcRegistry> {
    let closed = false;
    return {
      subscribe: () => fakeStreamSession(),
      subscribeWithParamsProvider: () => fakeStreamSession(),
      close: () => {
        closed = true;
      },
      isClosed: () => closed,
      isReady: () => true,
      getClosedReason: () => null,
      notifyBearerRotated: () => undefined,
      reconnectAll: () => undefined,
      // Every lane method reads "unsupported", which pins the adapter-selection
      // verdict to "legacy" (never "undecided", never "lanes") - see
      // `readEpicAdapterVerdict` / `EPIC_LANE_METHODS`. That is deliberate: it
      // is what makes the provider's real `@1` stream-client factory run for
      // real in this file, while the lane arm itself stays out of scope (owned
      // by `epic-adapter-{selection,lifecycle}.test.ts`).
      getMethodSupport: () => "unsupported",
      subscribeMethodSupport: () => () => undefined,
      getMethodSchemaVersion: () => null,
      instanceId: `fake-ws-stream-client-${records.length}`,
      subscribeAvailabilityRecovered: () => () => undefined,
      onClosed: () => () => undefined,
    };
  }

  function opener(hostId: string): DurableStreamTransport {
    const wsStreamClient = createWsStreamClient();
    const record: FakeTransportRecord = {
      hostId,
      closeCount: 0,
      wsStreamClient,
    };
    records.push(record);
    return {
      wsStreamClient,
      close: () => {
        record.closeCount += 1;
      },
    };
  }

  return { records, opener };
});

vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => transportRegistry.opener,
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => hostState.id,
}));

vi.mock("@/hooks/host/use-selection-authority-attached", () => ({
  useSelectionAuthorityAttached: () => hostState.attached,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    resolveSessionHostClient(hostId),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => hostBindingRef.value,
  useAuthService: () => authServiceStub,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

import { EpicSessionProvider } from "@/providers/epic-session-provider";
import {
  __getOpenEpicRegistryForTests,
  __setEpicStreamClientFactoryForTests,
} from "@/lib/registries/epic-session-registry";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

function resetAuth(
  status: "signed-out" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    useAuthStore.setState({
      status,
      profile: { userId: email, userName: email, email },
      contextMetadata: { userId: email, username: email },
    });
    return;
  }
  useAuthStore.setState({
    status,
    profile: null,
    contextMetadata: null,
  });
}

function HandleProbe(props: {
  onHandle: (handle: OpenEpicStoreHandle) => void;
}) {
  const { onHandle } = props;
  const handle = useMaybeOpenEpicHandle();
  useEffect(() => {
    if (handle === null) return;
    onHandle(handle);
  }, [handle, onHandle]);
  return (
    <div
      data-testid="handle-probe"
      data-ready={handle === null ? "false" : "true"}
    />
  );
}

function sessionBody(
  epicId: string,
  tabId: string,
  onHandle: (handle: OpenEpicStoreHandle) => void,
): React.JSX.Element {
  return (
    <EpicSessionProvider epicId={epicId} tabId={tabId}>
      <HandleProbe onHandle={onHandle} />
    </EpicSessionProvider>
  );
}

async function mountSession(
  epicId: string,
  tabId: string,
): Promise<{ handle: OpenEpicStoreHandle }> {
  const seenHandles: OpenEpicStoreHandle[] = [];
  render(sessionBody(epicId, tabId, (handle) => seenHandles.push(handle)));
  await waitFor(() => {
    expect(seenHandles).toHaveLength(1);
  });
  const handle = seenHandles.at(0);
  if (handle === undefined) throw new Error("expected a handle");
  return { handle };
}

describe("<EpicSessionProvider /> transport ownership", () => {
  beforeEach(() => {
    window.localStorage.clear();
    hostState.id = "host-a";
    hostState.attached = true;
    hostBindingRef.value = null;
    sessionHostRows.byHostId.clear();
    sessionHostRows.userId = null;
    sessionHostClients.byHostId.clear();
    transportRegistry.records.length = 0;
    resetHostConnectionRegistryForTest();
    navigateMock.mockClear();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    resetAuth("signed-in", "alice@example.com");
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    resetAuth("signed-out", null);
    hostBindingRef.value = null;
    resetHostConnectionRegistryForTest();
  });

  it("opens exactly ONE transport for the session, before and after the store builds its stream client", async () => {
    await mountSession("epic-transport-test", "epic-transport-test");

    // At acquisition: `createHandle` opens the transport BEFORE
    // `createOpenEpicStore` runs, so this is already true the instant the
    // handle escapes.
    expect(transportRegistry.records).toHaveLength(1);
    expect(transportRegistry.records[0]?.hostId).toBe("host-a");

    // A tick later, after the store's own construction-time adapter-selection
    // has run (`runtime.start()` synchronously reads `getMethodSupport` off
    // this same transport) - still exactly one.
    await act(() => Promise.resolve());
    expect(transportRegistry.records).toHaveLength(1);
  });

  it("does not close the transport when requestFreshSnapshot() closes and reopens a CLIENT, and the session stays usable", async () => {
    const { handle } = await mountSession(
      "epic-transport-test",
      "epic-transport-test",
    );
    expect(transportRegistry.records).toHaveLength(1);
    const record = transportRegistry.records.at(0);
    if (record === undefined) throw new Error("expected a transport record");

    act(() => {
      handle.requestFreshSnapshot();
    });

    // The socket the transport owns must survive a local reseed: only the
    // `@1` client this call discards and rebuilds may close, never the
    // transport underneath it.
    expect(record.closeCount).toBe(0);
    expect(transportRegistry.records).toHaveLength(1);

    // The session is still alive and driving the same store - not a husk left
    // behind by a socket that silently died.
    expect(() => handle.store.getState()).not.toThrow();
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);
  });

  it("dispose() closes the session transport exactly once", async () => {
    const { handle } = await mountSession(
      "epic-transport-test",
      "epic-transport-test",
    );
    const record = transportRegistry.records.at(0);
    if (record === undefined) throw new Error("expected a transport record");
    expect(record.closeCount).toBe(0);

    act(() => {
      handle.dispose();
    });
    expect(record.closeCount).toBe(1);

    // Idempotent on its own: a second dispose (e.g. a duplicate teardown path)
    // must not double-close the socket.
    act(() => {
      handle.dispose();
    });
    expect(record.closeCount).toBe(1);
  });

  it("detachTransport() closes the session transport too", async () => {
    const { handle } = await mountSession(
      "epic-transport-test",
      "epic-transport-test",
    );
    const record = transportRegistry.records.at(0);
    if (record === undefined) throw new Error("expected a transport record");
    expect(record.closeCount).toBe(0);

    act(() => {
      handle.detachTransport();
    });
    expect(record.closeCount).toBe(1);
  });

  it("dispose() and detachTransport() close the transport only ONCE, in either order", async () => {
    const first = await mountSession(
      "epic-transport-test-a",
      "epic-transport-test-a",
    );
    const firstRecord = transportRegistry.records.at(0);
    if (firstRecord === undefined) throw new Error("expected a record");
    act(() => {
      first.handle.dispose();
      first.handle.detachTransport();
    });
    expect(firstRecord.closeCount).toBe(1);

    const second = await mountSession(
      "epic-transport-test-b",
      "epic-transport-test-b",
    );
    const secondRecord = transportRegistry.records.at(1);
    if (secondRecord === undefined) throw new Error("expected a record");
    act(() => {
      second.handle.detachTransport();
      second.handle.dispose();
    });
    expect(secondRecord.closeCount).toBe(1);
  });

  it("opens NOTHING when the stream factory is overridden for tests", async () => {
    __setEpicStreamClientFactoryForTests(() => ({
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    }));

    const { handle } = await mountSession(
      "epic-transport-test",
      "epic-transport-test",
    );

    // The override IS "a test is supplying this session's stream" - the
    // session opens no socket at all, which is exactly what lets the sibling
    // suite's stub `openTransport` throw on every one of its tests.
    expect(transportRegistry.records).toHaveLength(0);
    expect(() => handle.store.getState()).not.toThrow();
  });

  it("a revived session (dispose, then reacquire) gets a FRESH transport, never the disposed one", async () => {
    // Sign-in identity change is a security boundary: the provider discards
    // the previous session (`registry.release(..., "discard", ...)`, which
    // disposes it - the sibling suite pins the resulting CLIENT close under
    // this exact flow) and acquires a brand-new one for the new user, on the
    // SAME still-mounted provider. No unmount/remount needed to revive it.
    const seenHandles: OpenEpicStoreHandle[] = [];
    render(
      sessionBody("epic-transport-test", "epic-transport-test", (handle) => {
        seenHandles.push(handle);
      }),
    );
    await waitFor(() => {
      expect(seenHandles).toHaveLength(1);
    });
    expect(transportRegistry.records).toHaveLength(1);
    const firstHandle = seenHandles.at(0);
    const firstRecord = transportRegistry.records.at(0);
    if (firstHandle === undefined || firstRecord === undefined) {
      throw new Error("expected an initial handle and transport record");
    }

    act(() => {
      resetAuth("signed-in", "bob@example.com");
    });

    await waitFor(() => {
      expect(seenHandles.at(-1)).not.toBe(firstHandle);
    });

    expect(transportRegistry.records).toHaveLength(2);
    expect(firstRecord.closeCount).toBe(1);
    const secondRecord = transportRegistry.records.at(1);
    if (secondRecord === undefined) throw new Error("expected a record");
    // A DISTINCT instance, not the disposed transport handed back to the new
    // session.
    expect(secondRecord.wsStreamClient).not.toBe(firstRecord.wsStreamClient);
  });
});
