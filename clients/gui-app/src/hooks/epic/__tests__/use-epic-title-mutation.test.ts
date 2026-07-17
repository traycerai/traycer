import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GetTaskContextsResponse,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import { hostQueryKeys } from "@/lib/query-keys";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const testState = vi.hoisted(() => ({
  activeHostId: "host-1",
  userId: "user-1",
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => ({
    getActiveHostId: () => testState.activeHostId,
    getRequestContextUserId: () => testState.userId,
  }),
}));

let capturedOptions: {
  onMutate?: () => { hostId: string | null; userId: string | null };
  onSuccess?: (
    response: unknown,
    variables: { epicDelta: { id: string; title?: string; updatedAt: number } },
    ctx: { hostId: string | null; userId: string | null },
  ) => void;
  onError?: (e: unknown) => void;
} = {};
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: { options: typeof capturedOptions }) => {
    capturedOptions = args.options;
    return { mutate: vi.fn(), isPending: false };
  },
}));

import { toast } from "sonner";
import { renderHook } from "@testing-library/react";
import { useEpicUpdateTitle } from "@/hooks/epic/use-epic-title-mutation";

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function renderUseEpicUpdateTitle(queryClient: QueryClient) {
  renderHook(() => useEpicUpdateTitle(), { wrapper: makeWrapper(queryClient) });
}

describe("useEpicUpdateTitle", () => {
  it("shows 'Epic renamed' on success", () => {
    renderUseEpicUpdateTitle(new QueryClient());
    capturedOptions.onSuccess?.(
      {},
      { epicDelta: { id: "epic-1", title: "Renamed", updatedAt: 1 } },
      capturedOptions.onMutate?.() ?? { hostId: null, userId: null },
    );
    expect(toast.success).toHaveBeenCalledWith("Epic renamed");
  });

  it("patches cached history titles and batch-title caches on success", () => {
    const queryClient = new QueryClient();
    const listKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const batchKey = hostQueryKeys.epicTaskContexts("host-1", "user-1", [
      "epic-1",
    ]);
    const light = {
      id: "epic-1",
      title: "Original",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "draft" as const,
      createdAt: 1,
      updatedAt: 1,
      createdBy: "user-1",
      version: "1",
    };
    const row = {
      epic: {
        light,
        permission: null,
        repos: [],
        workspaces: [],
        roomInfo: null,
      },
      pinned: false,
    };
    queryClient.setQueryData<ListTasksResponse>(listKey, {
      tasks: [row],
      hasMore: false,
    });
    queryClient.setQueryData<GetTaskContextsResponse>(batchKey, {
      tasks: { "epic-1": row },
    });
    renderUseEpicUpdateTitle(queryClient);

    capturedOptions.onSuccess?.(
      {},
      { epicDelta: { id: "epic-1", title: "Renamed", updatedAt: 2 } },
      capturedOptions.onMutate?.() ?? { hostId: null, userId: null },
    );

    expect(
      queryClient.getQueryData<ListTasksResponse>(listKey)?.tasks[0]?.epic
        ?.light?.title,
    ).toBe("Renamed");
    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(batchKey)?.tasks[
        "epic-1"
      ]?.epic?.light?.title,
    ).toBe("Renamed");
  });

  it("shows fallback on generic error", () => {
    renderUseEpicUpdateTitle(new QueryClient());
    capturedOptions.onError?.({
      code: "RPC_ERROR",
      message: "test",
      fatalDetails: null,
    });
    expect(toast.error).toHaveBeenCalledWith("Couldn't rename epic.");
  });

  it("shows sign-in copy for UNAUTHORIZED", () => {
    renderUseEpicUpdateTitle(new QueryClient());
    capturedOptions.onError?.({
      code: "UNAUTHORIZED",
      message: "test",
      fatalDetails: null,
    });
    expect(toast.error).toHaveBeenCalledWith("Please sign in again.");
  });
});
