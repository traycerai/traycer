import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

// The project registers no Testing Library auto-cleanup (`globals: false`), so
// without this every rendered hook survives into the next case, still
// subscribed to the auth store and the mocked client - and every assertion
// below counts calls on those shared mocks.
afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ListTaskLight,
  ListTasksRequest,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import {
  cloudEpicTasksQueryKey,
  LIST_CLOUD_TASKS_REQUEST,
} from "@/lib/cloud-epic-tasks-query";
import { createAppQueryClient } from "@/lib/query-client";
import {
  cloudEpicTasksPageIdentity,
  useCloudEpicTasksPagesStore,
} from "@/stores/epics/cloud-epic-tasks-pages-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { CloudEpicTasksVerdictWithdrawnError } from "@/lib/cloud-epic-tasks-query/verdict-withdrawn-error";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

const HOST_ID = "host-test";
const USER_A = "user-a";
const USER_B = "user-b";

type ContextRaceRequest = (
  method: string,
  params: ListTasksRequest,
) => Promise<ListTasksResponse>;

const fixture = vi.hoisted(() => ({
  activeHostId: "host-test",
  requestContextUserId: "user-a",
  request: vi.fn<ContextRaceRequest>(),
  requestWithSignal: vi.fn(
    (
      method: string,
      params: ListTasksRequest,
      _signal: AbortSignal | undefined,
    ): Promise<ListTasksResponse> => fixture.request(method, params),
  ),
  requestContextListeners: new Set<() => void>(),
  dispatchedAs: new Array<string>(),
  switchToUserBAfterNextContextRead: false,
  onChange: vi.fn((listener: () => void) => {
    fixture.requestContextListeners.add(listener);
    return () => {
      fixture.requestContextListeners.delete(listener);
    };
  }),
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    getActiveHostId: () => fixture.activeHostId,
    getRequestContextUserId: () => {
      const currentUserId = fixture.requestContextUserId;
      if (fixture.switchToUserBAfterNextContextRead) {
        fixture.switchToUserBAfterNextContextRead = false;
        queueMicrotask(() => {
          fixture.requestContextUserId = USER_B;
          for (const listener of fixture.requestContextListeners) listener();
        });
      }
      return currentUserId;
    },
    onChange: fixture.onChange,
    request: fixture.request,
    requestWithSignal: fixture.requestWithSignal,
  }),
}));

// `useCloudEpicTasksQuery` reads the negotiated `epic.listTasks` version to
// decide whether an UNVERIFIED session's initial leg is a local read or a cloud
// spend. Every test here is `signed-in`, so that gate is already open and the
// version is irrelevant to what this file is about - but the real hook
// subscribes to `client.onChange` to follow client rebinding, and `onChange` is
// exactly the spy these tests count to prove no request-context WAIT was
// entered. Left unmocked it adds a second, unrelated subscriber and that proxy
// stops discriminating.
//
// Mocked rather than adjusting the counts, deliberately: the counts ARE the
// safety assertions ("B's page must not be issued under A's key"), and moving
// their numbers to accommodate an unrelated subscriber is how a real regression
// later reads as expected noise. The version gate itself is covered directly in
// `use-cloud-epic-tasks-query.test.tsx` (the negotiated-version matrix), so
// nothing is left unfalsified by pinning it here.
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => ({ major: 1, minor: 6 }),
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  // The live HostClient RequestContext changes before the external-store
  // notification commits another renderer snapshot. This is the exact A -> B
  // transition the follow-up must reject—not an imaginary mismatch where the
  // hook already knows it should query B instead of A.
  useReactiveHostReadiness: () => ({
    hostId: "host-test",
    requestContextUserId: "user-a",
    isReady: true,
  }),
}));

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function task(id: string, createdBy: string): ListTaskLight {
  return {
    epic: {
      light: {
        id,
        title: "A local task",
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: 0,
        updatedAt: 0,
        createdBy,
        version: "1.0.0",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    phase: null,
    pinned: false,
  };
}

describe("useCloudEpicTasksQuery request-context race", () => {
  beforeEach(() => {
    fixture.activeHostId = HOST_ID;
    fixture.requestContextUserId = USER_A;
    fixture.request.mockReset();
    fixture.requestWithSignal.mockClear();
    fixture.onChange.mockClear();
    fixture.requestContextListeners.clear();
    fixture.dispatchedAs.length = 0;
    fixture.switchToUserBAfterNextContextRead = false;
    useCloudEpicTasksPagesStore.setState({
      pagesByIdentity: {},
      generationByIdentity: {},
      deletedEpicIdsByScope: {},
    });
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: USER_A,
        userName: "User A",
        email: "a@example.com",
      },
      contextMetadata: { userId: USER_A, username: "user-a" },
      shareableTeams: [],
      subscriptionStatus: null,
    });
  });

  it("cannot issue or cache B's page under an A-keyed pending local response", async () => {
    const aPendingLocalPage: ListTasksResponse = {
      tasks: [task("a-local-epic", USER_A)],
      hasMore: false,
      completeness: {
        cloudPage: "pending",
        facets: "partial",
        localRows: "present",
        sort: "loaded-union",
      },
    };
    fixture.request.mockImplementation(
      (_method: string, params: ListTasksRequest) => {
        fixture.dispatchedAs.push(fixture.requestContextUserId);
        if (params.localFirstPhase === "revalidate") {
          return Promise.resolve({
            tasks: [task("b-cloud-epic", USER_B)],
            hasMore: false,
          });
        }
        // Initial A data has committed. The current HostClient has switched to
        // B before the passive revalidation effect captures its request.
        fixture.requestContextUserId = USER_B;
        return Promise.resolve(aPendingLocalPage);
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const { result } = renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(fixture.dispatchedAs).toEqual([USER_A]);
      expect(fixture.onChange).not.toHaveBeenCalled();
      expect(result.current.query.data?.completeness?.cloudPage).toBe(
        "unavailable",
      );
    });
    // The sole request is A's initial page. A generic mutation previously
    // issued a second request under B and installed its cloud result in this
    // A-keyed, Infinity-lifetime query.
    expect(fixture.request).toHaveBeenCalledTimes(1);
    expect(fixture.request.mock.calls[0]?.[1]).toMatchObject({
      localFirstPhase: "initial",
    });
    expect(fixture.dispatchedAs).toEqual([USER_A]);
    expect(result.current.tasks.map((entry) => entry.epic?.light?.id)).toEqual([
      "a-local-epic",
    ]);
  });

  it("fails closed when an initial resolved wait crosses from A to B", async () => {
    const aQueryKey = cloudEpicTasksQueryKey(
      HOST_ID,
      USER_A,
      LIST_CLOUD_TASKS_REQUEST,
    );
    const bPrivatePage: ListTasksResponse = {
      tasks: [task("b-private-epic", USER_B)],
      hasMore: false,
    };
    fixture.request.mockImplementation(() => {
      fixture.dispatchedAs.push(fixture.requestContextUserId);
      return Promise.resolve(bPrivatePage);
    });
    fixture.switchToUserBAfterNextContextRead = true;
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const { result } = renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(fixture.dispatchedAs).toEqual([]);
      expect(
        queryClient.getQueryState(
          cloudEpicTasksQueryKey(HOST_ID, USER_A, LIST_CLOUD_TASKS_REQUEST),
        )?.status,
      ).toBe("error");
      expect(result.current.query.isError).toBe(true);
    });
    // The hook delegates to the production first-page query options. Its
    // first context read sees A, then queues a B rotation before the resolved
    // wait continuation. The second, same-stack check blocks any B dispatch.
    expect(fixture.dispatchedAs).toEqual([]);
    expect(
      queryClient.getQueryData<ListTasksResponse>(aQueryKey)?.tasks,
    ).toBeUndefined();
    expect(fixture.onChange).not.toHaveBeenCalled();
  });

  it("cannot append a B-authorized Show more page to A's retained pages", async () => {
    const aFirstPage: ListTasksResponse = {
      tasks: [task("a-first-epic", USER_A)],
      hasMore: true,
      nextCursor: "a-cursor",
    };
    const bPrivateTail: ListTasksResponse = {
      tasks: [task("b-private-epic", USER_B)],
      hasMore: false,
    };
    fixture.request.mockImplementation(
      (_method: string, params: ListTasksRequest) => {
        fixture.dispatchedAs.push(fixture.requestContextUserId);
        return Promise.resolve(
          params.cursor === "a-cursor" ? bPrivateTail : aFirstPage,
        );
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const { result } = renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.hasNextPage).toBe(true);
      expect(
        result.current.tasks.map((entry) => entry.epic?.light?.id),
      ).toEqual(["a-first-epic"]);
    });
    fixture.requestContextUserId = USER_B;
    act(() => {
      result.current.fetchNextPage();
    });

    await waitFor(() => {
      expect(fixture.dispatchedAs).toEqual([USER_A]);
      expect(
        queryClient
          .getMutationCache()
          .getAll()
          .some((mutation) => mutation.state.status === "error"),
      ).toBe(true);
    });
    const aIdentity = cloudEpicTasksPageIdentity(
      HOST_ID,
      USER_A,
      LIST_CLOUD_TASKS_REQUEST,
    );
    expect(fixture.dispatchedAs).toEqual([USER_A]);
    expect(
      useCloudEpicTasksPagesStore.getState().pagesByIdentity[aIdentity],
    ).toBeUndefined();
    expect(result.current.tasks.map((entry) => entry.epic?.light?.id)).toEqual([
      "a-first-epic",
    ]);
  });

  it("re-reads the cloud verdict when a request-context wait resumes, not only when it began", async () => {
    // A signed-in first page waits for its host client's request context
    // during a reconnect; the session is demoted to `unverified` before the
    // same-user context arrives. The render-time hook mock above says the
    // host serves the initial leg local-first (1.6), but the DISPATCH-time
    // gate reads the live registry, which here says 1.5 - so the resumed
    // continuation would be the ordinary cloud-backed list call on the
    // retained bearer, and must be refused.
    resetNegotiatedManifests();
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.listTasks": { major: 1, minor: 5 },
    });
    fixture.request.mockResolvedValue({ tasks: [], hasMore: false });

    // The control first: the same wait, resumed while the verdict still
    // holds, dispatches - so the refusal below is the demotion's doing.
    fixture.requestContextUserId = USER_B;
    const control = renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(createAppQueryClient()) },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(fixture.onChange).toHaveBeenCalledTimes(1);
    await act(async () => {
      fixture.requestContextUserId = USER_A;
      for (const listener of fixture.requestContextListeners) listener();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fixture.request).toHaveBeenCalledTimes(1);
    control.unmount();
    fixture.onChange.mockClear();
    fixture.requestContextListeners.clear();

    fixture.requestContextUserId = USER_B;
    const queryClient = createAppQueryClient();
    renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(fixture.onChange).toHaveBeenCalledTimes(1);

    // Demoted while waiting; then the same-user context arrives.
    act(() => {
      useAuthStore.setState({
        status: "unverified",
        profile: {
          userId: USER_A,
          userName: "User A",
          email: "a@example.com",
        },
        contextMetadata: { userId: USER_A, username: "user-a" },
        shareableTeams: [],
        subscriptionStatus: null,
      });
    });
    await act(async () => {
      fixture.requestContextUserId = USER_A;
      for (const listener of fixture.requestContextListeners) listener();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Still the ONE list call from the signed-in run above. The unverified
    // resume does dispatch a `host.status` probe - the live-host re-check of
    // the local-first line - and that probe is what refuses here (nothing
    // negotiated 1.6), so no second list request follows it.
    expect(
      fixture.request.mock.calls.filter(
        ([method]) => method === "epic.listTasks",
      ),
    ).toHaveLength(1);
    expect(
      fixture.request.mock.calls.filter(([method]) => method === "host.status"),
    ).toHaveLength(1);
    // The refusal is TERMINAL for the production client (no retry that would
    // re-ask and be refused again), so the query settles on it rather than
    // sitting in a retry delay with no error yet.
    await waitFor(() => {
      expect(
        queryClient.getQueryState(
          cloudEpicTasksQueryKey(HOST_ID, USER_A, LIST_CLOUD_TASKS_REQUEST),
        )?.error,
      ).toBeInstanceOf(CloudEpicTasksVerdictWithdrawnError);
    });
    // Settling on the refusal dispatched nothing further: still the one list
    // call and the one probe.
    expect(
      fixture.request.mock.calls.filter(
        ([method]) => method === "epic.listTasks",
      ),
    ).toHaveLength(1);
    expect(fixture.request).toHaveBeenCalledTimes(2);
  });

  it("bounds an initial request-context wait at the discovery deadline", async () => {
    vi.useFakeTimers();
    try {
      fixture.requestContextUserId = USER_B;
      // The production client retries ordinary errors once. This arm therefore
      // proves the timeout's own non-retryable marker, rather than configuring
      // a test-only one-attempt policy.
      const queryClient = createAppQueryClient();
      renderHook(
        () =>
          useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
        { wrapper: makeWrapper(queryClient) },
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fixture.onChange).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        queryClient.getQueryState(
          cloudEpicTasksQueryKey(HOST_ID, USER_A, LIST_CLOUD_TASKS_REQUEST),
        )?.status,
      ).toBe("error");
      expect(fixture.request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
