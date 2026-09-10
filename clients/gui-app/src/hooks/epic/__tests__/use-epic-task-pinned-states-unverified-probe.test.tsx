import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
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
  } = {
    dispatched: [],
    responseByHostId: new Map(),
    resolvableHostIds: new Set(),
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

function makeClient(hostId: string) {
  return {
    getActiveHostId: () => hostId,
    getRequestContextUserId: () => USER_ID,
    onChange: () => () => undefined,
    requestWithSignal: (_method: string, params: unknown) => {
      transport.dispatched.push({ hostId, params, withVersionFloor: false });
      return Promise.resolve(transport.responseByHostId.get(hostId));
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

describe("useEpicTaskPinnedStates - the unverified pin reading (R1)", () => {
  beforeEach(() => {
    hostQueriesCalls.length = 0;
    transport.dispatched.length = 0;
    transport.responseByHostId.clear();
    transport.resolvableHostIds.clear();
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
