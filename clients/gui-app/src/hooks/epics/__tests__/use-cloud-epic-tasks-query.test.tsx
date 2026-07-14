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
import { LIST_CLOUD_TASKS_REQUEST } from "@/lib/cloud-epic-tasks-query";

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

  it("rejects a stale first-tail response that resolves after a pin/unpin scope reset lands mid-flight", async () => {
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

    // A pin/unpin mutation succeeds and resets the host/user scope while
    // that tail request is still unresolved - mirrors `useEpicSetPinned`'s
    // `onSuccess` calling `resetCloudEpicTasksPagesForScope`.
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
});
