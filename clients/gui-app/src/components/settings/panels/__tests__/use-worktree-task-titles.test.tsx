import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";
import type {
  GetTaskContextsResponse,
  ListTaskLight,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { GET_TASK_CONTEXTS_MAX_IDS } from "@traycer/protocol/host/epic/unary-schemas";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import { hostQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useWorktreeTaskTitles } from "@/components/settings/panels/use-worktree-task-titles";

const HOST_ID = "host-test";
const USER_ID = "user-test";

const request = vi.fn();
const mockHostClient = {
  getActiveHostId: () => HOST_ID,
  getRequestContextUserId: () => USER_ID,
  onChange: () => () => undefined,
  request,
  requestWithSignal: request,
};

vi.mock("@/lib/host", () => ({
  useHostClient: () => mockHostClient,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: HOST_ID,
    isReady: true,
    requestContextUserId: USER_ID,
  }),
}));

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function worktreeWithOwners(
  path: string,
  epicIds: readonly string[],
): WorktreeHostEntryV14 {
  return {
    worktreePath: path,
    branch: "feat",
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    owners: epicIds.map((epicId) => ({
      epicId,
      ownerKind: "chat" as const,
      ownerId: `chat-${epicId}`,
      updatedAt: 1,
    })),
    lastActivityAt: null,
    branchStatus: null,
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    resolvedAt: null,
  };
}

function listTaskLight(id: string, title: string): ListTaskLight {
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
    pinned: false,
  };
}

function seedTier1Cache(
  queryClient: QueryClient,
  tasks: readonly ListTaskLight[],
): void {
  const key = cloudEpicTasksQueryKey(
    HOST_ID,
    USER_ID,
    LIST_CLOUD_TASKS_REQUEST,
  );
  queryClient.setQueryData<ListTasksResponse>(key, {
    tasks: [...tasks],
    hasMore: false,
  });
}

describe("useWorktreeTaskTitles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    // Cloud first-page warm is a separate listTasks call; default to empty so
    // tests that only care about tier 2 are not blocked on it.
    mockHostClient.request.mockImplementation((method: string) => {
      if (method === "epic.listTasks") {
        return Promise.resolve({ tasks: [], hasMore: false });
      }
      return Promise.reject(
        new Error(`unexpected method in test default: ${method}`),
      );
    });
  });

  it("resolves still-unresolved ids via epic.getTaskContexts (tier 2)", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Tier 1 has only epic-cached; epic-unresolved must hit the batch RPC.
    const tier1Tasks = [listTaskLight("epic-cached", "From cache")];
    seedTier1Cache(queryClient, tier1Tasks);

    mockHostClient.request.mockImplementation(
      (method: string, params: unknown) => {
        if (method === "epic.listTasks") {
          // Keep tier-1 cache populated when the warm query refetches.
          return Promise.resolve({ tasks: tier1Tasks, hasMore: false });
        }
        if (method === "epic.getTaskContexts") {
          const taskIds = (params as { taskIds: string[] }).taskIds;
          expect(taskIds).toEqual(["epic-unresolved"]);
          const response: GetTaskContextsResponse = {
            tasks: {
              "epic-unresolved": listTaskLight("epic-unresolved", "From batch"),
            },
          };
          return Promise.resolve(response);
        }
        return Promise.reject(new Error(`unexpected method: ${method}`));
      },
    );

    const worktrees = [
      worktreeWithOwners("/wt/a", ["epic-cached"]),
      worktreeWithOwners("/wt/b", ["epic-unresolved"]),
    ];

    const { result } = renderHook(
      () => useWorktreeTaskTitles(mockHostClient as never, worktrees),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.get("epic-cached")).toBe("From cache");
      expect(result.current.get("epic-unresolved")).toBe("From batch");
    });

    expect(mockHostClient.requestWithSignal).toHaveBeenCalledWith(
      "epic.getTaskContexts",
      { taskIds: ["epic-unresolved"] },
      expect.any(AbortSignal),
    );
  });

  it("keeps null batch entries unresolved (no title in the map)", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    mockHostClient.request.mockImplementation((method: string) => {
      if (method === "epic.listTasks") {
        return Promise.resolve({ tasks: [], hasMore: false });
      }
      if (method === "epic.getTaskContexts") {
        const response: GetTaskContextsResponse = {
          tasks: { "epic-gone": null },
        };
        return Promise.resolve(response);
      }
      return Promise.reject(new Error(`unexpected method: ${method}`));
    });

    const worktrees = [worktreeWithOwners("/wt/a", ["epic-gone"])];
    const { result } = renderHook(
      () => useWorktreeTaskTitles(mockHostClient as never, worktrees),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(
        mockHostClient.request.mock.calls.some(
          (call) => call[0] === "epic.getTaskContexts",
        ),
      ).toBe(true);
    });

    expect(result.current.has("epic-gone")).toBe(false);
    expect(result.current.size).toBe(0);
  });

  it("falls back to tier-1-only on E_HOST_UNSUPPORTED without throwing", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tier1Tasks = [listTaskLight("epic-cached", "From cache")];
    seedTier1Cache(queryClient, tier1Tasks);

    mockHostClient.request.mockImplementation((method: string) => {
      if (method === "epic.listTasks") {
        return Promise.resolve({ tasks: tier1Tasks, hasMore: false });
      }
      if (method === "epic.getTaskContexts") {
        return Promise.reject(
          new HostRpcError({
            code: "E_HOST_UNSUPPORTED",
            message: "Method not supported",
            requestId: "req-1",
            method: "epic.getTaskContexts",
            fatalDetails: null,
          }),
        );
      }
      return Promise.reject(new Error(`unexpected method: ${method}`));
    });

    const worktrees = [
      worktreeWithOwners("/wt/a", ["epic-cached"]),
      worktreeWithOwners("/wt/b", ["epic-unresolved"]),
    ];

    const { result } = renderHook(
      () => useWorktreeTaskTitles(mockHostClient as never, worktrees),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(
        mockHostClient.request.mock.calls.some(
          (call) => call[0] === "epic.getTaskContexts",
        ),
      ).toBe(true);
    });

    // Tier 1 still works; unresolved stays absent; no throw to the caller.
    expect(result.current.get("epic-cached")).toBe("From cache");
    expect(result.current.has("epic-unresolved")).toBe(false);
  });

  it("batches unresolved ids into chunks of GET_TASK_CONTEXTS_MAX_IDS", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const epicIds = Array.from(
      { length: GET_TASK_CONTEXTS_MAX_IDS + 3 },
      (_value, index) => `epic-${String(index).padStart(3, "0")}`,
    );

    const batchCalls: string[][] = [];
    mockHostClient.request.mockImplementation(
      (method: string, params: unknown) => {
        if (method === "epic.listTasks") {
          return Promise.resolve({ tasks: [], hasMore: false });
        }
        if (method === "epic.getTaskContexts") {
          const taskIds = (params as { taskIds: string[] }).taskIds;
          batchCalls.push(taskIds);
          const tasks: GetTaskContextsResponse["tasks"] = {};
          for (const id of taskIds) {
            tasks[id] = listTaskLight(id, `Title ${id}`);
          }
          return Promise.resolve({ tasks });
        }
        return Promise.reject(new Error(`unexpected method: ${method}`));
      },
    );

    const worktrees = [worktreeWithOwners("/wt/many", epicIds)];
    const { result } = renderHook(
      () => useWorktreeTaskTitles(mockHostClient as never, worktrees),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.size).toBe(epicIds.length);
    });

    expect(batchCalls).toHaveLength(2);
    expect(batchCalls[0]).toHaveLength(GET_TASK_CONTEXTS_MAX_IDS);
    expect(batchCalls[1]).toHaveLength(3);
    // Sorted for stable cache identity.
    expect(batchCalls[0]?.[0]).toBe("epic-000");
  });

  it("uses the hostEpicTaskContexts key shape for the batch query", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    mockHostClient.request.mockImplementation((method: string) => {
      if (method === "epic.listTasks") {
        return Promise.resolve({ tasks: [], hasMore: false });
      }
      if (method === "epic.getTaskContexts") {
        return Promise.resolve({
          tasks: {
            "epic-x": listTaskLight("epic-x", "X"),
          },
        } satisfies GetTaskContextsResponse);
      }
      return Promise.reject(new Error(`unexpected method: ${method}`));
    });

    const worktrees = [worktreeWithOwners("/wt/a", ["epic-x"])];
    const { result } = renderHook(
      () => useWorktreeTaskTitles(mockHostClient as never, worktrees),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.get("epic-x")).toBe("X");
    });

    const expectedKey = hostQueryKeys.epicTaskContexts(HOST_ID, USER_ID, [
      "epic-x",
    ]);
    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(expectedKey),
    ).toEqual({
      tasks: { "epic-x": listTaskLight("epic-x", "X") },
    });
  });
});
