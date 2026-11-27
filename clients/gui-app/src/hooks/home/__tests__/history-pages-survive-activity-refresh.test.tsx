import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ListTaskLight,
  ListTasksRequest,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { LocalHistoryReadResponse } from "@traycer/protocol/host/epic/local-history";
import type { OrganizationView } from "@traycer/protocol/host/organization/contracts";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { DEFAULT_HISTORY_SEARCH } from "@/lib/history-search";
import {
  useHistoryQuery,
  type UseHistoryQueryResult,
} from "@/hooks/home/use-history-query";
import {
  observeOwnHistoryRecordChange,
  useOptimisticActivityHistoryItems,
} from "@/hooks/home/use-optimistic-activity-history-items";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCloudEpicTasksPagesStore } from "@/stores/epics/cloud-epic-tasks-pages-store";

const HOST_ID = "host-test";
const USER_ID = "user-test";
const DEBOUNCE_MS = 750;

type MockHostResponse = ListTasksResponse | LocalHistoryReadResponse;

const mockHostClient = {
  getActiveHostId: vi.fn(() => HOST_ID),
  getRequestContextUserId: vi.fn(() => USER_ID),
  onChange: vi.fn(() => () => undefined),
  request:
    vi.fn<
      (method: string, params: ListTasksRequest) => Promise<ListTasksResponse>
    >(),
  requestWithSignal: vi.fn(
    (
      method: string,
      params: ListTasksRequest,
      _signal: AbortSignal | undefined,
    ): Promise<MockHostResponse> =>
      method === "epic.localHistory.read"
        ? Promise.resolve(emptyLocalHistory())
        : mockHostClient.request(method, params),
  ),
};

vi.mock("@/lib/host", () => ({
  useHostClient: () => mockHostClient,
  useOptionalHostClient: () => mockHostClient,
  useHostRuntimeClient: () => mockHostClient,
  useHostBinding: () => ({
    hostId: HOST_ID,
    hostClient: {
      ...mockHostClient,
      createRequesterForHostId: () => mockHostClient,
    },
  }),
}));

vi.mock("@/hooks/worktree/use-task-worktree-metadata-query", () => ({
  useTaskWorktreeMetadata: () => ({
    worktreesByEpicId: new Map(),
    isFetching: false,
    error: null,
  }),
  useWorktreeHostIndex: () => ({
    worktrees: [],
    isFetching: false,
    error: null,
  }),
  useWorktreeHostActivityIndex: () => ({
    worktrees: [],
    isFetching: false,
    error: null,
  }),
}));

vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: () => ({
    tasksById: new Map(),
    localHomedTaskIds: new Set<string>(),
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
    refetchBatches: [],
  }),
}));

vi.mock("@/hooks/organization/organization-context", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/organization/organization-context")
    >();
  const view: OrganizationView = {
    catalog: [],
    groups: { version: "0", groups: [], memberships: [] },
    appearances: [],
    taskLabels: {},
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
  };
  return {
    ...actual,
    useOrganizationTasks: () => ({ view, refresh: () => Promise.resolve() }),
  };
});

function emptyLocalHistory(): LocalHistoryReadResponse {
  return {
    complete: true,
    willComplete: true,
    localHomeRows: [],
    preservedRows: [],
    tombstonedEpicIds: [],
    localRows: "none",
  };
}

function taskLight(id: string): ListTaskLight {
  return {
    epic: {
      light: {
        id,
        title: id,
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

const FIRST_PAGE: ListTasksResponse = {
  tasks: [taskLight("page-one-a"), taskLight("page-one-b")],
  hasMore: true,
  nextCursor: "cursor-two",
};
const SECOND_PAGE: ListTasksResponse = {
  tasks: [taskLight("page-two-a"), taskLight("page-two-b")],
  hasMore: true,
  nextCursor: "cursor-three",
};
const THIRD_PAGE: ListTasksResponse = {
  tasks: [taskLight("page-three-a")],
  hasMore: false,
};

function wrapper(queryClient: QueryClient) {
  return ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function serveFirstPage(firstPage: ListTasksResponse): void {
  mockHostClient.request.mockImplementation((_method, params) => {
    if (params.cursor === "cursor-two") return Promise.resolve(SECOND_PAGE);
    if (params.cursor === "cursor-three") return Promise.resolve(THIRD_PAGE);
    return Promise.resolve(firstPage);
  });
}

async function mountHistory() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const { result } = renderHook(
    () => {
      const history = useHistoryQuery({
        search: DEFAULT_HISTORY_SEARCH,
        nowMs: null,
      });
      const items = useOptimisticActivityHistoryItems({
        items: history.data?.items ?? [],
        userId: history.currentUserId,
        hostId: history.hostId,
        enabled: true,
        refreshEnabled: true,
        refreshScope: history.activityRefreshScope,
        refetch: history.refetchTasks,
      });
      return { history, items };
    },
    { wrapper: wrapper(queryClient) },
  );
  const listedIds = (): readonly string[] =>
    (result.current.history.data?.items ?? []).map((item) => item.epicId);
  await waitFor(() => {
    expect(result.current.history.hasNextPage).toBe(true);
  });
  return { result, listedIds };
}

async function mountWithTwoPagesLoaded() {
  const { result, listedIds } = await mountHistory();
  act(() => {
    result.current.history.fetchNextPage();
  });
  await waitFor(() => {
    expect(listedIds()).toEqual([
      "page-one-a",
      "page-one-b",
      "page-two-a",
      "page-two-b",
    ]);
  });
  return { result, listedIds };
}

async function settleActivityRefresh(result: {
  readonly current: {
    readonly history: Pick<
      UseHistoryQueryResult,
      "currentUserId" | "isFetching"
    >;
  };
}): Promise<void> {
  vi.useFakeTimers();
  const dispatchesBeforeEdge = mockHostClient.request.mock.calls.length;
  const currentUserId = result.current.history.currentUserId;
  if (currentUserId === null) throw new Error("Expected a signed-in user");
  act(() => {
    observeOwnHistoryRecordChange(currentUserId, "page-one-a", Date.now() + 1);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  });
  vi.useRealTimers();
  await waitFor(() => {
    expect(mockHostClient.request.mock.calls.length).toBeGreaterThan(
      dispatchesBeforeEdge,
    );
  });
  await waitFor(() => {
    expect(result.current.history.isFetching).toBe(false);
  });
}

describe("history pages across an activity refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCloudEpicTasksPagesStore.setState({
      pagesByIdentity: {},
      generationByIdentity: {},
      identitiesWithDisplacedRowsPage: new Set<string>(),
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
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
    serveFirstPage(FIRST_PAGE);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    resetNegotiatedManifests();
  });

  it("keeps pages loaded with Show more when an activity change refreshes the first page", async () => {
    const { result, listedIds } = await mountWithTwoPagesLoaded();
    const loadedIds = [...listedIds()].sort();

    await settleActivityRefresh(result);

    expect([...listedIds()].sort()).toEqual(loadedIds);
  });

  it("keeps a row the refreshed first page no longer holds, below the first page", async () => {
    const { result, listedIds } = await mountWithTwoPagesLoaded();
    serveFirstPage({
      tasks: [taskLight("page-one-new"), taskLight("page-one-a")],
      hasMore: true,
      nextCursor: "cursor-two",
    });

    await settleActivityRefresh(result);

    expect(listedIds()).toEqual([
      "page-one-new",
      "page-one-a",
      "page-one-b",
      "page-two-a",
      "page-two-b",
    ]);
  });

  it("a manual refresh still drops the loaded pages", async () => {
    const { result, listedIds } = await mountWithTwoPagesLoaded();

    await act(async () => {
      await result.current.history.refetch();
    });

    await waitFor(() => {
      expect(listedIds()).toEqual(["page-one-a", "page-one-b"]);
    });
  });

  it("Show more continues from the last loaded page after an activity refresh", async () => {
    const { result, listedIds } = await mountWithTwoPagesLoaded();
    await settleActivityRefresh(result);

    act(() => {
      result.current.history.fetchNextPage();
    });

    await waitFor(() => {
      expect(listedIds()).toContain("page-three-a");
    });
    expect(
      mockHostClient.request.mock.calls.some(
        ([, params]) => params.cursor === "cursor-three",
      ),
    ).toBe(true);
    expect([...listedIds()].sort()).toEqual([
      "page-one-a",
      "page-one-b",
      "page-three-a",
      "page-two-a",
      "page-two-b",
    ]);
  });

  it("a Show more in flight when an activity refresh displaces a row does not drop that row", async () => {
    const { result, listedIds } = await mountHistory();
    let serveSecondPage: () => void = () => undefined;
    const secondPageGate = new Promise<void>((resolve) => {
      serveSecondPage = resolve;
    });
    mockHostClient.request.mockImplementation(async (_method, params) => {
      if (params.cursor === "cursor-two") {
        await secondPageGate;
        return SECOND_PAGE;
      }
      if (params.cursor === "cursor-displaced") {
        return {
          tasks: [taskLight("page-one-b"), taskLight("page-two-a")],
          hasMore: false,
        };
      }
      return {
        tasks: [taskLight("page-one-new"), taskLight("page-one-a")],
        hasMore: true,
        nextCursor: "cursor-displaced",
      };
    });
    act(() => {
      result.current.history.fetchNextPage();
    });
    await waitFor(() => {
      expect(result.current.history.isFetchingNextPage).toBe(true);
    });

    await settleActivityRefresh(result);
    serveSecondPage();
    await waitFor(() => {
      expect(result.current.history.isFetchingNextPage).toBe(false);
    });

    expect(listedIds()).toEqual(["page-one-new", "page-one-a"]);
    expect(result.current.history.hasNextPage).toBe(true);

    act(() => {
      result.current.history.fetchNextPage();
    });
    await waitFor(() => {
      expect(listedIds()).toEqual([
        "page-one-new",
        "page-one-a",
        "page-one-b",
        "page-two-a",
      ]);
    });
  });

  it("Select all includes the refreshed first page", async () => {
    const { result } = await mountWithTwoPagesLoaded();
    let serveThirdPage: () => void = () => undefined;
    const thirdPageGate = new Promise<void>((resolve) => {
      serveThirdPage = resolve;
    });
    mockHostClient.request.mockImplementation(async (_method, params) => {
      if (params.cursor === "cursor-three") {
        await thirdPageGate;
        return THIRD_PAGE;
      }
      return {
        tasks: [taskLight("page-one-new"), taskLight("page-one-a")],
        hasMore: true,
        nextCursor: "cursor-two",
      };
    });
    const controller = new AbortController();
    let selection: Promise<readonly HistoryItem[] | null> =
      Promise.resolve(null);
    act(() => {
      selection = result.current.history.fetchAllItems(controller.signal);
    });
    await waitFor(() => {
      expect(
        mockHostClient.request.mock.calls.some(
          ([, params]) => params.cursor === "cursor-three",
        ),
      ).toBe(true);
    });

    await settleActivityRefresh(result);
    serveThirdPage();
    const items = await selection;

    expect(items?.map((item) => item.epicId).sort()).toEqual([
      "page-one-a",
      "page-one-b",
      "page-one-new",
      "page-three-a",
      "page-two-a",
      "page-two-b",
    ]);
  });
});
