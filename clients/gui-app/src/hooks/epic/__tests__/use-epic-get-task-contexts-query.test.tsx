import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  type GetTaskContextsResponse,
  type ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import { useAuthStore } from "@/stores/auth/auth-store";

const HOST_ID = "host-test";
const USER_ID = "user-test";
const OTHER_USER_ID = "user-other";

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
  useHostRuntimeClient: () => mockHostClient,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: HOST_ID,
    isReady: true,
    hasRpcEndpoint: true,
    canExecute: true,
    requestContextUserId: USER_ID,
  }),
}));

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
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

describe("useEpicGetTaskContexts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The dispatch-time preflight reads the live verdict: every production
    // caller of this hook is cloud-gated, so the fixture holds one.
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: USER_ID, userName: "U", email: "u@example.com" },
        { userId: USER_ID, username: "U" },
        [],
      );
    request.mockImplementation((method: string, params: unknown) => {
      if (method !== "epic.getTaskContexts") {
        return Promise.reject(new Error(`unexpected method: ${method}`));
      }
      const taskIds = (params as { taskIds: string[] }).taskIds;
      const tasks: GetTaskContextsResponse["tasks"] = {};
      for (const id of taskIds) {
        tasks[id] = { status: "found", task: listTaskLight(id, `Title ${id}`) };
      }
      return Promise.resolve({ tasks });
    });
  });

  afterEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  it("reuses a completed batch across a remount inside the stale window", async () => {
    // History remounts whenever the route is revisited. With the default zero
    // stale time each visit re-fanned the batch into one `POST /tasks/context`
    // per id, which is what made an idle host emit them continuously.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const taskIds = ["epic-a", "epic-b"];

    const first = renderHook(
      () => useEpicGetTaskContexts(taskIds, USER_ID, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );
    await waitFor(() => {
      expect(first.result.current.tasksById.get("epic-a")).toBeDefined();
    });
    expect(request).toHaveBeenCalledTimes(1);

    first.unmount();
    const second = renderHook(
      () => useEpicGetTaskContexts(taskIds, USER_ID, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );
    await waitFor(() => {
      expect(second.result.current.tasksById.get("epic-b")).toBeDefined();
    });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("explicitly refetches each capped batch inside the stale window", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const taskIds = Array.from({ length: 64 }, (_, index) => `epic-${index}`);
    const { result } = renderHook(
      () => useEpicGetTaskContexts(taskIds, USER_ID, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.tasksById.size).toBe(taskIds.length);
    });
    expect(request).toHaveBeenCalledTimes(2);

    await act(async () => {
      await result.current.refetch();
    });

    expect(request).toHaveBeenCalledTimes(4);
    const requestedIds = request.mock.calls.map((call) => {
      expect(call[0]).toBe("epic.getTaskContexts");
      const params = call[1] as { readonly taskIds: readonly string[] };
      expect(params.taskIds.length).toBeLessThanOrEqual(
        GET_TASK_CONTEXTS_MAX_IDS,
      );
      return params.taskIds;
    });
    expect(requestedIds.slice(0, 2).flat().toSorted()).toEqual(
      taskIds.toSorted(),
    );
    expect(requestedIds.slice(2).flat().toSorted()).toEqual(taskIds.toSorted());
  });

  it("refetches for a different user - a permission-scoped answer is never shared", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const taskIds = ["epic-a"];

    const { result, rerender } = renderHook(
      (props: { readonly userId: string }) =>
        useEpicGetTaskContexts(taskIds, props.userId, { enabled: true }),
      {
        wrapper: makeWrapper(queryClient),
        initialProps: { userId: USER_ID },
      },
    );
    await waitFor(() => {
      expect(result.current.tasksById.get("epic-a")).toBeDefined();
    });
    expect(request).toHaveBeenCalledTimes(1);

    rerender({ userId: OTHER_USER_ID });
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });
  });

  it("merges @1.4 recent activity into found rows and leaves it absent for older responses", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const activityTask = listTaskLight("epic-with-activity", "Activity task");
    const legacyTask = listTaskLight("epic-without-activity", "Legacy task");
    request
      .mockImplementationOnce(() =>
        Promise.resolve({
          tasks: {
            "epic-with-activity": { status: "found", task: activityTask },
          },
          recentAtByTaskId: { "epic-with-activity": 1_234 },
        }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          tasks: {
            "epic-without-activity": { status: "found", task: legacyTask },
          },
        }),
      );

    const withActivity = renderHook(
      () =>
        useEpicGetTaskContexts(["epic-with-activity"], USER_ID, {
          enabled: true,
        }),
      { wrapper: makeWrapper(queryClient) },
    );
    await waitFor(() => {
      expect(
        withActivity.result.current.tasksById.get("epic-with-activity")
          ?.recentAt,
      ).toBe(1_234);
    });

    const withoutActivity = renderHook(
      () =>
        useEpicGetTaskContexts(["epic-without-activity"], USER_ID, {
          enabled: true,
        }),
      { wrapper: makeWrapper(queryClient) },
    );
    await waitFor(() => {
      expect(
        withoutActivity.result.current.tasksById.has("epic-without-activity"),
      ).toBe(true);
    });

    expect(
      withoutActivity.result.current.tasksById.get("epic-without-activity")
        ?.recentAt,
    ).toBeUndefined();
  });
});
