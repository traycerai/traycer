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
 * Transports this suite's fake `openTransport` minted, in open order. The transport is opened by the fake itself, never by a stream client.
 */
const reprobeSpy = vi.hoisted(() => ({
  attachCalls: [] as unknown[],
  detachCount: 0,
  /** Owner callbacks as an array: a pin reset would narrow a scalar slot to null for the rest of the test. */
  fireCallbacks: [] as Array<() => void>,
}));
vi.mock("@/lib/host/owned-durable-stream-client", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/host/owned-durable-stream-client")
    >();
  return {
    ...actual,
    attachPlanRestrictedReprobe: (
      wsStreamClient: unknown,
      onReprobe: (() => void) | null,
    ) => {
      reprobeSpy.attachCalls.push(wsStreamClient);
      if (onReprobe !== null) reprobeSpy.fireCallbacks.push(onReprobe);
      return () => {
        reprobeSpy.detachCount += 1;
      };
    },
  };
});
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
import {
  __setEpicRuntimeWorkerFactoryForTests,
  getEpicRuntimeWorkerFactoryOverride,
} from "@/lib/registries/epic-runtime-worker-factory-slot";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
} from "@/stores/agent-activity-store";
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
): Promise<{
  handle: OpenEpicStoreHandle;
  unmount: () => void;
  /** Presented handles in order, as a getter: the interesting one is the second, after this function returns. */
  handles: () => ReadonlyArray<OpenEpicStoreHandle>;
}> {
  const seenHandles: OpenEpicStoreHandle[] = [];
  const rendered = render(
    sessionBody(epicId, tabId, (handle) => seenHandles.push(handle)),
  );
  await waitFor(() => {
    expect(seenHandles).toHaveLength(1);
  });
  const handle = seenHandles.at(0);
  if (handle === undefined) throw new Error("expected a handle");
  return {
    handle,
    handles: () => seenHandles,
    unmount: () => {
      rendered.unmount();
    },
  };
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
    // Busy gate fails closed while the plane is connecting. The prune case
    // needs the plane answering; no Epic here has working agents.
    __setAgentActivityPlaneAnsweringForTests();
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    resetAuth("signed-out", null);
    hostBindingRef.value = null;
    resetHostConnectionRegistryForTest();
    __resetAgentActivityStoreForTests();
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
    expect(record.closeReasons).toEqual(["durable-transport-closed:tab-close"]);
    expect(record.wsStreamClient.getClosedReason()).toBe(
      "durable-transport-closed:tab-close",
    );

    // Idempotent on its own: a second dispose (e.g. a duplicate teardown path)
    // must not double-close the socket.
    act(() => {
      handle.dispose();
    });
    expect(record.closeCount).toBe(1);
  });

  it("attributes MRU prune teardown to prune", async () => {
    // Unmount each provider so its clean session becomes WARM rather than
    // remaining mounted (mounted entries are not prune candidates). The sixth
    // acquisition exceeds the five-entry cap and prunes the oldest transport.
    const leaveWarm = async (epicId: string): Promise<void> => {
      const mounted = await mountSession(epicId, epicId);
      act(() => {
        mounted.handle.store.setState({
          snapshotLoaded: true,
          isDirty: false,
          hostTransportStatus: "open",
        });
      });
      mounted.unmount();
    };
    await leaveWarm("epic-prune-1");
    await leaveWarm("epic-prune-2");
    await leaveWarm("epic-prune-3");
    await leaveWarm("epic-prune-4");
    await leaveWarm("epic-prune-5");
    await mountSession("epic-prune-6", "epic-prune-6");

    const oldest = transportRegistry.records.at(0);
    if (oldest === undefined) throw new Error("expected oldest transport");
    expect(oldest.closeReasons).toEqual(["durable-transport-closed:prune"]);
  });

  it("attaches a plan-restricted reprobe to THIS session's client, and detaches it with the transport", async () => {
    // Epic opens its transport directly (not openOwnedDurableStreamClient), so
    // plan-denial reprobe must be wired here or a denied epic stays denied until reload.
    reprobeSpy.attachCalls.length = 0;
    reprobeSpy.detachCount = 0;

    const { handle } = await mountSession(
      "epic-transport-test",
      "epic-transport-test",
    );
    const record = transportRegistry.records.at(0);
    if (record === undefined) throw new Error("expected a transport record");

    // Attached to the SESSION's own client, not some other transport's.
    expect(reprobeSpy.attachCalls).toEqual([record.wsStreamClient]);
    expect(reprobeSpy.detachCount).toBe(0);

    act(() => {
      handle.dispose();
    });
    // Detached with the transport, so a pending rebuild timer cannot outlive
    // the socket it exists to rebuild.
    expect(reprobeSpy.detachCount).toBe(1);
  });

  it("rebuilds the session when the attached reprobe fires on a clean epic", async () => {
    // Fill reprobeHandle after subscribe: onClosed does not retro-fire, and a
    // negative-cache adoption can return an already-closed client.
    reprobeSpy.attachCalls.length = 0;
    reprobeSpy.detachCount = 0;
    reprobeSpy.fireCallbacks.length = 0;

    const { handles } = await mountSession(
      "epic-transport-test",
      "epic-transport-test",
    );
    expect(transportRegistry.records).toHaveLength(1);
    const first = transportRegistry.records.at(0);
    if (first === undefined) throw new Error("expected a transport record");
    const fire = reprobeSpy.fireCallbacks.at(0);
    if (fire === undefined)
      throw new Error("expected the reprobe to be attached");

    await act(async () => {
      fire();
      await Promise.resolve();
    });

    // Mark the denied handle dead so acquire retires it. Without that mark
    // it re-presents the closed handle as ready.
    await waitFor(() => {
      expect(transportRegistry.records.length).toBeGreaterThan(1);
    });
    expect(first.closeCount).toBe(1);
    expect(first.closeReasons).toEqual([
      "durable-transport-closed:retry-rebuild",
    ]);
    expect(handles().length).toBeGreaterThan(1);
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
    expect(record.closeReasons).toEqual(["durable-transport-closed:repoint"]);
  });

  it("attributes a host re-point candidate teardown to repoint", async () => {
    const seenHandles: OpenEpicStoreHandle[] = [];
    const rendered = render(
      sessionBody("epic-repoint-reason", "epic-repoint-reason", (handle) => {
        seenHandles.push(handle);
      }),
    );
    await waitFor(() => {
      expect(seenHandles).toHaveLength(1);
    });

    hostState.id = "host-b";
    act(() => {
      rendered.rerender(
        sessionBody("epic-repoint-reason", "epic-repoint-reason", (handle) => {
          seenHandles.push(handle);
        }),
      );
    });

    await waitFor(() => {
      expect(transportRegistry.records.length).toBeGreaterThan(1);
    });
    const candidate = transportRegistry.records.at(1);
    if (candidate === undefined) throw new Error("expected repoint candidate");

    // Discarded candidate's close must retain the product trigger even if the
    // provider unmounts before snapshot commit.
    rendered.unmount();
    await waitFor(() => {
      expect(candidate.closeReasons).toEqual([
        "durable-transport-closed:repoint",
      ]);
    });
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

  // No path opens a session without a transport. The stream-factory override
  // was deleted because a main-thread factory cannot postMessage to the worker.
  it("opens exactly one transport per session, with no opt-out path", async () => {
    const { handle } = await mountSession(
      "epic-transport-test",
      "epic-transport-test",
    );

    expect(transportRegistry.records).toHaveLength(1);
    expect(() => handle.store.getState()).not.toThrow();
  });

  it("a revived session (dispose, then reacquire) gets a FRESH transport, never the disposed one", async () => {
    // Identity change discards the previous session and acquires a new one on
    // the still-mounted provider. No remount.
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

  it("closes the transport when construction THROWS before a handle exists", async () => {
    // A throw between opening the transport and returning the handle leaks the
    // socket; close must cover that span, not only dispose/detach.
    const previousFactory = getEpicRuntimeWorkerFactoryOverride();
    __setEpicRuntimeWorkerFactoryForTests(() => {
      throw new Error("Worker construction blocked by the runtime");
    });
    try {
      // Swallow the throw here, not in the provider. This pin is the socket,
      // not the presentation.
      try {
        render(
          sessionBody("epic-worker-throws", "epic-worker-throws", () => {}),
        );
      } catch {
        // Expected - construction failed, which is the premise.
      }

      // The transport WAS opened: this pin is only meaningful if the leak
      // window was actually entered.
      await waitFor(() => {
        expect(transportRegistry.records).toHaveLength(1);
      });
      // THE REDDENING ASSERTION - previously 0, with no handle in existence to
      // ever make it 1.
      expect(transportRegistry.records[0]?.closeCount).toBe(1);
      // ...and nothing was registered, so no later pass can find a handle to
      // close it either. That is what made the leak permanent.
      expect(__getOpenEpicRegistryForTests().size()).toBe(0);
    } finally {
      __setEpicRuntimeWorkerFactoryForTests(previousFactory);
    }
  });
});
