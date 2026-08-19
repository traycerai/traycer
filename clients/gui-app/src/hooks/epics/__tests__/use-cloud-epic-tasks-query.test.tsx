import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ListTaskLight,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  resetCloudEpicTasksPagesForScope,
  useCloudEpicTasksPagesStore,
} from "@/stores/epics/cloud-epic-tasks-pages-store";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksLastKnownQueryKey,
} from "@/lib/cloud-epic-tasks-query";

const HOST_ID = "host-test";
const USER_ID = "user-test";

const mockHostClient = {
  getActiveHostId: () => HOST_ID,
  getRequestContextUserId: () => USER_ID,
  onChange: () => () => undefined,
  request: vi.fn(),
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

describe("useCloudEpicTasksQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCloudEpicTasksPagesStore.setState({
      pagesByIdentity: {},
      generationByIdentity: {},
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
  });

  it("rejects a stale first-tail response that resolves after a scope reset lands mid-flight", async () => {
    const firstPage: ListTasksResponse = {
      tasks: [taskLight("epic-first", "First page task")],
      hasMore: true,
      nextCursor: "cursor-a",
    };
    let resolveStaleTail: ((value: ListTasksResponse) => void) | undefined;
    mockHostClient.request.mockImplementation(
      (_method: string, params: { readonly cursor: string | undefined }) => {
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

    // A scope-level reset lands while that tail request is still
    // unresolved.
    act(() => {
      resetCloudEpicTasksPagesForScope(HOST_ID, USER_ID);
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
      (_method: string, params: { readonly cursor: string | undefined }) =>
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
      ((value: ListTasksResponse) => void) | undefined;
    mockHostClient.request.mockImplementation(
      (_method: string, params: { readonly sort: string }) => {
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
});
