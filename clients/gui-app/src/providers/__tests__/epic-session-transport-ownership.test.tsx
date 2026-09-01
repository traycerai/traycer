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
const reprobeSpy = vi.hoisted(() => ({
  attachCalls: [] as unknown[],
  detachCount: 0,
  /**
   * The owner callbacks handed to `attachPlanRestrictedReprobe`, so a pin can
   * FIRE one - the deadline coming due is the whole stimulus.
   *
   * An array rather than a `(() => void) | null` slot, and not for style: a
   * pin resets the slot before mounting, and TypeScript's control flow then
   * narrows the property to `null` for the rest of the test - so reading it
   * back yields `null` and the guard that would recover it is a comparison
   * between literal values, which `no-unnecessary-condition` refuses. An
   * element read is not narrowed by the reset, and the repo's type rules
   * leave no cast to reach for.
   */
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
  /**
   * Every handle this mount has presented, in order - a GETTER because the
   * interesting ones arrive after this function returns. One caller: the
   * reprobe-rebuild pin, whose whole subject is the SECOND handle.
   */
  handles: () => ReadonlyArray<OpenEpicStoreHandle>;
}> {
  const seenHandles: OpenEpicStoreHandle[] = [];
  render(sessionBody(epicId, tabId, (handle) => seenHandles.push(handle)));
  await waitFor(() => {
    expect(seenHandles).toHaveLength(1);
  });
  const handle = seenHandles.at(0);
  if (handle === undefined) throw new Error("expected a handle");
  return { handle, handles: () => seenHandles };
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

  it("attaches a plan-restricted reprobe to THIS session's client, and detaches it with the transport", async () => {
    // Upstream gave every durable-transport owner a plan-denial reprobe by
    // adding a parameter to `openOwnedDurableStreamClient`. This session does
    // not use that helper - it multiplexes four typed clients over one socket,
    // so it opens its transport directly - which means the merge that brought
    // the feature in left it live for chat/terminal/worktree and silently
    // absent for epics. Reconnecting the closed client itself cannot acquire
    // the cache's controlled fresh session, so without this an epic denied by
    // plan stays denied until the tab is reloaded.
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
    // THE WIRE BETWEEN THE TWO HALVES, and pinned separately because neither
    // half can see it. The pin above proves the reprobe is SUBSCRIBED;
    // `store.test.ts`'s two arms prove the store's gate ANSWERS correctly.
    // What sits between them is the provider callback, and it fills
    // `reprobeHandle` AFTER subscribing - deliberately, since `onClosed` does
    // not retro-fire and a negative-cache adoption can hand back an
    // already-closed client. A slot left unfilled would leave both halves
    // green while a plan-denied epic stayed denied until the tab was
    // reloaded, which is exactly the absence this merge recovered.
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

    // A fresh session on a fresh transport. The denied one is RETIRED rather
    // than left beside its replacement: marking the handle dead is what lets
    // the acquire pass retire it, and without that mark the pass sees
    // `current.hostId === targetHostId` and re-presents the same closed
    // handle as `ready`.
    await waitFor(() => {
      expect(transportRegistry.records.length).toBeGreaterThan(1);
    });
    expect(first.closeCount).toBe(1);
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

  it("closes the transport when construction THROWS before a handle exists", async () => {
    // Every close in this suite so far runs off the handle - `dispose` and
    // `detachTransport` are the only two paths to `closeSessionTransport`, and
    // both are members of an object that construction has to finish producing.
    // So a synchronous throw between opening the transport and returning that
    // object leaked the socket with no reference anywhere that could close it:
    // it went on dialling `host-a` for the life of the window.
    //
    // `new Worker` refused by the runtime or a CSP is the reachable trigger -
    // it is the one call in that span that touches a browser primitive with
    // its own policy - but the leak is a property of the WINDOW, so the fix
    // and this pin are about the span rather than about the worker.
    const previousFactory = getEpicRuntimeWorkerFactoryOverride();
    __setEpicRuntimeWorkerFactoryForTests(() => {
      throw new Error("Worker construction blocked by the runtime");
    });
    try {
      // The throw travels out of the acquire effect. Swallowed HERE and not in
      // the provider: turning it into a caught, quiet failure would be a
      // different change, and this pin is about the socket, not the
      // presentation.
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
