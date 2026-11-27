import { createElement, type ReactNode } from "react";
import type { RequiredHostMethodVersion } from "@traycer-clients/shared/host-transport/host-messenger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type QueryObserverResult,
  queryOptions,
} from "@tanstack/react-query";
import type {
  ListTaskLight,
  ListTasksRequest,
  ListTasksResponse,
  SetEpicPinnedResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { LocalHistoryReadResponse } from "@traycer/protocol/host/epic/local-history";
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
import {
  cloudEpicTasksPageGeneration,
  cloudEpicTasksPageIdentity,
  useCloudEpicTasksPagesStore,
} from "@/stores/epics/cloud-epic-tasks-pages-store";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksLastKnownQueryKey,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import * as cloudEpicTasksCache from "@/lib/cloud-epic-tasks-query/cache";
import { removeDeletedEpicsFromCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import {
  type ComputerLocalHomeHistoryRow,
  completeLocalHistoryRead,
  computerLocalHomeRow,
  computerPageWithLocalRowsAt16,
  computerTombstonedCloudTailPageAt16,
  directHistoryGrant,
  injectedComputerTailCursorFaultAt16,
  injectedOldSchemaCachedTail,
  legacyComputerPageAt15,
  pendingLocalFirstCachePage,
  computerPinAcknowledgementAt11,
  poolListedTaskAt16,
  settledComputerCloudPageAt16,
  settledComputerCloudTailPageAt16,
  unavailableComputerPageAt16,
} from "@/lib/history-composition/test-support/history-wire-fixtures";

const HOST_ID = "host-test";
const USER_ID = "user-test";

type MockHostRequest = ListTasksRequest & { readonly pinned?: boolean };
type MockHostResponse =
  | ListTasksResponse
  | LocalHistoryReadResponse
  | SetEpicPinnedResponse
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

function emptyLocalHistory(): LocalHistoryReadResponse {
  return completeLocalHistoryRead([], [], []);
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
    ): Promise<MockHostResponse> =>
      method === "epic.localHistory.read"
        ? Promise.resolve(mockHostClient.localHistory.current)
        : mockHostClient.request(method, params),
  ),
  // The entry point an UNVERIFIED local-first leg dispatches on: it carries a
  // floor the real transport answers from its own handshake. Delegating to the
  // same `request` spy is what a host that MEETS the floor does, which is the
  // host every unverified case here sets up (`epic.listTasks@1.6` negotiated).
  // The floor itself is recorded rather than dropped so a case can still tell
  // the unverified path from the authorized one.
  requestWithSignalRequiringHostMethodVersion: vi.fn(
    (
      method: string,
      params: MockHostRequest,
      _signal: AbortSignal | undefined,
      requiredHostMethodVersion: RequiredHostMethodVersion,
    ): Promise<MockHostResponse> => {
      mockHostClient.floorsRequested.push(requiredHostMethodVersion);
      return mockHostClient.request(method, params);
    },
  ),
  floorsRequested: new Array<RequiredHostMethodVersion>(),
  // What the host's `epic.localHistory.read` answers: by default a complete
  // contribution with nothing in it, so a page composes with no local rows.
  localHistory: { current: emptyLocalHistory() },
};

vi.mock("@/lib/host", () => ({
  useHostClient: () => mockHostClient,
  // The SPINE, a separate export.
  useHostRuntimeClient: () => mockHostClient,
  // Reached since `useEpicRecordViewed` took its host as an argument: the
  // client for a NAMED host is built from the binding, so a mock that stops at
  // `useHostClient` leaves the resolver calling an undefined export.
  useHostBinding: () => ({
    hostId: HOST_ID,
    hostClient: {
      ...mockHostClient,
      createRequesterForHostId: () => mockHostClient,
    },
  }),
}));

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function taskLight(id: string, title: string): ListTaskLight {
  return poolListedTaskAt16({
    id,
    title,
    grant: directHistoryGrant("owner", USER_ID),
    pinned: false,
    updatedAt: 0,
  });
}

function localTaskLight(
  id: string,
  title: string,
  recentAt: number,
): ComputerLocalHomeHistoryRow {
  return computerLocalHomeRow({
    id,
    title,
    recentAt,
    pinned: false,
    userId: USER_ID,
    createdAt: 0,
    updatedAt: recentAt,
  });
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

/**
 * The `epic.listTasks` dispatches alone. An unverified initial leg also sends
 * a `host.status` probe before it, so a raw call count over-reads by one.
 */
function listTasksCalls(): Array<[string, unknown]> {
  return mockHostClient.request.mock.calls
    .filter(([method]) => method === "epic.listTasks")
    .map(([method, params]) => [String(method), params]);
}

describe("useCloudEpicTasksQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `vi.clearAllMocks()` resets the spies but not this plain array, and it
    // is asserted by exact contents - left accumulating, a later case reads an
    // earlier one's dispatch as its own.
    mockHostClient.floorsRequested.length = 0;
    mockHostClient.localHistory.current = emptyLocalHistory();
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

  it("fetches all matching cursor pages and deduplicates their tasks", async () => {
    const pages: ListTasksResponse[] = [
      settledComputerCloudPageAt16(
        [taskLight("first", "First")],
        { hasMore: true, nextCursor: "a" },
        USER_ID,
      ),
      settledComputerCloudTailPageAt16(
        [taskLight("first", "Duplicate"), taskLight("second", "Second")],
        { hasMore: true, nextCursor: "b" },
      ),
      settledComputerCloudTailPageAt16([taskLight("third", "Third")], {
        hasMore: false,
        nextCursor: undefined,
      }),
    ];
    mockHostClient.request.mockImplementation((_method, params) => {
      let index = 0;
      if (params.cursor === "a") index = 1;
      if (params.cursor === "b") index = 2;
      const page = pages.at(index);
      if (page === undefined) throw new Error("Expected fixture page");
      return Promise.resolve(page);
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
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      const tasks = await result.current.fetchAllPages(
        new AbortController().signal,
      );
      expect(tasks?.map((task) => task.epic?.light?.title)).toEqual([
        "First",
        "Second",
        "Third",
      ]);
    });
    expect(listTasksCalls().map(([, params]) => params)).toEqual([
      expect.objectContaining(LIST_CLOUD_TASKS_REQUEST),
      expect.objectContaining({ ...LIST_CLOUD_TASKS_REQUEST, cursor: "a" }),
      expect.objectContaining({ ...LIST_CLOUD_TASKS_REQUEST, cursor: "b" }),
    ]);
    expect(taskLightIds(result.current.tasks)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it.each(["repeated cursor", "missing cursor", "request error"] as const)(
    "refuses an incomplete bulk result after an injected %s fault",
    async (failure) => {
      mockHostClient.request.mockImplementation((_method, params) => {
        if (params.cursor === undefined)
          return Promise.resolve(
            settledComputerCloudPageAt16(
              [taskLight("first", "First")],
              { hasMore: true, nextCursor: "a" },
              USER_ID,
            ),
          );
        if (failure === "request error")
          return Promise.reject(new Error("Cannot load page"));
        return Promise.resolve(
          injectedComputerTailCursorFaultAt16(
            [taskLight("second", "Second")],
            failure,
            params.cursor,
          ),
        );
      });
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const { result } = renderHook(
        () =>
          useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
        { wrapper: makeWrapper(queryClient) },
      );
      await waitFor(() => expect(result.current.hasNextPage).toBe(true));
      await act(async () => {
        expect(
          await result.current.fetchAllPages(new AbortController().signal),
        ).toBeNull();
      });
      expect(listTasksCalls()).toHaveLength(2);
    },
  );

  it.each(["cancel", "refresh", "authorization withdrawn"])(
    "drops bulk results and stops paging after %s",
    async (transition) => {
      const tail = createDeferred<ListTasksResponse>();
      mockHostClient.request.mockImplementation((_method, params) =>
        params.cursor === undefined
          ? Promise.resolve(
              settledComputerCloudPageAt16(
                [taskLight("first", "First")],
                { hasMore: true, nextCursor: "a" },
                USER_ID,
              ),
            )
          : tail.promise,
      );
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const { result } = renderHook(
        () =>
          useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
        { wrapper: makeWrapper(queryClient) },
      );
      await waitFor(() => expect(result.current.hasNextPage).toBe(true));
      const controller = new AbortController();
      const allPages = result.current.fetchAllPages(controller.signal);
      await waitFor(() => expect(listTasksCalls()).toHaveLength(2));
      act(() => {
        if (transition === "cancel") controller.abort();
        if (transition === "refresh") {
          const store = useCloudEpicTasksPagesStore.getState();
          Object.keys(store.generationByIdentity).forEach(store.resetIdentity);
        }
        if (transition === "authorization withdrawn")
          useAuthStore.setState({ status: "unverified" });
      });
      await act(async () => {
        tail.resolve(
          settledComputerCloudTailPageAt16([taskLight("second", "Second")], {
            hasMore: true,
            nextCursor: "b",
          }),
        );
        expect(await allPages).toBeNull();
      });
      expect(listTasksCalls()).toHaveLength(2);
      expect(taskLightIds(result.current.tasks)).toEqual(["first"]);
    },
  );

  it("admits #4's unverified stored identity to local-first History", async () => {
    // The cohort this whole feature exists for: a stored identity on disk that
    // authn could not confirm. `root-landing-page.tsx` renders `/epics` for it,
    // so it reaches History - and every gate below here has to agree that it
    // did, or it arrives to "No tasks yet" over its own rows.
    // An unverified session sends no cloud read: its first page is the host's
    // own contribution (`epic.localHistory.read`), stated as a page whose
    // cloud half is unavailable.
    mockHostClient.localHistory.current = completeLocalHistoryRead(
      [localTaskLight("unverified-local", "Served from this disk", 1)],
      [],
      [],
    );
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
    // The cloud leg is refused at dispatch without a verdict: no
    // `epic.listTasks` leaves.
    expect(listTasksCalls()).toHaveLength(0);

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
    const oldHostPage: ListTasksResponse = legacyComputerPageAt15(
      [taskLight("old-host-epic", "Released behaviour")],
      { hasMore: false, nextCursor: undefined },
      USER_ID,
    );
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
    const localRow = localTaskLight("offline-local", "Still available", 1);
    const pendingLocalPage = pendingLocalFirstCachePage([localRow]);
    mockHostClient.request.mockImplementation(
      (_method: string, params: { readonly localFirstPhase?: string }) => {
        if (params.localFirstPhase !== "revalidate") {
          return Promise.reject(new Error("Unexpected initial list dispatch"));
        }
        return Promise.reject(new Error("offline"));
      },
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
    queryClient.setQueryData(
      cloudEpicTasksQueryKey(HOST_ID, USER_ID, LIST_CLOUD_TASKS_REQUEST),
      pendingLocalPage,
    );
    mockHostClient.localHistory.current = completeLocalHistoryRead(
      [localRow],
      [],
      [],
    );
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
    const localRow = localTaskLight(
      "promoted-local",
      "Served from this disk",
      1,
    );
    const unavailableLocalPage = unavailableComputerPageAt16([localRow]);
    const revalidatedPage = computerPageWithLocalRowsAt16(
      [taskLight("promoted-cloud", "Cloud page")],
      [localRow],
      { hasMore: false, nextCursor: undefined },
      USER_ID,
    );
    // The unverified first page is the host's contribution alone; once the
    // session holds a verdict the pool's page is composed with it.
    mockHostClient.localHistory.current = completeLocalHistoryRead(
      [localRow],
      [],
      [],
    );
    mockHostClient.request.mockImplementation((_method, params) =>
      params.localFirstPhase === "revalidate"
        ? Promise.resolve(revalidatedPage)
        : Promise.resolve(unavailableLocalPage),
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
    expect(taskLightIds(result.current.tasks)).toEqual([
      "promoted-local",
      "promoted-cloud",
    ]);
  });

  it("reopens the unavailable pages every host left for this user on promotion, and no other user's", async () => {
    // The verdict that was missing is the SESSION's, and the account's cloud
    // tasks are one list whichever host serves it. A History page host B
    // settled to `unavailable` while the session was unverified has no hook
    // mounted to observe the promotion, so the hook that IS mounted (bound to
    // host A here) reopens it - otherwise a History tab bound to B, opened
    // later, serves B's infinite-stale `unavailable` page for the rest of the
    // session. The user boundary still holds: another account's page on the
    // same host is not this session's to reopen.
    const localRow = localTaskLight(
      "promoted-local",
      "Served from this disk",
      1,
    );
    const unavailablePage = unavailableComputerPageAt16([localRow]);
    const revalidatedPage = computerPageWithLocalRowsAt16(
      [taskLight("promoted-cloud", "Cloud page")],
      [localRow],
      { hasMore: false, nextCursor: undefined },
      USER_ID,
    );
    // The unverified first page is the host's contribution alone; once the
    // session holds a verdict the pool's page is composed with it.
    mockHostClient.localHistory.current = completeLocalHistoryRead(
      [localRow],
      [],
      [],
    );
    mockHostClient.request.mockImplementation((_method, params) =>
      params.localFirstPhase === "revalidate"
        ? Promise.resolve(revalidatedPage)
        : Promise.resolve(unavailablePage),
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
    const otherHostKey = cloudEpicTasksQueryKey(
      "host-other",
      USER_ID,
      LIST_CLOUD_TASKS_REQUEST,
    );
    const otherUserKey = cloudEpicTasksQueryKey(
      "host-other",
      "user-other",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(otherHostKey, unavailablePage);
    queryClient.setQueryData(otherUserKey, unavailablePage);
    const { result } = renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );
    await waitFor(() => {
      expect(result.current.query.data?.completeness?.cloudPage).toBe(
        "unavailable",
      );
    });

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
      expect(result.current.query.data?.completeness?.cloudPage).toBe(
        "settled",
      );
    });
    // Host B's page is reopened (nothing observes it here, so it rests at
    // `pending` until a History bound to B mounts and revalidates it)...
    expect(
      queryClient.getQueryData<ListTasksResponse>(otherHostKey)?.completeness
        ?.cloudPage,
    ).toBe("pending");
    // ... and the other account's page is untouched.
    expect(
      queryClient.getQueryData<ListTasksResponse>(otherUserKey)?.completeness
        ?.cloudPage,
    ).toBe("unavailable");
  });

  it("keeps an unresolved local-first cache follow-up from overwriting a fresh History page", async () => {
    const localRow = localTaskLight("first-local", "Before refresh", 1);
    const pendingCachePage = pendingLocalFirstCachePage([localRow]);
    const refreshedPage = computerPageWithLocalRowsAt16(
      [taskLight("fresh-cloud", "Fresh page")],
      [localRow],
      { hasMore: false, nextCursor: undefined },
      USER_ID,
    );
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
        return Promise.resolve(refreshedPage);
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(
      cloudEpicTasksQueryKey(HOST_ID, USER_ID, LIST_CLOUD_TASKS_REQUEST),
      pendingCachePage,
    );
    mockHostClient.localHistory.current = completeLocalHistoryRead(
      [localRow],
      [],
      [],
    );
    const { result } = renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(resolveRevalidations).toHaveLength(1);
      expect(taskLightIds(result.current.tasks)).toEqual(["first-local"]);
    });

    // The raw `query.refetch` is what this hook's guarded `refetch` delegates
    // to once it admits the leg (and what `useHistoryQuery` exposed directly
    // before it adopted the guarded callback), so the episode boundary is
    // pinned on the raw path: starting a query-owned episode here must
    // supersede the unresolved predecessor before its response can overwrite
    // the fresh page.
    await act(async () => {
      await result.current.query.refetch();
    });
    await waitFor(() => {
      expect(initialCalls).toBe(1);
      expect(resolveRevalidations).toHaveLength(1);
      expect(taskLightIds(result.current.tasks)).toEqual([
        "first-local",
        "fresh-cloud",
      ]);
    });

    await act(async () => {
      resolveRevalidations[0]?.(
        settledComputerCloudPageAt16(
          [taskLight("stale-cloud", "Must not overwrite refresh")],
          { hasMore: false, nextCursor: undefined },
          USER_ID,
        ),
      );
      await Promise.resolve();
    });
    expect(taskLightIds(result.current.tasks)).toEqual([
      "first-local",
      "fresh-cloud",
    ]);
  });

  it("does not render its consumer when a settled page refetches unchanged", async () => {
    const page = settledComputerCloudPageAt16(
      [taskLight("unchanged", "Unchanged task")],
      { hasMore: false, nextCursor: undefined },
      USER_ID,
    );
    mockHostClient.request.mockResolvedValueOnce(page);
    const refetchedPage = createDeferred<ListTasksResponse>();
    mockHostClient.request.mockReturnValue(refetchedPage.promise);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        const query = useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, {
          enabled: true,
        });
        return { tasks: query.tasks, refetch: query.query.refetch };
      },
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() =>
      expect(taskLightIds(result.current.tasks)).toEqual(["unchanged"]),
    );
    const settledRenderCount = renders;
    let refetchPromise:
      | Promise<QueryObserverResult<ListTasksResponse>>
      | undefined;
    act(() => {
      refetchPromise = result.current.refetch();
    });
    await waitFor(() => expect(listTasksCalls()).toHaveLength(2));
    await act(async () => {
      refetchedPage.resolve(page);
      if (refetchPromise === undefined) {
        throw new Error("Expected the refetch to start before resolving it.");
      }
      await refetchPromise;
    });

    expect(renders).toBe(settledRenderCount);
  });

  it("waits for a pending local-first page refetch before revalidating", async () => {
    const localRow = localTaskLight("pending-local", "Pending local task", 1);
    const pendingPage = pendingLocalFirstCachePage([localRow]);
    const settledPage = computerPageWithLocalRowsAt16(
      [taskLight("pending-cloud", "Cloud task")],
      [localRow],
      { hasMore: false, nextCursor: undefined },
      USER_ID,
    );
    const resolveRefetch = createDeferred<ListTasksResponse>();
    const resolveRevalidation = createDeferred<ListTasksResponse>();
    mockHostClient.request.mockReturnValue(resolveRevalidation.promise);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const queryKey = cloudEpicTasksQueryKey(
      HOST_ID,
      USER_ID,
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(queryKey, pendingPage);
    const refetchPromise = queryClient.fetchQuery(
      queryOptions({
        queryKey,
        // This fetch re-publishes an app-cached pending page; it does not
        // pretend the host RPC can return the client-only pending state.
        queryFn: () => resolveRefetch.promise,
        staleTime: 0,
      }),
    );
    vi.useFakeTimers();
    const { result } = renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );

    expect(taskLightIds(result.current.tasks)).toEqual(["pending-local"]);
    try {
      // Past the request-context wait, the one timer a revalidation dispatch
      // can be held on, while the refetch is still out.
      await act(() => vi.advanceTimersByTimeAsync(15_001));
    } finally {
      vi.useRealTimers();
    }
    expect(mockHostClient.request).not.toHaveBeenCalled();
    await act(async () => {
      resolveRefetch.resolve(pendingPage);
      await refetchPromise;
    });
    await waitFor(() => {
      expect(mockHostClient.request).toHaveBeenCalledTimes(1);
      expect(mockHostClient.request.mock.calls[0]?.[1]).toMatchObject({
        localFirstPhase: "revalidate",
      });
    });
    act(() => {
      resolveRevalidation.resolve(settledPage);
    });
    await waitFor(() =>
      expect(result.current.completeness?.cloudPage).toBe("settled"),
    );
  });

  it("keeps an unresolved local-first cache follow-up from overwriting a pin refresh", async () => {
    const localRow = localTaskLight("pending-local", "Before pin", 1);
    const pendingCachePage = pendingLocalFirstCachePage([localRow]);
    const refreshedPage = computerPageWithLocalRowsAt16(
      [
        poolListedTaskAt16({
          id: "pin-local",
          title: "After pin",
          grant: directHistoryGrant("owner", USER_ID),
          pinned: true,
          updatedAt: 2,
        }),
      ],
      [localRow],
      { hasMore: false, nextCursor: undefined },
      USER_ID,
    );
    const oldRevalidation = createDeferred<ListTasksResponse>();
    let listCalls = 0;
    mockHostClient.request.mockImplementation(
      (
        method: string,
        params: ListTasksRequest & { readonly pinned?: boolean },
      ) => {
        if (method === "epic.setPinned") {
          return Promise.resolve(
            computerPinAcknowledgementAt11(params.pinned ?? false, "cloud"),
          );
        }
        if (params.localFirstPhase === "revalidate") {
          return oldRevalidation.promise;
        }
        listCalls += 1;
        return Promise.resolve(refreshedPage);
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(
      cloudEpicTasksQueryKey(HOST_ID, USER_ID, LIST_CLOUD_TASKS_REQUEST),
      pendingCachePage,
    );
    mockHostClient.localHistory.current = completeLocalHistoryRead(
      [localRow],
      [],
      [],
    );
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
      expect(mockHostClient.request.mock.calls).toHaveLength(1);
      expect(mockHostClient.request.mock.calls[0]?.[1]).toMatchObject({
        localFirstPhase: "revalidate",
      });
      expect(taskLightIds(result.current.tasks.tasks)).toEqual([
        "pending-local",
      ]);
    });

    // `useEpicSetPinned` invalidates active list queries itself. The next
    // initial dispatch returns a producer-shaped full page. The pending cache
    // follow-up from before the pin must not replace that newer page.
    act(() => {
      result.current.pin.mutate({
        epicId: "pin-local",
        pinned: true,
        isLocalHome: false,
        // The cloud control: no host named, so the write follows the window -
        // which is what this case has always exercised. Omitting it passed only
        // because the binding mock ignores the requester id it is asked for.
        hostId: null,
      });
    });
    await waitFor(() => {
      expect(listCalls).toBe(1);
      expect(taskLightIds(result.current.tasks.tasks)).toEqual([
        "pin-local",
        "pending-local",
      ]);
    });
    await act(async () => {
      oldRevalidation.resolve(
        computerPageWithLocalRowsAt16(
          [taskLight("before-pin-cloud", "Before pin revalidation")],
          [localRow],
          { hasMore: false, nextCursor: undefined },
          USER_ID,
        ),
      );
      await Promise.resolve();
    });
    expect(taskLightIds(result.current.tasks.tasks)).toEqual([
      "pin-local",
      "pending-local",
    ]);
  });

  it("starts a fresh bounded episode after the active record-viewed invalidation", async () => {
    const lastViewedRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      sort: "last-viewed" as const,
    };
    const localRow = localTaskLight("view-local", "Before view", 1);
    const updatedLocalRow = localTaskLight("view-local", "After view", 2);
    const pendingCachePage = pendingLocalFirstCachePage([localRow]);
    const refreshedPage = computerPageWithLocalRowsAt16(
      [],
      [updatedLocalRow],
      { hasMore: false, nextCursor: undefined },
      USER_ID,
    );
    const oldRevalidation = createDeferred<ListTasksResponse>();
    let listCalls = 0;
    mockHostClient.request.mockImplementation(
      (method: string, params: ListTasksRequest) => {
        if (method === "epic.recordViewed") {
          return Promise.resolve({});
        }
        if (params.localFirstPhase === "revalidate") {
          return oldRevalidation.promise;
        }
        listCalls += 1;
        return Promise.resolve(refreshedPage);
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(
      cloudEpicTasksQueryKey(HOST_ID, USER_ID, lastViewedRequest),
      pendingCachePage,
    );
    mockHostClient.localHistory.current = completeLocalHistoryRead(
      [localRow],
      [],
      [],
    );
    const { result } = renderHook(
      () => ({
        tasks: useCloudEpicTasksQuery(lastViewedRequest, { enabled: true }),
        recordViewed: useEpicRecordViewed(HOST_ID),
      }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(mockHostClient.request.mock.calls).toHaveLength(1);
      expect(mockHostClient.request.mock.calls[0]?.[1]).toMatchObject({
        localFirstPhase: "revalidate",
      });
      expect(taskLightIds(result.current.tasks.tasks)).toEqual(["view-local"]);
    });

    act(() => {
      // `isLocalHome: true` matches this fixture's own framing - the row is
      // served from the LOCAL page - and keeps the dispatch admissible
      // whatever the session verdict is, so this stays a test about cache
      // invalidation rather than one that also depends on the cloud gate.
      result.current.recordViewed.mutate({
        epicId: "view-local",
        isLocalHome: true,
      });
    });
    await waitFor(() => {
      expect(listCalls).toBe(1);
      expect(taskLightIds(result.current.tasks.tasks)).toEqual(["view-local"]);
    });
    await act(async () => {
      oldRevalidation.resolve(
        computerPageWithLocalRowsAt16(
          [taskLight("stale-view-cloud", "Stale view revalidation")],
          [localRow],
          { hasMore: false, nextCursor: undefined },
          USER_ID,
        ),
      );
      await Promise.resolve();
    });
    expect(taskLightIds(result.current.tasks.tasks)).toEqual(["view-local"]);
  });

  it("rejects a deleted tail response that resolves after delete lands mid-flight", async () => {
    const firstPage = settledComputerCloudPageAt16(
      [taskLight("epic-first", "First page task")],
      { hasMore: true, nextCursor: "cursor-a" },
      USER_ID,
    );
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
    // production `fetchNextPage` - the exact call path
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
      resolveStaleTail?.(
        settledComputerCloudTailPageAt16(
          [taskLight("epic-stale", "Stale tail task")],
          { hasMore: false, nextCursor: undefined },
        ),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.isFetchingNextPage).toBe(false);
    });

    // The stale tail must not be appended to - or rendered in - the task list.
    expect(taskLightIds(result.current.tasks)).toEqual(["epic-first"]);
  });

  it("filters a deleted row from a cursor request started after the delete", async () => {
    const firstPage = settledComputerCloudPageAt16(
      [taskLight("epic-first", "First page task")],
      { hasMore: true, nextCursor: "cursor-after-delete" },
      USER_ID,
    );
    const staleCloudTail = settledComputerCloudTailPageAt16(
      [taskLight("epic-deleted-after", "Deleted before fetch")],
      { hasMore: false, nextCursor: undefined },
    );
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
    const staleCloudFirstPage = settledComputerCloudPageAt16(
      [taskLight("epic-deleted-direct-first", "Deleted before response")],
      { hasMore: false, nextCursor: undefined },
      USER_ID,
    );
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
    const staleCloudFirstPage = settledComputerCloudPageAt16(
      [taskLight("epic-deleted-direct-race", "Deleted during delivery")],
      { hasMore: false, nextCursor: undefined },
      USER_ID,
    );
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
      // The serving tier's page, the composed page, and TanStack's own write.
      expect(admissionSpy).toHaveBeenCalledTimes(3);
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
    const firstPage = settledComputerCloudPageAt16(
      [taskLight("before-refresh", "Before refresh")],
      { hasMore: true, nextCursor: "cursor-before-refresh" },
      USER_ID,
    );
    const retainedTail = settledComputerCloudTailPageAt16(
      [taskLight("retained-tail", "Retained tail")],
      { hasMore: false, nextCursor: undefined },
    );
    const refreshedFirstPage = settledComputerCloudPageAt16(
      [taskLight("after-refresh", "After refresh")],
      { hasMore: false, nextCursor: undefined },
      USER_ID,
    );
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

    // Raw `query.refetch`, deliberately: the guarded `refetch` delegates to
    // it once the leg is admitted, and any other caller that reaches for the
    // raw callback lands here too. The queryFn must own the reset so every
    // caller observes the same generation boundary.
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
    const firstPage = settledComputerCloudPageAt16(
      [taskLight("epic-first", "First page task")],
      { hasMore: true, nextCursor: "cursor-a" },
      USER_ID,
    );
    const tailPage = settledComputerCloudTailPageAt16(
      [
        taskLight("epic-first", "Duplicate of the first-page task"),
        taskLight("epic-second", "Tail-only task"),
      ],
      { hasMore: false, nextCursor: undefined },
    );
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
    // Promotion happens during the search
    // debounce / while a structured-filter request is still pending, so the
    // promoted tab's request has never settled. The modal and the promoted
    // tab render `EpicsListPanel` separately, so promotion destroys one
    // `QueryObserver` and mounts a fresh one for the promoted request - here,
    // `LIST_CLOUD_TASKS_REQUEST` (modal) vs. `promotedRequest` (tab).
    const settledFirstPage = settledComputerCloudPageAt16(
      [taskLight("epic-settled", "Settled task")],
      { hasMore: false, nextCursor: undefined },
      USER_ID,
    );
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
        )?.tasks,
      ).toEqual(
        settledFirstPage.tasks.map((task) => ({
          ...task,
          listedByPeerId: HOST_ID,
        })),
      );
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
    expect(tabRender.result.current.tasks[0]?.listedByPeerId).toBe(HOST_ID);
    expect(tabRender.result.current.query.isPlaceholderData).toBe(true);

    // The promoted request has started fetching in the background - wait for
    // it to actually reach the mock before resolving it, since the fetch
    // itself is dispatched from a passive effect.
    await waitFor(() => {
      expect(resolvePromotedRequest).toBeDefined();
    });

    await act(async () => {
      resolvePromotedRequest?.(
        settledComputerCloudPageAt16(
          [taskLight("epic-promoted", "Promoted task")],
          { hasMore: false, nextCursor: undefined },
          USER_ID,
        ),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(taskLightIds(tabRender.result.current.tasks)).toEqual([
        "epic-promoted",
      ]);
    });
  });

  it("keeps an already-pending local-first cache page rendered through revalidation and fences a late deleted row", async () => {
    const localRow = localTaskLight("local-epic", "On this device", 1);
    const pendingLocalPage = pendingLocalFirstCachePage([localRow]);
    const revalidation = createDeferred<ListTasksResponse>();
    mockHostClient.request.mockImplementation(
      (_method: string, params: { readonly localFirstPhase?: string }) => {
        if (params.localFirstPhase === "revalidate") {
          return revalidation.promise;
        }
        return Promise.reject(new Error("Unexpected initial list dispatch"));
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(
      cloudEpicTasksQueryKey(HOST_ID, USER_ID, LIST_CLOUD_TASKS_REQUEST),
      pendingLocalPage,
    );
    mockHostClient.localHistory.current = completeLocalHistoryRead(
      [localRow],
      [],
      [],
    );
    const { result } = renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(mockHostClient.request).toHaveBeenCalledTimes(1);
      expect(mockHostClient.request.mock.calls[0]?.[1]).toMatchObject({
        localFirstPhase: "revalidate",
      });
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
    // The delete lands after admission but before the pending first page is
    // replaced. The primary Query's cache-write fence must re-read the ledger
    // for this revalidation write too.
    const lateCloudRow = taskLight("late-cloud-row", "Stale cloud row");
    void revalidation.promise.then(() => {
      removeDeletedEpicsFromCloudTaskCaches(
        queryClient,
        { hostId: HOST_ID, userId: USER_ID },
        ["late-cloud-row"],
      );
    });

    await act(async () => {
      revalidation.resolve(
        computerPageWithLocalRowsAt16(
          [lateCloudRow],
          [localRow],
          { hasMore: false, nextCursor: undefined },
          USER_ID,
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(taskLightIds(result.current.tasks)).toEqual(["local-epic"]);
      expect(result.current.query.data?.completeness?.cloudPage).toBe(
        "settled",
      );
    });
  });

  it("reports revalidation for an already-pending empty caller-filtered cache page", async () => {
    // A prior caller-owned tombstone can leave this app cache page empty.
    // Pending is the hook's reopened cache state, not a host list reply.
    const pendingLocalPage = pendingLocalFirstCachePage([]);
    const revalidation = createDeferred<ListTasksResponse>();
    mockHostClient.request.mockReturnValue(revalidation.promise);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(
      cloudEpicTasksQueryKey(HOST_ID, USER_ID, LIST_CLOUD_TASKS_REQUEST),
      pendingLocalPage,
    );
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
      revalidation.resolve(
        settledComputerCloudPageAt16(
          [taskLight("cloud-row", "Cloud page landed")],
          { hasMore: false, nextCursor: undefined },
          USER_ID,
        ),
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.isCloudPagePending).toBe(false);
      expect(taskLightIds(result.current.tasks)).toEqual(["cloud-row"]);
    });
  });

  it("unions completeness across settled pages when the cursor host applies a tombstone", async () => {
    const deletedTailRow = taskLight("deleted-on-tail", "Caller tombstone");
    const firstPage = settledComputerCloudPageAt16(
      [taskLight("union-first", "First page")],
      { hasMore: true, nextCursor: "cursor-union" },
      USER_ID,
    );
    const tailPage = computerTombstonedCloudTailPageAt16(
      [deletedTailRow, taskLight("union-tail", "Tail page")],
      ["deleted-on-tail"],
      { hasMore: false, nextCursor: undefined },
    );
    mockHostClient.localHistory.current = completeLocalHistoryRead(
      [],
      [],
      ["deleted-on-tail"],
    );
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
    // The first page is the ordinary settled host response. The tail's
    // missing row and partial facets come from a real tombstone application.
    expect(result.current.completeness).toEqual({
      ...firstPage.completeness,
      localRows: "none",
    });

    act(() => {
      result.current.fetchNextPage();
    });
    await waitFor(() => {
      expect(taskLightIds(result.current.tasks)).toEqual([
        "union-first",
        "union-tail",
      ]);
    });
    expect(taskLightIds(result.current.tasks)).not.toContain("deleted-on-tail");
    expect(result.current.completeness).toEqual({
      cloudPage: "settled",
      facets: "partial",
      localRows: "none",
      sort: "server",
    });
  });

  it("keeps first-page completeness when an injected old-schema cached tail is silent", async () => {
    const localRow = localTaskLight("silent-first", "First page local row", 1);
    const firstPage = computerPageWithLocalRowsAt16(
      [taskLight("silent-cloud-first", "First page cloud row")],
      [localRow],
      { hasMore: true, nextCursor: "cursor-silent" },
      USER_ID,
    );
    const silentTail = injectedOldSchemaCachedTail([
      taskLight("silent-tail", "Tail with no statement"),
    ]);
    mockHostClient.localHistory.current = completeLocalHistoryRead(
      [localRow],
      [],
      [],
    );
    mockHostClient.request.mockResolvedValue(firstPage);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const identity = cloudEpicTasksPageIdentity(
      HOST_ID,
      USER_ID,
      LIST_CLOUD_TASKS_REQUEST,
    );
    const { result } = renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(taskLightIds(result.current.tasks)).toEqual([
        "silent-first",
        "silent-cloud-first",
      ]);
    });
    // This schema fault can only exist in a retained app cache: one live
    // negotiated host cannot send a page without completeness beside this
    // current first page. The host has already published that first page, so
    // inject the legacy retained tail into the pages store at its active
    // generation without inventing a cursor RPC response.
    useCloudEpicTasksPagesStore
      .getState()
      .appendPage(identity, cloudEpicTasksPageGeneration(identity), silentTail);
    await waitFor(() => {
      expect(taskLightIds(result.current.tasks)).toEqual([
        "silent-first",
        "silent-cloud-first",
        "silent-tail",
      ]);
    });
    expect(result.current.completeness).toEqual({
      cloudPage: "settled",
      facets: "partial",
      localRows: "present",
      sort: "loaded-union",
    });
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
        mockHostClient.request.mockRejectedValue(
          new Error("This negotiated-gate case must not dispatch a wire read."),
        );
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

    it("serves an unverified session its first page from the host's contribution once the negotiated version is 1.6, sending no cloud read", async () => {
      setUnverified();
      resetNegotiatedManifests();
      recordNegotiatedHostManifest(HOST_ID, {
        "epic.listTasks": { major: 1, minor: 6 },
      });
      mockHostClient.localHistory.current = {
        ...emptyLocalHistory(),
        localHomeRows: [
          localTaskLight("unverified-1-6", "Local-first serving host", 1),
        ],
        localRows: "present",
      };
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
      // The cloud leg is refused at dispatch without a verdict, so no
      // `epic.listTasks` leaves and no version floor travels.
      expect(listTasksCalls()).toHaveLength(0);
      expect(mockHostClient.floorsRequested).toEqual([]);
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
        mockHostClient.request.mockRejectedValue(
          new Error("The dispatch-gate test does not model a wire response."),
        );
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
          expect(mockHostClient.request).toHaveBeenCalledTimes(1);
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
      mockHostClient.request.mockRejectedValue(
        new Error("The refused refetch must not dispatch a wire read."),
      );
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

      // A refused refresh still RESOLVES - a pull-to-refresh awaits it to end
      // its spinner - it just dispatches nothing.
      await act(async () => {
        await result.current.refetch();
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
      mockHostClient.request.mockResolvedValue(
        legacyComputerPageAt15(
          [],
          { hasMore: false, nextCursor: undefined },
          USER_ID,
        ),
      );
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
        void refetchHeldUnderVerdict();
      });
      await waitFor(() => {
        expect(mockHostClient.request).toHaveBeenCalledTimes(2);
      });

      setUnverified();
      await act(async () => {
        await refetchHeldUnderVerdict();
      });
      expect(mockHostClient.request).toHaveBeenCalledTimes(2);
      unmount();
    });

    it("re-reads the verdict at dispatch: a fetchNextPage captured under a verdict is refused after the demotion", async () => {
      // "Show more" is a cloud-only leg with no local fallback, so a held
      // callback firing after the demotion could only ever spend the retained
      // bearer. The gate re-reads the store at dispatch, not the render.
      mockHostClient.request.mockResolvedValue(
        settledComputerCloudPageAt16(
          [taskLight("epic-first", "First page")],
          { hasMore: true, nextCursor: "cursor-a" },
          USER_ID,
        ),
      );
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
