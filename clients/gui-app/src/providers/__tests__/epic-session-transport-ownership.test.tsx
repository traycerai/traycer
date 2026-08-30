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
import {
  fakeDurableStreamTransports,
  resetFakeDurableStreamTransports,
} from "@/lib/host/test-support/fake-durable-stream-transport";

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
 * itself (counted here), never by a stream client.
 *
 * The fake was hand-rolled here, and the sibling `epic-session-provider.test.tsx`
 * had a stub that THREW instead - safe only because every one of its tests
 * overrode the stream factory and the provider short-circuited before the opener
 * ran. That override is gone, so every provider suite needs an opener that
 * ANSWERS, and they share this one rather than growing six copies of it. The
 * adapter-verdict reasoning that used to sit on `getMethodSupport` here moved
 * with it, to the member it describes.
 */
vi.mock("@/lib/host/use-durable-stream-transport", async () => {
  const { fakeDurableStreamTransports } =
    await import("@/lib/host/test-support/fake-durable-stream-transport");
  return {
    useDurableStreamTransportFactory: () =>
      fakeDurableStreamTransports().opener,
  };
});
// Resolved on THIS side of the mock boundary, and deliberately the same module:
// a `vi.mock` factory is hoisted above every import, so it cannot close over a
// value the test body holds. Both sides call the accessor instead.
const transportRegistry = fakeDurableStreamTransports();

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
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
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
    resetFakeDurableStreamTransports();
    resetHostConnectionRegistryForTest();
    navigateMock.mockClear();
    __getOpenEpicRegistryForTests().disposeAll();
    resetAuth("signed-in", "alice@example.com");
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
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

  // RETIRED AND REPLACED: this used to be "opens NOTHING when the stream
  // factory is overridden for tests". Its subject no longer exists - the
  // stream-factory override was deleted, because a factory built on MAIN
  // cannot cross `postMessage` to a runtime living in the worker, and the
  // provider branch serving it could only ever reach a throw.
  //
  // What replaces it is the property the deletion makes universal, and it is
  // the stronger claim: there is no longer ANY path that opens a session
  // without a transport, so "exactly one per session" holds unconditionally
  // rather than "one, unless a test said otherwise".
  it("opens exactly one transport per session, with no opt-out path", async () => {
    const { handle } = await mountSession(
      "epic-transport-test",
      "epic-transport-test",
    );

    expect(transportRegistry.records).toHaveLength(1);
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
