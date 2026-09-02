import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ListTaskLight,
  ListTasksRequest,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import {
  decodeResponsePayload,
  prepareRequestPayload,
} from "@traycer-clients/shared/host-transport/ws-rpc-client";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { useEpicRecordViewed } from "@/hooks/epic/use-epic-record-viewed-mutation";
import { useEpicSetPinned } from "@/hooks/epic/use-epic-set-pinned-mutation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCloudEpicTasksPagesStore } from "@/stores/epics/cloud-epic-tasks-pages-store";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksLastKnownQueryKey,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import * as cloudEpicTasksCache from "@/lib/cloud-epic-tasks-query/cache";
import { removeDeletedEpicsFromCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";

const HOST_ID = "host-test";
const USER_ID = "user-test";

type MockHostRequest = ListTasksRequest & { readonly pinned?: boolean };
type MockHostResponse =
  | ListTasksResponse
  | { readonly pinned: boolean }
  | Record<string, never>;
type MockHostRequestFunction = (
  method: string,
  params: MockHostRequest,
) => Promise<MockHostResponse>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) {
    throw new Error(
      "Expected Promise construction to synchronously register resolve.",
    );
  }
  return { promise, resolve: resolvePromise };
}

const mockHostClient = {
  getActiveHostId: vi.fn(() => HOST_ID),
  getRequestContextUserId: vi.fn(() => USER_ID),
  onChange: vi.fn(() => () => undefined),
  request: vi.fn<MockHostRequestFunction>(),
  requestWithSignal: vi.fn(
    (
      method: string,
      params: MockHostRequest,
      _signal: AbortSignal | undefined,
    ): Promise<MockHostResponse> => mockHostClient.request(method, params),
  ),
};

vi.mock("@/lib/host", () => ({
  useHostClient: () => mockHostClient,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => mockHostClient,
}));

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function taskLight(id: string, title: string): ListTaskLight {
  return {
    epic: {
      light: {
        id,
        title,
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
    phase: null,
    pinned: false,
  };
}

function taskLightIds(tasks: readonly ListTaskLight[]): ReadonlyArray<string> {
  return tasks.flatMap((task) => {
    const id = task.epic?.light?.id;
    return id !== undefined ? [id] : [];
  });
}

function hasLocalFirstPhase(value: unknown, phase: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "localFirstPhase" in value &&
    value.localFirstPhase === phase
  );
}

describe("useCloudEpicTasksQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHostClient.getActiveHostId.mockReturnValue(HOST_ID);
    mockHostClient.getRequestContextUserId.mockReturnValue(USER_ID);
    mockHostClient.onChange.mockImplementation(() => () => undefined);
    useCloudEpicTasksPagesStore.setState({
      pagesByIdentity: {},
      generationByIdentity: {},
      deletedEpicIdsByScope: {},
    });
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: USER_ID,
        userName: "Test User",
        email: "test@example.com",
      },
      contextMetadata: { userId: USER_ID, username: "test-user" },
      shareableTeams: [],
      subscriptionStatus: null,
    });
    // Every existing test in this file predates the local-first minor gate and
    // exercises behaviour that assumes the negotiated host already serves it -
    // register `epic.listTasks@1.6` for the mocked host so those fixtures keep
    // their pre-existing meaning. The T18 negotiated-version gate itself is
    // pinned by the tests below, which override this per case.
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
  });

  afterEach(() => {
    // The T18 cases below flip `useAuthStore` back and forth (unverified <->
    // signed-in) within the SAME describe run. This file otherwise relies on
    // every other test's hook staying mounted with steady, never-revisited
    // state (see the `signed-out` test's own comment on this), so without an
    // explicit unmount here a surviving hook from an earlier test reacts to a
    // later test's auth transition and dispatches into that later test's
    // shared `mockHostClient.request` mock.
    cleanup();
    resetNegotiatedManifests();
  });

  it("admits #4's unverified stored identity to local-first History", async () => {
    // The cohort this whole feature exists for: a stored identity on disk that
    // authn could not confirm. `root-landing-page.tsx` renders `/epics` for it,
    // so it reaches History - and every gate below here has to agree that it
    // did, or it arrives to "No tasks yet" over its own rows.
    const localPage: ListTasksResponse = {
      tasks: [taskLight("unverified-local", "Served from this disk")],
      hasMore: false,
      completeness: {
        cloudPage: "pending",
        facets: "partial",
        localRows: "present",
        sort: "loaded-union",
      },
    };
    mockHostClient.request.mockResolvedValue(localPage);
    useAuthStore.setState({
      status: "unverified",
      profile: {
        userId: USER_ID,
        userName: "Test User",
        email: "test@example.com",
      },
      // The stored identity, matching the live RequestContext - the pairing
      // `resolveCloudTasksUserId` requires before it will name a cache.
      contextMetadata: { userId: USER_ID, username: "test-user" },
      shareableTeams: [],
      // No server verdict is held, so no entitlement is projected.
      subscriptionStatus: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const admitted = renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(taskLightIds(admitted.result.current.tasks)).toEqual([
        "unverified-local",
      ]);
    });
    expect(mockHostClient.request).toHaveBeenCalledTimes(1);
    expect(mockHostClient.request.mock.calls[0]?.[1]).toMatchObject({
      localFirstPhase: "initial",
    });

    // The OTHER half of the split, and the reason widening the gate is safe:
    // the local leg went out, the cloud leg did not. `unverified` holds no
    // `/api/v3/user` verdict, so no revalidation is spent - and the page is
    // settled to `unavailable` rather than left claiming a cloud half is still
    // on its way.
    await waitFor(() => {
      expect(admitted.result.current.query.data?.completeness?.cloudPage).toBe(
        "unavailable",
      );
    });
    expect(
      mockHostClient.request.mock.calls.filter(([, params]) =>
        hasLocalFirstPhase(params, "revalidate"),
      ),
    ).toHaveLength(0);
    expect(admitted.result.current.isCloudPagePending).toBe(false);
    admitted.unmount();

    // A SIGNED-OUT identity still issues nothing. This is the arm that keeps
    // the widening honest: admission moved from "has a verdict" to "has an
    // identity on disk", and `signed-out` is precisely the state that has
    // neither, so it must not merely be gated later - no request may leave.
    mockHostClient.request.mockClear();
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
      shareableTeams: [],
      subscriptionStatus: null,
    });
    const signedOutQueryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const signedOut = renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(signedOutQueryClient) },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockHostClient.request).not.toHaveBeenCalled();
    expect(signedOut.result.current.tasks).toEqual([]);
    expect(signedOut.result.current.currentUserId).toBeNull();
    // MUST unmount, and this test is the only one in the file that must.
    // `vitest.config.ts` sets `globals: false` and the setup file registers no
    // Testing Library `cleanup`, so nothing here auto-unmounts - a rendered
    // hook survives into the next test. That is harmless for every other test,
    // whose hooks stay signed-in with a settled `staleTime: Infinity` query and
    // never re-fetch. It is NOT harmless here: this hook is parked on the
    // DISABLED branch only because the store says `signed-out`, and the next
    // `beforeEach` sets the store back to `signed-in`. A surviving observer
    // would re-render, resolve a real user id, flip to the enabled branch and
    // dispatch `epic.listTasks` into the following test's freshly-cleared mock.
    signedOut.unmount();
  });

  it("keeps an old host's one-shot response on today's no-follow-up path", async () => {
    const oldHostPage: ListTasksResponse = {
      tasks: [taskLight("old-host-epic", "Released behaviour")],
      hasMore: false,
    };
    const preparedRequests: ListTasksRequest[] = [];
    mockHostClient.request.mockImplementation(
      (_method: string, params: ListTasksRequest) => {
        // Model an actual 1.6-client -> 1.5-host transport leg, rather than
        // merely handing the renderer an old-shaped fixture. This is the same
        // schema projection and response upgrade the WebSocket client runs.
        const prepared = prepareRequestPayload(
          hostRpcRegistry["epic.listTasks"],
          { major: 1, minor: 6 },
          { major: 1, minor: 5 },
          params,
          "old-host-list-tasks",
          "epic.listTasks",
        );
        preparedRequests.push(prepared.onWirePayload);
        return Promise.resolve(
          decodeResponsePayload<ListTasksResponse>(
            hostRpcRegistry["epic.listTasks"],
            { major: 1, minor: 6 },
            { major: 1, minor: 5 },
            oldHostPage,
            "old-host-list-tasks",
            "epic.listTasks",
          ),
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
      expect(taskLightIds(result.current.tasks)).toEqual(["old-host-epic"]);
    });
    // A v1.5 host strips the additive directive during real same-major
    // negotiation and can never emit `pending`. The renderer retains today's
    // one request / one rendered page behavior, not a retry storm.
    expect(mockHostClient.request).toHaveBeenCalledTimes(1);
    expect(mockHostClient.request.mock.calls[0]?.[1]).toMatchObject({
      localFirstPhase: "initial",
    });
    expect(preparedRequests).toHaveLength(1);
    expect(preparedRequests[0]).not.toHaveProperty("localFirstPhase");
    expect(
      mockHostClient.request.mock.calls.some(([, params]) =>
        hasLocalFirstPhase(params, "revalidate"),
      ),
    ).toBe(false);
  });

  it("keeps local rows and stops after one failed revalidation", async () => {
    const pendingLocalPage: ListTasksResponse = {
      tasks: [taskLight("offline-local", "Still available")],
      hasMore: false,
      completeness: {
        cloudPage: "pending",
        facets: "partial",
        localRows: "present",
        sort: "loaded-union",
      },
    };
    mockHostClient.request.mockImplementation(
      (_method: string, params: { readonly localFirstPhase?: string }) =>
        params.localFirstPhase === "revalidate"
          ? Promise.reject(new Error("offline"))
          : Promise.resolve(pendingLocalPage),
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        // This non-default retry policy proves the production mutation's own
        // `retry: false` is the ceiling rather than a test-environment
        // default.
        mutations: { retry: 3, retryDelay: 1 },
      },
    });
    const { result } = renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(taskLightIds(result.current.tasks)).toEqual(["offline-local"]);
      expect(result.current.query.data?.completeness?.cloudPage).toBe(
        "unavailable",
      );
    });
    expect(
      mockHostClient.request.mock.calls.filter(([, params]) =>
        hasLocalFirstPhase(params, "revalidate"),
      ),
    ).toHaveLength(1);

    // No auth transition happens anywhere in this test - `signed-in` holds
    // throughout, and the page reached `unavailable` through the
    // revalidation's OWN rejection arm, not an authorization edge. A guard
    // that merely tested "authorized AND unavailable" (rather than the
    // unverified -> signed-in EDGE) would treat every one of these follow-up
    // renders as reopenable and spin: reopen to `pending` re-arms the
    // revalidation effect above, which rejects again, landing back on
    // `unavailable` and re-triggering the same state-based guard. Flushing
    // extra microtask ticks here gives that spin room to happen before
    // asserting it did not.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      mockHostClient.request.mock.calls.filter(([, params]) =>
        hasLocalFirstPhase(params, "revalidate"),
      ),
    ).toHaveLength(1);
    expect(result.current.query.data?.completeness?.cloudPage).toBe(
      "unavailable",
    );
  });

  it("reopens a settled unavailable cloud page and revalidates once on promotion from unverified to signed-in", async () => {
    const localPage: ListTasksResponse = {
      tasks: [taskLight("promoted-local", "Served from this disk")],
      hasMore: false,
      completeness: {
        cloudPage: "pending",
        facets: "partial",
        localRows: "present",
        sort: "loaded-union",
      },
    };
    const revalidatedPage: ListTasksResponse = {
      tasks: [taskLight("promoted-local", "Served from this disk")],
      hasMore: false,
      completeness: {
        cloudPage: "settled",
        facets: "server",
        localRows: "present",
        sort: "server",
      },
    };
    mockHostClient.request.mockImplementation(
      (_method: string, params: { readonly localFirstPhase?: string }) =>
        params.localFirstPhase === "revalidate"
          ? Promise.resolve(revalidatedPage)
          : Promise.resolve(localPage),
    );
    useAuthStore.setState({
      status: "unverified",
      profile: {
        userId: USER_ID,
        userName: "Test User",
        email: "test@example.com",
      },
      contextMetadata: { userId: USER_ID, username: "test-user" },
      shareableTeams: [],
      subscriptionStatus: null,
    });
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

    // Settles to `unavailable` with no verdict held - no revalidation leg is
    // spent for an unverified session.
    await waitFor(() => {
      expect(result.current.query.data?.completeness?.cloudPage).toBe(
        "unavailable",
      );
    });
    expect(
      mockHostClient.request.mock.calls.filter(([, params]) =>
        hasLocalFirstPhase(params, "revalidate"),
      ),
    ).toHaveLength(0);

    // The promotion edge: the same identity now holds a `/api/v3/user`
    // verdict.
    act(() => {
      useAuthStore.setState({
        status: "signed-in",
        profile: {
          userId: USER_ID,
          userName: "Test User",
          email: "test@example.com",
        },
        contextMetadata: { userId: USER_ID, username: "test-user" },
        shareableTeams: [],
        subscriptionStatus: null,
      });
    });

    await waitFor(() => {
      expect(
        mockHostClient.request.mock.calls.filter(([, params]) =>
          hasLocalFirstPhase(params, "revalidate"),
        ),
      ).toHaveLength(1);
    });
    await waitFor(() => {
      expect(result.current.query.data?.completeness?.cloudPage).toBe(
        "settled",
      );
    });
    expect(taskLightIds(result.current.tasks)).toEqual(["promoted-local"]);
  });

  it("starts a fresh bounded episode for History's raw refresh while the prior follow-up is unresolved", async () => {
    const firstLocalPage: ListTasksResponse = {
      tasks: [taskLight("first-local", "Before refresh")],
      hasMore: false,
      completeness: {
        cloudPage: "pending",
        facets: "partial",
        localRows: "present",
        sort: "loaded-union",
      },
    };
    const refreshedLocalPage: ListTasksResponse = {
      tasks: [taskLight("refreshed-local", "After refresh")],
      hasMore: false,
      completeness: {
        cloudPage: "pending",
        facets: "partial",
        localRows: "present",
        sort: "loaded-union",
      },
    };
    const resolveRevalidations: Array<(page: ListTasksResponse) => void> = [];
    let initialCalls = 0;
    mockHostClient.request.mockImplementation(
      (_method: string, params: ListTasksRequest) => {
        if (params.localFirstPhase === "revalidate") {
          return new Promise<ListTasksResponse>((resolve) => {
            resolveRevalidations.push(resolve);
          });
        }
        initialCalls += 1;
        return Promise.resolve(
          initialCalls === 1 ? firstLocalPage : refreshedLocalPage,
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
      expect(resolveRevalidations).toHaveLength(1);
      expect(taskLightIds(result.current.tasks)).toEqual(["first-local"]);
    });

    // This is exactly the real History refresh path: `useHistoryQuery`
    // exposes the raw `tasksQuery.refetch`, not this hook's convenience
    // wrapper. Starting a query-owned episode here must supersede the
    // unresolved predecessor before its response can overwrite the fresh page.
    await act(async () => {
      await result.current.query.refetch();
    });
    await waitFor(() => {
      expect(initialCalls).toBe(2);
      expect(resolveRevalidations).toHaveLength(2);
      expect(taskLightIds(result.current.tasks)).toEqual(["refreshed-local"]);
    });

    await act(async () => {
      resolveRevalidations[0]?.({
        tasks: [taskLight("stale-cloud", "Must not overwrite refresh")],
        hasMore: false,
      });
      await Promise.resolve();
    });
    expect(taskLightIds(result.current.tasks)).toEqual(["refreshed-local"]);

    await act(async () => {
      resolveRevalidations[1]?.({
        tasks: [taskLight("fresh-cloud", "Fresh revalidation")],
        hasMore: false,
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(taskLightIds(result.current.tasks)).toEqual(["fresh-cloud"]);
    });
  });

  it("starts a fresh bounded episode after the active pin mutation invalidates History", async () => {
    const initialLocalPage: ListTasksResponse = {
      tasks: [taskLight("pin-local", "Before pin")],
      hasMore: false,
      completeness: {
        cloudPage: "pending",
        facets: "partial",
        localRows: "present",
        sort: "loaded-union",
      },
    };
    const invalidatedLocalPage: ListTasksResponse = {
      tasks: [taskLight("pin-local", "After pin")],
      hasMore: false,
      completeness: {
        cloudPage: "pending",
        facets: "partial",
        localRows: "present",
        sort: "loaded-union",
      },
    };
    let initialCalls = 0;
    let revalidationCalls = 0;
    mockHostClient.request.mockImplementation(
      (
        method: string,
        params: ListTasksRequest & { readonly pinned?: boolean },
      ) => {
        if (method === "epic.setPinned") {
          return Promise.resolve({ pinned: params.pinned ?? false });
        }
        if (params.localFirstPhase === "revalidate") {
          revalidationCalls += 1;
          return Promise.resolve({
            tasks: [
              taskLight(
                revalidationCalls === 1
                  ? "before-pin-cloud"
                  : "after-pin-cloud",
                "Cloud revalidated",
              ),
            ],
            hasMore: false,
          });
        }
        initialCalls += 1;
        return Promise.resolve(
          initialCalls === 1 ? initialLocalPage : invalidatedLocalPage,
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
      () => ({
        tasks: useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, {
          enabled: true,
        }),
        pin: useEpicSetPinned(),
      }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(revalidationCalls).toBe(1);
      expect(taskLightIds(result.current.tasks.tasks)).toEqual([
        "before-pin-cloud",
      ]);
    });

    // `useEpicSetPinned` invalidates active list queries itself. The next
    // initial dispatch—not a caller remembering a reset wrapper—must create a
    // new finite follow-up budget for its new pending local page.
    act(() => {
      result.current.pin.mutate({ epicId: "pin-local", pinned: true });
    });
    await waitFor(() => {
      expect(initialCalls).toBe(2);
      expect(revalidationCalls).toBe(2);
      expect(taskLightIds(result.current.tasks.tasks)).toEqual([
        "after-pin-cloud",
      ]);
    });
  });

  it("starts a fresh bounded episode after the active record-viewed invalidation", async () => {
    const lastViewedRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      sort: "last-viewed" as const,
    };
    const initialLocalPage: ListTasksResponse = {
      tasks: [taskLight("view-local", "Before view")],
      hasMore: false,
      completeness: {
        cloudPage: "pending",
        facets: "partial",
        localRows: "present",
        sort: "loaded-union",
      },
    };
    const invalidatedLocalPage: ListTasksResponse = {
      tasks: [taskLight("view-local", "After view")],
      hasMore: false,
      completeness: {
        cloudPage: "pending",
        facets: "partial",
        localRows: "present",
        sort: "loaded-union",
      },
    };
    let initialCalls = 0;
    let revalidationCalls = 0;
    mockHostClient.request.mockImplementation(
      (method: string, params: ListTasksRequest) => {
        if (method === "epic.recordViewed") {
          return Promise.resolve({});
        }
        if (params.localFirstPhase === "revalidate") {
          revalidationCalls += 1;
          return Promise.resolve({
            tasks: [
              taskLight(
                revalidationCalls === 1
                  ? "before-view-cloud"
                  : "after-view-cloud",
                "Cloud revalidated",
              ),
            ],
            hasMore: false,
          });
        }
        initialCalls += 1;
        return Promise.resolve(
          initialCalls === 1 ? initialLocalPage : invalidatedLocalPage,
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
      () => ({
        tasks: useCloudEpicTasksQuery(lastViewedRequest, { enabled: true }),
        recordViewed: useEpicRecordViewed(),
      }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(revalidationCalls).toBe(1);
      expect(taskLightIds(result.current.tasks.tasks)).toEqual([
        "before-view-cloud",
      ]);
    });

    act(() => {
      result.current.recordViewed.mutate({ epicId: "view-local" });
    });
    await waitFor(() => {
      expect(initialCalls).toBe(2);
      expect(revalidationCalls).toBe(2);
      expect(taskLightIds(result.current.tasks.tasks)).toEqual([
        "after-view-cloud",
      ]);
    });
  });

  it("rejects a deleted tail response that resolves after delete lands mid-flight", async () => {
    const firstPage: ListTasksResponse = {
      tasks: [taskLight("epic-first", "First page task")],
      hasMore: true,
      nextCursor: "cursor-a",
    };
    let resolveStaleTail: ((value: ListTasksResponse) => void) | undefined;
    mockHostClient.request.mockImplementation(
      (_method: string, params: MockHostRequest) => {
        if (params.cursor !== undefined) {
          return new Promise<ListTasksResponse>((resolve) => {
            resolveStaleTail = resolve;
          });
        }
        return Promise.resolve(firstPage);
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
      expect(taskLightIds(result.current.tasks)).toEqual(["epic-first"]);
    });
    expect(result.current.hasNextPage).toBe(true);

    // Start the FIRST "Show more" tail request for this identity through the
    // production `fetchNextPage` - the exact call path review finding 2
    // reproduced (`traycer/clients/gui-app/src/hooks/epics/use-cloud-epic-tasks-query.ts`).
    act(() => {
      result.current.fetchNextPage();
    });
    await waitFor(() => {
      expect(result.current.isFetchingNextPage).toBe(true);
    });

    // A real successful-delete cache write lands while the tail is unresolved.
    // It has to advance the retained-page generation too, not only prune the
    // first-page Query cache.
    act(() => {
      removeDeletedEpicsFromCloudTaskCaches(
        queryClient,
        { hostId: HOST_ID, userId: USER_ID },
        ["epic-stale"],
      );
    });

    // The stale tail finally resolves after the refreshed first page would
    // have landed.
    await act(async () => {
      resolveStaleTail?.({
        tasks: [taskLight("epic-stale", "Stale tail task")],
        hasMore: false,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.isFetchingNextPage).toBe(false);
    });

    // The stale tail must not be appended to - or rendered in - the task list.
    expect(taskLightIds(result.current.tasks)).toEqual(["epic-first"]);
  });

  it("filters a deleted row from a cursor request started after the delete", async () => {
    const firstPage: ListTasksResponse = {
      tasks: [taskLight("epic-first", "First page task")],
      hasMore: true,
      nextCursor: "cursor-after-delete",
    };
    const staleCloudTail: ListTasksResponse = {
      tasks: [taskLight("epic-deleted-after", "Deleted before fetch")],
      hasMore: false,
    };
    let resolveStaleCloudTail: ((page: ListTasksResponse) => void) | undefined;
    mockHostClient.request.mockImplementation(
      (_method: string, params: MockHostRequest) => {
        if (params.cursor === undefined) return Promise.resolve(firstPage);
        return new Promise<ListTasksResponse>((resolve) => {
          resolveStaleCloudTail = resolve;
        });
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
      expect(taskLightIds(result.current.tasks)).toEqual(["epic-first"]);
    });
    expect(result.current.hasNextPage).toBe(true);

    // There is no in-flight tail to reject here. This begins Show more only
    // AFTER a successful delete, so generation invalidation alone cannot
    // protect the response; the store-owned tombstone must admit no deleted
    // row when `appendPage` receives this cursor response.
    act(() => {
      removeDeletedEpicsFromCloudTaskCaches(
        queryClient,
        { hostId: HOST_ID, userId: USER_ID },
        ["epic-deleted-after"],
      );
    });
    act(() => {
      result.current.fetchNextPage();
    });

    await waitFor(() => {
      expect(result.current.isFetchingNextPage).toBe(true);
      expect(resolveStaleCloudTail).toBeTypeOf("function");
    });
    await act(async () => {
      resolveStaleCloudTail?.(staleCloudTail);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.isFetchingNextPage).toBe(false);
      expect(taskLightIds(result.current.tasks)).toEqual(["epic-first"]);
    });
  });

  it("fences a deleted row from a direct first-page response before TanStack caches it", async () => {
    const staleCloudFirstPage: ListTasksResponse = {
      tasks: [
        taskLight("epic-deleted-direct-first", "Deleted before response"),
      ],
      hasMore: false,
      completeness: {
        cloudPage: "settled",
        facets: "server",
        localRows: "none",
        sort: "server",
      },
    };
    mockHostClient.request.mockResolvedValue(staleCloudFirstPage);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    // The delete lands before an ordinary first-page request. This proves the
    // early first-page delivery admission consults a pre-existing ledger.
    removeDeletedEpicsFromCloudTaskCaches(
      queryClient,
      { hostId: HOST_ID, userId: USER_ID },
      ["epic-deleted-direct-first"],
    );
    const { result } = renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.query.isSuccess).toBe(true);
      expect(taskLightIds(result.current.tasks)).toEqual([]);
    });
    expect(
      queryClient
        .getQueryData<ListTasksResponse>(
          cloudEpicTasksQueryKey(HOST_ID, USER_ID, LIST_CLOUD_TASKS_REQUEST),
        )
        ?.tasks.map((task) => task.epic?.light?.id),
    ).toEqual([]);
  });

  it("rechecks the ledger when a delete lands between direct-page admission and TanStack's write", async () => {
    const staleCloudFirstPage: ListTasksResponse = {
      tasks: [taskLight("epic-deleted-direct-race", "Deleted during delivery")],
      hasMore: false,
      completeness: {
        cloudPage: "settled",
        facets: "server",
        localRows: "none",
        sort: "server",
      },
    };
    mockHostClient.request.mockResolvedValue(staleCloudFirstPage);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const originalAdmission = cloudEpicTasksCache.admitCloudEpicTasksFirstPage;
    let earlyAdmissionObserved = false;
    const admissionSpy = vi
      .spyOn(cloudEpicTasksCache, "admitCloudEpicTasksFirstPage")
      .mockImplementation((response, scope) => {
        const admitted = originalAdmission(response, scope);
        if (!earlyAdmissionObserved) {
          earlyAdmissionObserved = true;
          // This runs immediately after the real early admission returns but
          // before TanStack receives that result. It reproduces a delete in
          // the only window the pre-existing-ledger arm cannot exercise.
          removeDeletedEpicsFromCloudTaskCaches(
            queryClient,
            { hostId: HOST_ID, userId: USER_ID },
            ["epic-deleted-direct-race"],
          );
        }
        return admitted;
      });
    try {
      const { result } = renderHook(
        () =>
          useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
        { wrapper: makeWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.query.isSuccess).toBe(true);
        expect(taskLightIds(result.current.tasks)).toEqual([]);
      });
      expect(earlyAdmissionObserved).toBe(true);
      expect(admissionSpy).toHaveBeenCalledTimes(2);
      expect(
        queryClient
          .getQueryData<ListTasksResponse>(
            cloudEpicTasksQueryKey(HOST_ID, USER_ID, LIST_CLOUD_TASKS_REQUEST),
          )
          ?.tasks.map((task) => task.epic?.light?.id),
      ).toEqual([]);
    } finally {
      admissionSpy.mockRestore();
    }
  });

  it("makes raw first-page refetch clear retained cursor pages", async () => {
    const firstPage: ListTasksResponse = {
      tasks: [taskLight("before-refresh", "Before refresh")],
      hasMore: true,
      nextCursor: "cursor-before-refresh",
    };
    const retainedTail: ListTasksResponse = {
      tasks: [taskLight("retained-tail", "Retained tail")],
      hasMore: false,
    };
    const refreshedFirstPage: ListTasksResponse = {
      tasks: [taskLight("after-refresh", "After refresh")],
      hasMore: false,
    };
    let initialCalls = 0;
    mockHostClient.request.mockImplementation(
      (_method: string, params: ListTasksRequest) => {
        if (params.cursor !== undefined) return Promise.resolve(retainedTail);
        initialCalls += 1;
        return Promise.resolve(
          initialCalls === 1 ? firstPage : refreshedFirstPage,
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
      expect(taskLightIds(result.current.tasks)).toEqual(["before-refresh"]);
    });
    act(() => {
      result.current.fetchNextPage();
    });
    await waitFor(() => {
      expect(taskLightIds(result.current.tasks)).toEqual([
        "before-refresh",
        "retained-tail",
      ]);
    });

    // This is the exact bypass that History exposes today: raw Query.refetch,
    // rather than this hook's returned convenience callback. The queryFn must
    // own the reset so every caller observes the same generation boundary.
    await act(async () => {
      await result.current.query.refetch();
    });
    await waitFor(() => {
      expect(initialCalls).toBe(2);
      expect(taskLightIds(result.current.tasks)).toEqual(["after-refresh"]);
    });
  });

  it("dedupes a row that appears in both the first page and a loaded tail, first page winning", async () => {
    // An optimistic pin moves a row across server page boundaries: after the
    // pin, a refetched first page carries the pinned row at the top while a
    // previously loaded tail still carries it at its old position. The
    // assembled list must render it once, from the first page.
    const firstPage: ListTasksResponse = {
      tasks: [taskLight("epic-first", "First page task")],
      hasMore: true,
      nextCursor: "cursor-a",
    };
    const tailPage: ListTasksResponse = {
      tasks: [
        taskLight("epic-first", "Duplicate of the first-page task"),
        taskLight("epic-second", "Tail-only task"),
      ],
      hasMore: false,
    };
    mockHostClient.request.mockImplementation(
      (_method: string, params: MockHostRequest) =>
        Promise.resolve(params.cursor === undefined ? firstPage : tailPage),
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
      expect(taskLightIds(result.current.tasks)).toEqual(["epic-first"]);
    });
    act(() => {
      result.current.fetchNextPage();
    });

    await waitFor(() => {
      expect(taskLightIds(result.current.tasks)).toEqual([
        "epic-first",
        "epic-second",
      ]);
    });
    expect(
      result.current.tasks.find((task) => task.epic?.light?.id === "epic-first")
        ?.epic?.light?.title,
    ).toBe("First page task");
  });

  it("carries visible rows across a modal-to-tab observer remount while the promoted request is still unsettled", async () => {
    // Reproduces review finding 2: promotion happens during the search
    // debounce / while a structured-filter request is still pending, so the
    // promoted tab's request has never settled. The modal and the promoted
    // tab render `EpicsListPanel` separately, so promotion destroys one
    // `QueryObserver` and mounts a fresh one for the promoted request - here,
    // `LIST_CLOUD_TASKS_REQUEST` (modal) vs. `promotedRequest` (tab).
    const settledFirstPage: ListTasksResponse = {
      tasks: [taskLight("epic-settled", "Settled task")],
      hasMore: false,
    };
    const promotedRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      sort: "oldest" as const,
    };
    let resolvePromotedRequest:
      | ((value: ListTasksResponse) => void)
      | undefined;
    mockHostClient.request.mockImplementation(
      (_method: string, params: MockHostRequest) => {
        if (params.sort === "oldest") {
          return new Promise<ListTasksResponse>((resolve) => {
            resolvePromotedRequest = resolve;
          });
        }
        return Promise.resolve(settledFirstPage);
      },
    );

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    const modalRender = renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );
    await waitFor(() => {
      expect(taskLightIds(modalRender.result.current.tasks)).toEqual([
        "epic-settled",
      ]);
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData<ListTasksResponse>(
          cloudEpicTasksLastKnownQueryKey(HOST_ID, USER_ID),
        ),
      ).toBe(settledFirstPage);
    });

    // Promote: the modal's observer unmounts, and a brand-new observer
    // mounts for the promoted request against the same `QueryClient` -
    // matching production, where both trees share one app-wide client.
    modalRender.unmount();

    const tabRender = renderHook(
      () => useCloudEpicTasksQuery(promotedRequest, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );

    // Visible immediately, on the very first render - not after a wait - and
    // without ever having been empty in between. The fresh observer has no
    // `previousQuery` of its own and the promoted key has no settled cache
    // entry, so TanStack's own `placeholderData(previousData, previousQuery)`
    // alone would return `undefined` here.
    expect(taskLightIds(tabRender.result.current.tasks)).toEqual([
      "epic-settled",
    ]);
    expect(tabRender.result.current.query.isPlaceholderData).toBe(true);

    // The promoted request has started fetching in the background - wait for
    // it to actually reach the mock before resolving it, since the fetch
    // itself is dispatched from a passive effect.
    await waitFor(() => {
      expect(resolvePromotedRequest).toBeDefined();
    });

    await act(async () => {
      resolvePromotedRequest?.({
        tasks: [taskLight("epic-promoted", "Promoted task")],
        hasMore: false,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(taskLightIds(tabRender.result.current.tasks)).toEqual([
        "epic-promoted",
      ]);
    });
  });

  it("keeps the local page rendered through an unresolved revalidation and fences a late deleted row", async () => {
    const pendingLocalPage: ListTasksResponse = {
      tasks: [taskLight("local-epic", "On this device")],
      hasMore: false,
      completeness: {
        cloudPage: "pending",
        facets: "partial",
        localRows: "present",
        sort: "loaded-union",
      },
    };
    const revalidation = createDeferred<ListTasksResponse>();
    let revalidationRequests = 0;
    mockHostClient.request.mockImplementation(
      (_method: string, params: { readonly localFirstPhase?: string }) => {
        if (params.localFirstPhase === "revalidate") {
          revalidationRequests += 1;
          return revalidation.promise;
        }
        return Promise.resolve(pendingLocalPage);
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
      expect(revalidationRequests).toBe(1);
      expect(taskLightIds(result.current.tasks)).toEqual(["local-epic"]);
    });
    // The first page is a usable result while its cloud mutation remains
    // unresolved. A promptly resolving fake cloud cannot satisfy this arm.
    expect(result.current.query.isPending).toBe(false);
    expect(result.current.isFetchingNextPage).toBe(false);
    expect(typeof result.current.fetchNextPage).toBe("function");
    // Modal and tab History observers can overlap. The finite follow-up is
    // owned by their shared QueryClient, not by either hook instance. Reverse
    // the request object's insertion order: TanStack treats it as this same
    // Query, and the coordinator must use the same canonical identity.
    const reverseOrderRequest = {
      sort: "recent" as const,
      filters: null,
      limit: LIST_CLOUD_TASKS_REQUEST.limit,
      extensionEpicVersion: LIST_CLOUD_TASKS_REQUEST.extensionEpicVersion,
      extensionPhaseVersion: LIST_CLOUD_TASKS_REQUEST.extensionPhaseVersion,
    };
    const secondObserver = renderHook(
      () => useCloudEpicTasksQuery(reverseOrderRequest, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      mockHostClient.request.mock.calls.filter(([, params]) =>
        hasLocalFirstPhase(params, "revalidate"),
      ),
    ).toHaveLength(1);
    secondObserver.unmount();

    // As with the direct-page arm above, the safe delivery helper has already
    // attached its early-admission reaction when this listener is registered.
    // The delete thus lands after admission but before the pending first page
    // is replaced. The primary Query's cache-write fence must re-read the
    // ledger for this revalidation write too.
    void revalidation.promise.then(() => {
      removeDeletedEpicsFromCloudTaskCaches(
        queryClient,
        { hostId: HOST_ID, userId: USER_ID },
        ["local-epic"],
      );
    });

    await act(async () => {
      revalidation.resolve({
        tasks: [taskLight("local-epic", "Stale cloud row")],
        hasMore: false,
        completeness: {
          cloudPage: "settled",
          facets: "server",
          localRows: "none",
          sort: "server",
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(taskLightIds(result.current.tasks)).toEqual([]);
      expect(result.current.query.data?.completeness?.cloudPage).toBe(
        "settled",
      );
    });
  });

  it("reports the outstanding revalidation on an empty pending page", async () => {
    // The caller-owned-tombstone answer: a local answer exists (a deletion this
    // caller owns), so the host returns immediately - with NO rows. That page
    // reaches the panel's empty branch, and nothing on `query` distinguishes it
    // from an account that genuinely has nothing.
    const pendingLocalPage: ListTasksResponse = {
      tasks: [],
      hasMore: false,
      completeness: {
        cloudPage: "pending",
        facets: "partial",
        localRows: "none",
        sort: "loaded-union",
      },
    };
    const revalidation = createDeferred<ListTasksResponse>();
    mockHostClient.request.mockImplementation(
      (_method: string, params: { readonly localFirstPhase?: string }) =>
        params.localFirstPhase === "revalidate"
          ? revalidation.promise
          : Promise.resolve(pendingLocalPage),
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
      expect(result.current.isCloudPagePending).toBe(true);
    });
    // Why this cannot be derived from the query the caller already holds: the
    // follow-up runs under its own ephemeral key, so the primary query has
    // SETTLED SUCCESSFULLY with zero rows while a request for this very list is
    // still in flight.
    expect(result.current.query.isFetching).toBe(false);
    expect(result.current.query.isSuccess).toBe(true);
    expect(result.current.tasks).toEqual([]);

    await act(async () => {
      revalidation.resolve({
        tasks: [taskLight("cloud-row", "Cloud page landed")],
        hasMore: false,
        completeness: {
          cloudPage: "settled",
          facets: "server",
          localRows: "none",
          sort: "server",
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.isCloudPagePending).toBe(false);
      expect(taskLightIds(result.current.tasks)).toEqual(["cloud-row"]);
    });
  });

  it("unions completeness worst-of across the first page and a retained tail", async () => {
    // Each page is worse than the other on a DIFFERENT member, so neither
    // "first page wins" nor "last page wins" can produce the expected value -
    // only a per-member worst-of can. A single-direction fixture would pass
    // against three different wrong implementations.
    const firstPage: ListTasksResponse = {
      tasks: [taskLight("union-first", "First page")],
      hasMore: true,
      nextCursor: "cursor-union",
      completeness: {
        cloudPage: "unavailable",
        facets: "partial",
        localRows: "present",
        sort: "server",
      },
    };
    const tailPage: ListTasksResponse = {
      tasks: [taskLight("union-tail", "Tail page")],
      hasMore: false,
      completeness: {
        cloudPage: "settled",
        facets: "server",
        localRows: "truncated",
        sort: "loaded-union",
      },
    };
    mockHostClient.request.mockImplementation(
      (_method: string, params: MockHostRequest) =>
        Promise.resolve(params.cursor === undefined ? firstPage : tailPage),
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
      expect(taskLightIds(result.current.tasks)).toEqual(["union-first"]);
    });
    // With no tail loaded the union is exactly the first page's own statement,
    // so the change below is attributable to the tail and nothing else.
    expect(result.current.completeness).toEqual(firstPage.completeness);

    act(() => {
      result.current.fetchNextPage();
    });
    await waitFor(() => {
      expect(taskLightIds(result.current.tasks)).toEqual([
        "union-first",
        "union-tail",
      ]);
    });
    // `unavailable` and `partial` come from the first page, `truncated` and
    // `loaded-union` from the tail. `tasks` above is the union of both, so the
    // statement describing it has to carry all four.
    expect(result.current.completeness).toEqual({
      cloudPage: "unavailable",
      facets: "partial",
      localRows: "truncated",
      sort: "loaded-union",
    });
  });

  it("keeps a first page's warning when a retained tail says nothing", async () => {
    // The silent-page rule, pinned in the direction that has a live path to it:
    // a page with no statement contributes none, and must not erase the
    // `unavailable` warning its sibling did make.
    const firstPage: ListTasksResponse = {
      tasks: [taskLight("silent-first", "First page")],
      hasMore: true,
      nextCursor: "cursor-silent",
      completeness: {
        cloudPage: "unavailable",
        facets: "partial",
        localRows: "present",
        sort: "loaded-union",
      },
    };
    const silentTail: ListTasksResponse = {
      tasks: [taskLight("silent-tail", "Tail with no statement")],
      hasMore: false,
    };
    mockHostClient.request.mockImplementation(
      (_method: string, params: MockHostRequest) =>
        Promise.resolve(params.cursor === undefined ? firstPage : silentTail),
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
      expect(taskLightIds(result.current.tasks)).toEqual(["silent-first"]);
    });
    act(() => {
      result.current.fetchNextPage();
    });
    await waitFor(() => {
      expect(taskLightIds(result.current.tasks)).toEqual([
        "silent-first",
        "silent-tail",
      ]);
    });
    expect(result.current.completeness).toEqual(firstPage.completeness);
  });

  describe("T18: the negotiated epic.listTasks version gates an unverified session's initial leg", () => {
    function setUnverified(): void {
      useAuthStore.setState({
        status: "unverified",
        profile: {
          userId: USER_ID,
          userName: "Test User",
          email: "test@example.com",
        },
        contextMetadata: { userId: USER_ID, username: "test-user" },
        shareableTeams: [],
        subscriptionStatus: null,
      });
    }

    // ANNOTATED, and both fixture lists in this describe must stay annotated.
    // Left to inference, `{}` widens to `{ "epic.listTasks"?: undefined }` in a
    // union with the populated arms, and that arm is not assignable to
    // `ConnectionManifest` (`Record<string, SchemaVersion>`) - "the key is
    // present and holds nothing" is a different statement from "the key is
    // absent", which is exactly the distinction these fixtures exist to draw.
    const NEGOTIATION_FIXTURES: ReadonlyArray<{
      readonly label: string;
      readonly manifest: ConnectionManifest | null;
    }> = [
      // `null` - no handshake recorded for the host at all.
      { label: "no negotiated manifest (null)", manifest: null },
      // `false` - handshook, but the method is absent from the manifest.
      { label: "method absent from manifest (false)", manifest: {} },
      {
        label: "pre-local-first minor (1.5)",
        manifest: { "epic.listTasks": { major: 1, minor: 5 } },
      },
    ];

    it.each(NEGOTIATION_FIXTURES)(
      "disables the initial leg for an unverified session when the negotiated version is $label",
      async ({ manifest }) => {
        setUnverified();
        resetNegotiatedManifests();
        if (manifest !== null) {
          recordNegotiatedHostManifest(HOST_ID, manifest);
        }
        mockHostClient.request.mockResolvedValue({
          tasks: [taskLight("should-not-dispatch", "Must not be requested")],
          hasMore: false,
        });
        const queryClient = new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        });
        const { result, unmount } = renderHook(
          () =>
            useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, {
              enabled: true,
            }),
          { wrapper: makeWrapper(queryClient) },
        );

        await act(async () => {
          await Promise.resolve();
        });
        expect(mockHostClient.request).not.toHaveBeenCalled();
        expect(result.current.tasks).toEqual([]);
        // The refusal must be a SETTLED fact a caller can render an
        // explanation for, not merely silence: `query.isPending` alone stays
        // `true` forever for a disabled TanStack query (no data, never will
        // be), which is exactly the false "still loading" statement
        // `initialLegRefused` exists to let a caller correct.
        expect(result.current.initialLegRefused).toBe(true);
        expect(result.current.query.isPending).toBe(true);
        // This file has no global RTL `cleanup()` (see the `signed-out` test's
        // own comment above) - a surviving hook stays subscribed to the auth
        // store and the negotiated-manifest registry, both of which the NEXT
        // case in this parametrized run mutates, so a leaked mount here would
        // dispatch into a later case's assertions.
        unmount();
      },
    );

    it("enables the initial leg for an unverified session once the negotiated version is 1.6", async () => {
      setUnverified();
      resetNegotiatedManifests();
      recordNegotiatedHostManifest(HOST_ID, {
        "epic.listTasks": { major: 1, minor: 6 },
      });
      mockHostClient.request.mockResolvedValue({
        tasks: [taskLight("unverified-1-6", "Local-first serving host")],
        hasMore: false,
      });
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const { result, unmount } = renderHook(
        () =>
          useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
        { wrapper: makeWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(taskLightIds(result.current.tasks)).toEqual(["unverified-1-6"]);
      });
      expect(mockHostClient.request.mock.calls[0]?.[1]).toMatchObject({
        localFirstPhase: "initial",
      });
      expect(result.current.initialLegRefused).toBe(false);
      unmount();
    });

    // The unverified fixtures plus the 1.6 arm: a signed-in session must
    // dispatch across the WHOLE range, including the two the unverified session
    // refuses on. Annotated for the reason spelled out above `NEGOTIATION_FIXTURES`.
    const SIGNED_IN_NEGOTIATION_FIXTURES: ReadonlyArray<{
      readonly label: string;
      readonly manifest: ConnectionManifest | null;
    }> = [
      ...NEGOTIATION_FIXTURES,
      {
        label: "local-first minor (1.6)",
        manifest: { "epic.listTasks": { major: 1, minor: 6 } },
      },
    ];

    it.each(SIGNED_IN_NEGOTIATION_FIXTURES)(
      "a signed-in session always dispatches the initial leg regardless of the negotiated version ($label)",
      async ({ manifest }) => {
        // `beforeEach` already set `signed-in`; this pins that the capability
        // verdict alone is what a `signed-in` session's initial leg turns on
        // - the negotiated-version test above only matters for `unverified`.
        resetNegotiatedManifests();
        if (manifest !== null) {
          recordNegotiatedHostManifest(HOST_ID, manifest);
        }
        mockHostClient.request.mockResolvedValue({
          tasks: [taskLight("signed-in-dispatches", "Always requested")],
          hasMore: false,
        });
        const queryClient = new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        });
        const { result, unmount } = renderHook(
          () =>
            useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, {
              enabled: true,
            }),
          { wrapper: makeWrapper(queryClient) },
        );

        await waitFor(() => {
          expect(taskLightIds(result.current.tasks)).toEqual([
            "signed-in-dispatches",
          ]);
        });
        expect(result.current.initialLegRefused).toBe(false);
        unmount();
      },
    );

    // `refetch()` is a caller OVERRIDE of TanStack's own `enabled` gate
    // (query-core 5.101.4: `refetch -> fetch -> #executeFetch`, no gate
    // consulted) - the same hazard already flagged for the sharing panel's
    // manual refresh. The hook's returned `refetch` must consult
    // `initialLegRefused` itself rather than relying on the declarative
    // `enabled` to have covered it, or a refresh button / pull-to-refresh
    // under `unverified` + a pre-1.6 host dispatches a request the render-time
    // gate was supposed to prevent.
    it("makes refetch() a no-op while the initial leg is refused", async () => {
      setUnverified();
      resetNegotiatedManifests();
      recordNegotiatedHostManifest(HOST_ID, {
        "epic.listTasks": { major: 1, minor: 5 },
      });
      mockHostClient.request.mockResolvedValue({
        tasks: [taskLight("should-not-dispatch", "Must not be requested")],
        hasMore: false,
      });
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const { result, unmount } = renderHook(
        () =>
          useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
        { wrapper: makeWrapper(queryClient) },
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.initialLegRefused).toBe(true);

      act(() => {
        result.current.refetch();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockHostClient.request).not.toHaveBeenCalled();
      unmount();
    });

    // The render-captured `initialLegRefused` covers a surface that
    // re-rendered after the demotion. A refresh button holds the `refetch`
    // closure it was given, and a sentinel can fire it after the store moved
    // and before React re-rendered - so the callback re-reads the verdict and
    // the negotiated version at DISPATCH, not only at render.
    it("re-reads the verdict at dispatch: a refetch captured under a verdict is refused after the demotion", async () => {
      // `signed-in` (from `beforeEach`) on a pre-1.6 host: the initial leg is
      // admitted by the verdict alone, so withdrawing it is what closes it.
      resetNegotiatedManifests();
      recordNegotiatedHostManifest(HOST_ID, {
        "epic.listTasks": { major: 1, minor: 5 },
      });
      mockHostClient.request.mockResolvedValue({ tasks: [], hasMore: false });
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const { result, unmount } = renderHook(
        () =>
          useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
        { wrapper: makeWrapper(queryClient) },
      );
      await waitFor(() => {
        expect(mockHostClient.request).toHaveBeenCalledTimes(1);
      });
      expect(result.current.initialLegRefused).toBe(false);

      // Non-vacuity: the held closure dispatches while the verdict holds.
      const refetchHeldUnderVerdict = result.current.refetch;
      act(() => {
        refetchHeldUnderVerdict();
      });
      await waitFor(() => {
        expect(mockHostClient.request).toHaveBeenCalledTimes(2);
      });

      setUnverified();
      act(() => {
        refetchHeldUnderVerdict();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockHostClient.request).toHaveBeenCalledTimes(2);
      unmount();
    });

    it("re-reads the verdict at dispatch: a fetchNextPage captured under a verdict is refused after the demotion", async () => {
      // "Show more" is a cloud-only leg with no local fallback, so a held
      // callback firing after the demotion could only ever spend the retained
      // bearer. The gate re-reads the store at dispatch, not the render.
      mockHostClient.request.mockResolvedValue({
        tasks: [taskLight("epic-first", "First page")],
        hasMore: true,
        nextCursor: "cursor-a",
      });
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const { result, unmount } = renderHook(
        () =>
          useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
        { wrapper: makeWrapper(queryClient) },
      );
      await waitFor(() => {
        expect(result.current.hasNextPage).toBe(true);
      });
      expect(mockHostClient.request).toHaveBeenCalledTimes(1);

      const fetchNextPageHeldUnderVerdict = result.current.fetchNextPage;
      setUnverified();
      act(() => {
        fetchNextPageHeldUnderVerdict();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockHostClient.request).toHaveBeenCalledTimes(1);
      expect(result.current.isFetchingNextPage).toBe(false);
      unmount();
    });
  });
});
