import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  ListTaskLight,
  ListTasksRequest,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * R1 - a COLD unverified tab obtains a pin reading.
 *
 * The defect: pin state for the tab strip came only from
 * `epic.getTaskContexts`, which is gated on the cloud verdict, so an
 * `unverified` session got no answer at all - and since `epic.setPinned@1.1`
 * made a local-homed row pinnable, "no answer" became a rendered "Pin" for an
 * epic that may already be pinned, inverted by the click.
 *
 * **This probe drives the REAL fetch path.** The first version of this file
 * mocked `fetchCloudEpicTasksFirstPageByHostId`, and that is exactly why it was
 * green over two runtime failures a real dispatch hits:
 *
 *  1. the reading dispatched with `localFirstPhase: undefined`, which
 *     `cloudLegAdmittedAtDispatch` REFUSES outright under an unverified verdict
 *     (a page with no local-first directive is an ordinary cloud call) - so the
 *     one cohort this query exists for got no RPC at all;
 *  2. nothing registered the OWNING host's client in the list module's
 *     by-host-id registry, so even a verified fetch rejected with
 *     `No host client registered for <owner>` before touching a transport.
 *
 * So the seam moved DOWN: the fake here is the host client itself (the
 * transport), reached through a `useHostBinding` whose `createRequesterForHostId`
 * answers for the owner. Everything above it is real - the registry, the
 * admission, the request construction, the version floor, `useQueries` +
 * `combine`, and the overlay.
 */

const EPIC_LOCAL = "epic-local";
const EPIC_CLOUD = "epic-cloud";
const OWNER_HOST_ID = "host-owner";
const WINDOW_HOST_ID = "host-window";
const USER_ID = "user-1";

interface DispatchedRequest {
  readonly params: ListTasksRequest;
  readonly withVersionFloor: boolean;
}

const registryState = vi.hoisted(() => {
  const state: {
    localHomedEpicIds: ReadonlySet<string>;
    localHomedByHost: ReadonlyMap<string, string>;
  } = { localHomedEpicIds: new Set(), localHomedByHost: new Map() };
  return state;
});

const transport = vi.hoisted(() => {
  const state: {
    dispatched: Array<{
      hostId: string;
      params: unknown;
      withVersionFloor: boolean;
    }>;
    responseByHostId: Map<string, unknown>;
    /** Host ids the binding is willing to build a requester for. */
    resolvableHostIds: Set<string>;
    /**
     * The request-context user each host's client currently reports. A host whose
     * session is registered before its context arrives reports `null` here, which
     * is the readiness window the `"wait"` policy exists for.
     */
    contextUserByHostId: Map<string, string | null>;
    listenersByHostId: Map<string, Set<() => void>>;
    /** `epic.setPinned` dispatches, so Undo can be shown to reach the owner. */
    mutations: Array<{ hostId: string; params: unknown }>;
  } = {
    dispatched: [],
    responseByHostId: new Map(),
    resolvableHostIds: new Set(),
    contextUserByHostId: new Map(),
    listenersByHostId: new Map(),
    mutations: [],
  };
  return state;
});

vi.mock("@/lib/registries/epic-session-registry", () => ({
  useLocalHomedOpenEpicIds: () => registryState.localHomedEpicIds,
  useLocalHomedOpenEpicHostIds: () => registryState.localHomedByHost,
}));

// The cloud batch. Under an unverified session the hook must not dispatch it at
// all; this records whether it was enabled so the probe can assert that too.
const hostQueriesCalls: Array<{ enabled: boolean }> = [];

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: { options: { enabled: boolean } }) => {
    hostQueriesCalls.push({ enabled: args.options.enabled });
    return new Map();
  },
}));

/** Publishes a host's request-context user and notifies its `onChange` watchers. */
function arriveRequestContext(hostId: string, userId: string | null): void {
  transport.contextUserByHostId.set(hostId, userId);
  for (const listener of transport.listenersByHostId.get(hostId) ?? []) {
    listener();
  }
}

function makeClient(hostId: string) {
  return {
    getActiveHostId: () => hostId,
    getRequestContextUserId: () =>
      transport.contextUserByHostId.has(hostId)
        ? (transport.contextUserByHostId.get(hostId) ?? null)
        : USER_ID,
    onChange: (listener: () => void) => {
      const listeners =
        transport.listenersByHostId.get(hostId) ?? new Set<() => void>();
      listeners.add(listener);
      transport.listenersByHostId.set(hostId, listeners);
      return () => {
        listeners.delete(listener);
      };
    },
    requestWithSignal: (_method: string, params: unknown) => {
      transport.dispatched.push({ hostId, params, withVersionFloor: false });
      return Promise.resolve(transport.responseByHostId.get(hostId));
    },
    // The real `useHostMutation` dispatches here when no version requirement is
    // attached, which is the case for `epic.setPinned`.
    //
    // The fake WRITES THROUGH to its own list response, because a host that
    // accepts `pinned: false` and then still lists `true` is not a host - and an
    // unfaithful double here produces a confusing failure rather than a finding:
    // the optimistic patch lands, `onSuccess` invalidates, the refetch re-reads
    // the stale lie, and the test looks like the enrolment is broken when what is
    // broken is the double.
    request: (_method: string, params: unknown) => {
      const { epicId, pinned } = params as { epicId: string; pinned: boolean };
      transport.mutations.push({ hostId, params });
      const current = transport.responseByHostId.get(hostId);
      if (current !== undefined) {
        const response = current as ListTasksResponse;
        transport.responseByHostId.set(hostId, {
          ...response,
          tasks: response.tasks.map((task) =>
            task.epic?.light?.id === epicId ? { ...task, pinned } : task,
          ),
        });
      }
      return Promise.resolve({ pinned });
    },
    requestWithSignalRequiringHostMethodVersion: (
      _method: string,
      params: unknown,
    ) => {
      transport.dispatched.push({ hostId, params, withVersionFloor: true });
      return Promise.resolve(transport.responseByHostId.get(hostId));
    },
  };
}

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useHostClient: () => makeClient(WINDOW_HOST_ID),
    useHostBinding: () => ({
      hostId: WINDOW_HOST_ID,
      hostClient: {
        ...makeClient(WINDOW_HOST_ID),
        // The binding resolves a requester per host id - and refuses the ones
        // this case says are not resolvable, which is how "only the owner is
        // reachable" and "the owner is NOT reachable" are both expressible.
        createRequesterForHostId: (hostId: string) =>
          transport.resolvableHostIds.has(hostId) ? makeClient(hostId) : null,
      },
    }),
  };
});

import { useEpicTaskPinnedStates } from "@/hooks/epic/use-epic-task-pinned-states-query";
import { useEpicSetPinned } from "@/hooks/epic/use-epic-set-pinned-mutation";
import { __resetCloudEpicTasksClientsForTests } from "@/lib/cloud-epic-tasks-query";
import { useAuthStore } from "@/stores/auth/auth-store";

const PROFILE = { userId: USER_ID, userName: "U", email: "u@example.com" };
const CONTEXT = { userId: USER_ID, username: "U" };

function localRow(epicId: string, pinned: boolean): ListTaskLight {
  return {
    epic: {
      light: {
        id: epicId,
        title: epicId,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: 0,
        updatedAt: 0,
        createdBy: USER_ID,
        version: "1.0.0",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    pinned,
    home: "local",
  };
}

function page(tasks: readonly ListTaskLight[]): ListTasksResponse {
  return { tasks: [...tasks], hasMore: false };
}

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function renderPinnedStates(epicIds: ReadonlyArray<string>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(() => useEpicTaskPinnedStates(epicIds), {
    wrapper: makeWrapper(queryClient),
  });
}

function ownerDispatches(): ReadonlyArray<DispatchedRequest> {
  return transport.dispatched
    .filter((call) => call.hostId === OWNER_HOST_ID)
    .map((call) => ({
      params: call.params as ListTasksRequest,
      withVersionFloor: call.withVersionFloor,
    }));
}

/**
 * R7's Undo, through the REAL reading query.
 *
 * The tab strip's Undo coverage runs against a mocked mutation, which can show
 * the host riding the toast closure but not that the rendered pin follows the
 * write. This renders the reading hook and `useEpicSetPinned` over ONE
 * QueryClient and drives the real mutation twice - the write, then its inverse -
 * so the claim is end to end: real list read, real key, real shared patch, real
 * overlay, and a real `epic.setPinned` dispatch reaching the owner both times.
 */
describe("the pin write and its Undo reach the real reading", () => {
  function renderBoth(epicIds: ReadonlyArray<string>) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return renderHook(
      () => ({
        readings: useEpicTaskPinnedStates(epicIds),
        pin: useEpicSetPinned(),
      }),
      { wrapper: makeWrapper(queryClient) },
    );
  }

  beforeEach(() => {
    hostQueriesCalls.length = 0;
    transport.dispatched.length = 0;
    transport.mutations.length = 0;
    transport.responseByHostId.clear();
    transport.resolvableHostIds.clear();
    transport.contextUserByHostId.clear();
    transport.listenersByHostId.clear();
    __resetCloudEpicTasksClientsForTests();
    transport.resolvableHostIds.add(OWNER_HOST_ID);
    transport.responseByHostId.set(
      OWNER_HOST_ID,
      page([localRow(EPIC_LOCAL, true)]),
    );
    registryState.localHomedEpicIds = new Set([EPIC_LOCAL]);
    registryState.localHomedByHost = new Map([[EPIC_LOCAL, OWNER_HOST_ID]]);
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
  });

  it("unpins, then Undo restores the reading - both reaching the owner", async () => {
    const { result } = renderBoth([EPIC_LOCAL]);

    // The host says pinned; that is what the strip renders.
    await waitFor(() => {
      expect(result.current.readings.get(EPIC_LOCAL)?.pinnedKnown).toBe(true);
    });
    expect(result.current.readings.get(EPIC_LOCAL)?.pinned).toBe(true);

    const variables = {
      epicId: EPIC_LOCAL,
      pinned: false,
      isLocalHome: true,
      hostId: OWNER_HOST_ID,
    };

    // The unpin. Before the cache enrolment this left the rendered pin at `true`
    // after a SUCCESSFUL write, offering Unpin again indefinitely.
    await act(async () => {
      result.current.pin.mutate(variables);
    });
    await waitFor(() => {
      expect(result.current.readings.get(EPIC_LOCAL)?.pinned).toBe(false);
    });

    // ...and Undo, which is the same dispatch with the bit inverted, carrying
    // the host in its own variables because the row may be gone by then.
    await act(async () => {
      result.current.pin.mutate({ ...variables, pinned: true });
    });
    await waitFor(() => {
      expect(result.current.readings.get(EPIC_LOCAL)?.pinned).toBe(true);
    });

    // Both writes went to the OWNER, and carried the bit they claimed.
    expect(transport.mutations.map((m) => m.hostId)).toEqual([
      OWNER_HOST_ID,
      OWNER_HOST_ID,
    ]);
    expect(
      transport.mutations.map((m) => (m.params as { pinned: boolean }).pinned),
    ).toEqual([false, true]);
  });
});

describe("useEpicTaskPinnedStates - the unverified pin reading (R1)", () => {
  beforeEach(() => {
    hostQueriesCalls.length = 0;
    transport.dispatched.length = 0;
    transport.responseByHostId.clear();
    transport.resolvableHostIds.clear();
    transport.contextUserByHostId.clear();
    transport.listenersByHostId.clear();
    transport.mutations.length = 0;
    // The by-host-id client registry is MODULE-global, so a registration from an
    // earlier case outlives it - which silently made the "owner not reachable"
    // control below dispatch anyway the first time it was written.
    __resetCloudEpicTasksClientsForTests();
    // Only the OWNER is resolvable. The window's host is deliberately NOT
    // registered for the reading path, so a dispatch that fell back to it would
    // reject rather than quietly answering from the wrong machine.
    transport.resolvableHostIds.add(OWNER_HOST_ID);
    transport.responseByHostId.set(
      OWNER_HOST_ID,
      page([localRow(EPIC_LOCAL, true)]),
    );
    registryState.localHomedEpicIds = new Set([EPIC_LOCAL]);
    registryState.localHomedByHost = new Map([[EPIC_LOCAL, OWNER_HOST_ID]]);
    // `contextMetadata.userId` is present under BOTH statuses - it admits the
    // local plane and is deliberately not the spend gate.
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
  });

  afterEach(() => {
    // EXPLICIT, because this project runs vitest with `globals: false` - RTL's
    // automatic cleanup never registers, so without this every earlier case's
    // hook stays mounted and keeps re-rendering into later ones. That is not
    // hypothetical here: the un-unmounted trees re-ran this hook's render-time
    // client registration and produced a dispatch in the one case asserting
    // there could be none.
    cleanup();
    useAuthStore.getState().setSignedOut();
  });

  it("dispatches to the OWNER with the local-first directive and the version floor", async () => {
    useAuthStore.setState({ status: "unverified" });

    const { result } = renderPinnedStates([EPIC_LOCAL]);

    await waitFor(() => {
      expect(result.current.get(EPIC_LOCAL)?.pinnedKnown).toBe(true);
    });
    expect(result.current.get(EPIC_LOCAL)).toEqual({
      pinned: true,
      home: "local",
      hostId: OWNER_HOST_ID,
      pinnedKnown: true,
    });

    const dispatches = ownerDispatches();
    expect(dispatches).toHaveLength(1);
    // R1 failure 1: `undefined` here is REFUSED before any transport call, so a
    // reading that does not carry the directive never reaches the host at all.
    expect(dispatches[0]?.params.localFirstPhase).toBe("initial");
    // ...and an unverified dispatch must carry the `@1.6` floor, so a host that
    // restarted below it refuses rather than running the released cloud list on
    // a retained credential.
    expect(dispatches[0]?.withVersionFloor).toBe(true);
    expect(dispatches[0]?.params.cursor).toBeUndefined();
    // Nothing went to the window's host.
    expect(transport.dispatched.every((c) => c.hostId === OWNER_HOST_ID)).toBe(
      true,
    );
    // And the cloud batch stayed shut throughout.
    expect(hostQueriesCalls.every((call) => !call.enabled)).toBe(true);
  });

  it("resolves with ONLY the owner's client reachable - R1 failure 2", async () => {
    useAuthStore.setState({ status: "unverified" });

    // `beforeEach` made the owner the only resolvable host. Before the fix
    // nothing registered it at all, and the fetch rejected with
    // `No host client registered for host-owner` without dispatching.
    const { result } = renderPinnedStates([EPIC_LOCAL]);

    await waitFor(() => {
      expect(result.current.get(EPIC_LOCAL)?.pinnedKnown).toBe(true);
    });
    expect(ownerDispatches()).toHaveLength(1);
  });

  it("stays unknown when the owner's client cannot be resolved", async () => {
    useAuthStore.setState({ status: "unverified" });
    // The negative of the row above, so that row cannot pass by the registry
    // being populated some other way: with no resolvable owner there is no
    // dispatch and no reading, and `pinnedKnown` stays false.
    transport.resolvableHostIds.clear();

    const { result } = renderPinnedStates([EPIC_LOCAL]);

    await waitFor(() => {
      expect(result.current.get(EPIC_LOCAL)?.home).toBe("local");
    });
    expect(ownerDispatches()).toHaveLength(0);
    expect(result.current.get(EPIC_LOCAL)?.pinnedKnown).toBe(false);
  });

  /**
   * READINESS. The owning host's session can be registered before that host's
   * client has a request context - the window `useCloudEpicTasksQuery` covers
   * with `useReactiveHostReadiness`, which a per-host fan-out cannot call.
   *
   * Under `requestContextPolicy: "require-current"` that moment is fatal and
   * permanently so: the dispatch throws, TanStack exhausts its retries, and with
   * `staleTime: Infinity` and no refetch trigger a context that arrives later is
   * never read at all. `"wait"` waits for it instead.
   */
  it("waits for a request context that arrives after the query starts", async () => {
    useAuthStore.setState({ status: "unverified" });
    // The owner is resolvable, but has no context yet.
    arriveRequestContext(OWNER_HOST_ID, null);

    const { result } = renderPinnedStates([EPIC_LOCAL]);

    // Nothing dispatched while the context is absent - and nothing failed,
    // which is the whole point: it is still waiting.
    await waitFor(() => {
      expect(result.current.get(EPIC_LOCAL)?.home).toBe("local");
    });
    expect(ownerDispatches()).toHaveLength(0);
    expect(result.current.get(EPIC_LOCAL)?.pinnedKnown).toBe(false);

    // ...then it arrives, as it does on a cold start.
    arriveRequestContext(OWNER_HOST_ID, USER_ID);

    await waitFor(() => {
      expect(result.current.get(EPIC_LOCAL)?.pinnedKnown).toBe(true);
    });
    expect(result.current.get(EPIC_LOCAL)?.pinned).toBe(true);
    expect(ownerDispatches()).toHaveLength(1);
  });

  /**
   * The positive control for the policy change: `"wait"` did NOT weaken the
   * principal rule. `require-current`'s own doc names the hazard it exists for -
   * a cache-owned read must not "wait across an A -> B transition and then write
   * B's page under A's infinite-lifetime cache key".
   *
   * GREEN AT HEAD AND GREEN UNDER THE `require-current` ABLATION, deliberately:
   * that is what makes it a control rather than a second readiness test. The
   * hazard is structurally excluded under both policies, because
   * `waitForMatchingRequestContext` resolves only for `expectedUserId` - this
   * query's own user, never whoever arrives - and the post-wait dispatch
   * re-checks the principal anyway.
   */
  it("refuses a context that arrives for a DIFFERENT user - green under both policies", async () => {
    useAuthStore.setState({ status: "unverified" });
    arriveRequestContext(OWNER_HOST_ID, null);

    const { result } = renderPinnedStates([EPIC_LOCAL]);

    await waitFor(() => {
      expect(result.current.get(EPIC_LOCAL)?.home).toBe("local");
    });

    // Another account's context lands on the owning host.
    arriveRequestContext(OWNER_HOST_ID, "user-someone-else");

    // The wait is not satisfied by it, and nothing is written under this user's
    // key. Asserted after flushing the microtasks an onChange would have used.
    await Promise.resolve();
    expect(ownerDispatches()).toHaveLength(0);
    expect(result.current.get(EPIC_LOCAL)?.pinnedKnown).toBe(false);
    expect(result.current.get(EPIC_LOCAL)?.pinned).toBe(false);
  });

  it("reads an UNPINNED local row as a real `false`, not as filler", async () => {
    useAuthStore.setState({ status: "unverified" });
    transport.responseByHostId.set(
      OWNER_HOST_ID,
      page([localRow(EPIC_LOCAL, false)]),
    );

    const { result } = renderPinnedStates([EPIC_LOCAL]);

    await waitFor(() => {
      expect(result.current.get(EPIC_LOCAL)?.pinnedKnown).toBe(true);
    });
    expect(result.current.get(EPIC_LOCAL)?.pinned).toBe(false);
  });

  it("control - the same read works for a verified session", async () => {
    const { result } = renderPinnedStates([EPIC_LOCAL]);

    await waitFor(() => {
      expect(result.current.get(EPIC_LOCAL)?.pinnedKnown).toBe(true);
    });
    expect(result.current.get(EPIC_LOCAL)?.pinned).toBe(true);
    // A verified dispatch is `authorized`, so it needs no floor - the directive
    // still rides along, which is what keeps one code path for both verdicts.
    expect(ownerDispatches()[0]?.withVersionFloor).toBe(false);
    expect(ownerDispatches()[0]?.params.localFirstPhase).toBe("initial");
  });

  it("control - a cloud-homed row stays unknown, with no host named", async () => {
    useAuthStore.setState({ status: "unverified" });
    registryState.localHomedEpicIds = new Set();
    registryState.localHomedByHost = new Map();

    const { result } = renderPinnedStates([EPIC_CLOUD]);

    await waitFor(() => {
      expect(transport.dispatched).toHaveLength(0);
    });
    expect(result.current.get(EPIC_CLOUD)).toBeUndefined();
  });

  it("control - a local-homed row the host's page omits stays unknown", async () => {
    useAuthStore.setState({ status: "unverified" });
    // Two local-homed tabs on the one host, and the page carries a row for only
    // ONE of them. The answered epic is the settle signal - asserting it in the
    // SAME rendered state is what makes "still unknown" mean "the query resolved
    // and said nothing about this row" rather than "it had not come back yet".
    registryState.localHomedEpicIds = new Set([EPIC_LOCAL, "epic-answered"]);
    registryState.localHomedByHost = new Map([
      [EPIC_LOCAL, OWNER_HOST_ID],
      ["epic-answered", OWNER_HOST_ID],
    ]);
    transport.responseByHostId.set(
      OWNER_HOST_ID,
      page([localRow("epic-answered", true)]),
    );

    const { result } = renderPinnedStates([EPIC_LOCAL, "epic-answered"]);

    await waitFor(() => {
      expect(result.current.get("epic-answered")?.pinnedKnown).toBe(true);
    });
    expect(result.current.get(EPIC_LOCAL)).toEqual({
      pinned: false,
      home: "local",
      hostId: OWNER_HOST_ID,
      pinnedKnown: false,
    });
  });
});
