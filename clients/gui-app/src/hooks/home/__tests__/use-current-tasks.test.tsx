/**
 * `useCurrentTasks` through the real query cache: the pin tail is a cached copy
 * of History rows, so it has to obey the same optimistic pin / rename patches as
 * the first page, and a placeholder or a locally-incomplete first page must not
 * be read as the settled one.
 *
 * Only the edges are faked: the first-page hook is a real `useQuery` under the
 * real key (so a patch on that key reaches it, and `isPlaceholderData` is
 * TanStack's own), and the cursor RPC is a spy.
 */
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  queryOptions,
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  ListTaskLight,
  ListTasksCompleteness,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  useCurrentTasks,
  type CurrentTasks,
} from "@/hooks/home/use-current-tasks";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import {
  setEpicPinnedInCloudTaskCaches,
  updateEpicTitleInCloudTaskCaches,
} from "@/lib/cloud-epic-tasks-query/cache";
import { cloudQueryKeys } from "@/lib/query-keys";
import { useCloudEpicTasksPagesStore } from "@/stores/epics/cloud-epic-tasks-pages-store";

const HOST_ID = "host-1";
const USER_ID = "user-1";
const SCOPE = { hostId: HOST_ID, userId: USER_ID };

const testState = vi.hoisted(() => {
  const state: {
    firstPage: ListTasksResponse | undefined;
    placeholder: ListTasksResponse | undefined;
    firstPageNeverSettles: boolean;
  } = {
    firstPage: undefined,
    placeholder: undefined,
    firstPageNeverSettles: false,
  };
  return state;
});

const fetchCursorPage = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => {
    const query = useQuery(
      queryOptions<ListTasksResponse>({
        queryKey: cloudEpicTasksQueryKey(
          HOST_ID,
          USER_ID,
          LIST_CLOUD_TASKS_REQUEST,
        ),
        queryFn: () => {
          const firstPage = testState.firstPage;
          if (testState.firstPageNeverSettles || firstPage === undefined) {
            return new Promise<ListTasksResponse>(() => undefined);
          }
          return Promise.resolve(firstPage);
        },
        staleTime: Infinity,
        placeholderData: testState.placeholder,
      }),
    );
    return {
      query,
      hostId: HOST_ID,
      currentUserId: USER_ID,
      isCloudPagePending: false,
      initialLegRefused: false,
    };
  },
}));

vi.mock("@/lib/cloud-epic-tasks-query", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/cloud-epic-tasks-query")>();
  return { ...actual, fetchCloudEpicTasksCursorPageByHostId: fetchCursorPage };
});

const NO_TASK_CONTEXTS = vi.hoisted(() => ({
  tasksById: new Map<string, never>(),
  localHomedTaskIds: new Set<string>(),
  isFetching: false,
}));

vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: () => NO_TASK_CONTEXTS,
}));

vi.mock("@/hooks/home/use-open-tab-epic-ids", () => {
  const none: string[] = [];
  return { useOpenTabEpicIds: () => none };
});

function task(
  epicId: string,
  pinned: boolean,
  title: string,
  home: "local" | "cloud" | undefined,
): ListTaskLight {
  return {
    epic: {
      light: {
        id: epicId,
        title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "in_progress",
        createdAt: 0,
        updatedAt: 0,
        createdBy: USER_ID,
        version: "1",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    phase: null,
    pinned,
    ...(home === undefined ? {} : { home }),
  };
}

function pinnedTask(epicId: string): ListTaskLight {
  return task(epicId, true, epicId, undefined);
}

function page(
  tasks: readonly ListTaskLight[],
  nextCursor: string | null,
  completeness: ListTasksCompleteness | null,
): ListTasksResponse {
  return {
    tasks: [...tasks],
    hasMore: nextCursor !== null,
    ...(nextCursor === null ? {} : { nextCursor }),
    ...(completeness === null ? {} : { completeness }),
  };
}

const SETTLED: ListTasksCompleteness = {
  cloudPage: "settled",
  facets: "server",
  localRows: "none",
  sort: "server",
};

function wrapperFor(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function pinnedIds(result: { readonly current: CurrentTasks }): string[] {
  return result.current.groups.pinned.map((item) => item.epicId);
}

beforeEach(() => {
  fetchCursorPage.mockReset();
  testState.firstPage = undefined;
  testState.placeholder = undefined;
  testState.firstPageNeverSettles = false;
  useCloudEpicTasksPagesStore.setState({
    pagesByIdentity: {},
    generationByIdentity: {},
    deletedEpicIdsByScope: {},
  });
});

afterEach(() => {
  cleanup();
});

describe("useCurrentTasks pin tail", () => {
  async function renderWithTail() {
    testState.firstPage = page([pinnedTask("first-pin")], "cursor-1", SETTLED);
    fetchCursorPage.mockResolvedValue(
      page([pinnedTask("tail-only")], null, null),
    );
    const queryClient = newQueryClient();
    const rendered = renderHook(() => useCurrentTasks(), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => {
      expect(pinnedIds(rendered.result)).toContain("tail-only");
    });
    expect(fetchCursorPage).toHaveBeenCalledTimes(1);
    return { queryClient, ...rendered };
  }

  it("unpins a tail-only task immediately and restores it when the pin is rolled back", async () => {
    const { queryClient, result } = await renderWithTail();

    act(() => {
      setEpicPinnedInCloudTaskCaches(queryClient, SCOPE, "tail-only", false);
    });
    await waitFor(() => {
      expect(pinnedIds(result)).toEqual(["first-pin"]);
    });

    // `onError` inverts the same patch.
    act(() => {
      setEpicPinnedInCloudTaskCaches(queryClient, SCOPE, "tail-only", true);
    });
    await waitFor(() => {
      expect(pinnedIds(result).sort()).toEqual(["first-pin", "tail-only"]);
    });
    // Neither write needed the network: the patch, not a refetch, moved the row.
    expect(fetchCursorPage).toHaveBeenCalledTimes(1);
  });

  it("renames a tail-only task", async () => {
    const { queryClient, result } = await renderWithTail();

    act(() => {
      updateEpicTitleInCloudTaskCaches(
        queryClient,
        SCOPE,
        "tail-only",
        "Renamed in History",
      );
    });

    await waitFor(() => {
      const row = result.current.groups.pinned.find(
        (item) => item.epicId === "tail-only",
      );
      expect(row?.title).toBe("Renamed in History");
    });
  });

  it("does not let a stale tail duplicate override the first-page row", async () => {
    testState.firstPage = page(
      [pinnedTask("dup"), pinnedTask("other-pin")],
      "cursor-1",
      SETTLED,
    );
    fetchCursorPage.mockResolvedValue(
      page([task("dup", true, "stale tail title", undefined)], null, null),
    );
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useCurrentTasks(), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => {
      expect(fetchCursorPage).toHaveBeenCalledTimes(1);
      expect(pinnedIds(result)).toContain("dup");
    });
    // Let the tail land, then move ONLY the first page: rename it and unpin it,
    // leaving the cached tail copy stale.
    await waitFor(() => {
      expect(
        queryClient.getQueryData(
          cloudQueryKeys.currentTasksPinTail(HOST_ID, USER_ID, "cursor-1"),
        ),
      ).toBeDefined();
    });
    act(() => {
      queryClient.setQueryData<ListTasksResponse>(
        cloudEpicTasksQueryKey(HOST_ID, USER_ID, LIST_CLOUD_TASKS_REQUEST),
        page(
          [
            task("dup", true, "fresh first-page title", undefined),
            pinnedTask("other-pin"),
          ],
          "cursor-1",
          SETTLED,
        ),
      );
    });

    await waitFor(() => {
      const row = result.current.groups.pinned.find(
        (item) => item.epicId === "dup",
      );
      expect(row?.title).toBe("fresh first-page title");
    });
    expect(
      result.current.groups.pinned.filter((item) => item.epicId === "dup"),
    ).toHaveLength(1);
  });
});

describe("useCurrentTasks first-page authority", () => {
  it("never reads a placeholder page as complete/empty", () => {
    // A filtered History page for the same host/user: empty and `hasMore:false`.
    testState.placeholder = page([], null, SETTLED);
    testState.firstPageNeverSettles = true;

    const { result } = renderHook(() => useCurrentTasks(), {
      wrapper: wrapperFor(newQueryClient()),
    });

    expect(result.current.pinsComplete).toBe(false);
    expect(result.current.isPending).toBe(true);
    expect(result.current.groups.pinned).toEqual([]);
  });

  it("never seeds the tail cursor from a placeholder, but still shows its pinned rows", () => {
    testState.placeholder = page(
      [pinnedTask("filtered-pin")],
      "filtered-cursor",
      SETTLED,
    );
    testState.firstPageNeverSettles = true;

    const { result } = renderHook(() => useCurrentTasks(), {
      wrapper: wrapperFor(newQueryClient()),
    });

    expect(fetchCursorPage).not.toHaveBeenCalled();
    expect(result.current.pinsComplete).toBe(false);
    expect(result.current.isPending).toBe(true);
    expect(pinnedIds(result)).toEqual(["filtered-pin"]);
  });

  it("claims completeness once the real first page settles", async () => {
    testState.firstPage = page([pinnedTask("real-pin")], null, SETTLED);
    testState.placeholder = page([], null, SETTLED);

    const { result } = renderHook(() => useCurrentTasks(), {
      wrapper: wrapperFor(newQueryClient()),
    });

    await waitFor(() => {
      expect(result.current.pinsComplete).toBe(true);
    });
    expect(result.current.isPending).toBe(false);
    expect(pinnedIds(result)).toEqual(["real-pin"]);
  });

  it.each(["truncated", "suppressed-unprovable-filter"] as const)(
    "withholds completeness, without pending, when localRows is %s",
    async (localRows) => {
      testState.firstPage = page([pinnedTask("cloud-pin")], null, {
        ...SETTLED,
        localRows,
      });

      const { result } = renderHook(() => useCurrentTasks(), {
        wrapper: wrapperFor(newQueryClient()),
      });

      await waitFor(() => {
        expect(pinnedIds(result)).toEqual(["cloud-pin"]);
      });
      expect(result.current.pinsComplete).toBe(false);
      expect(result.current.isPending).toBe(false);
    },
  );
});
