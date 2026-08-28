import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GetTaskContextsResponse,
  ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";

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

  it("reuses a completed batch across a remount inside the stale window", async () => {
    // History remounts whenever the route is revisited. With the default zero
    // stale time each visit re-fanned the batch into one `POST /tasks/context`
    // per id, which is what made an idle host emit them continuously.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const taskIds = ["epic-a", "epic-b"];

    const first = renderHook(() => useEpicGetTaskContexts(taskIds, USER_ID), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => {
      expect(first.result.current.tasksById.get("epic-a")).toBeDefined();
    });
    expect(request).toHaveBeenCalledTimes(1);

    first.unmount();
    const second = renderHook(() => useEpicGetTaskContexts(taskIds, USER_ID), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => {
      expect(second.result.current.tasksById.get("epic-b")).toBeDefined();
    });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refetches for a different user - a permission-scoped answer is never shared", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const taskIds = ["epic-a"];

    const { result, rerender } = renderHook(
      (props: { readonly userId: string }) =>
        useEpicGetTaskContexts(taskIds, props.userId),
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
});
