import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import type {
  ListTaskLight,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import {
  cloudEpicTasksPageGeneration,
  useCloudEpicTasksPagesStore,
} from "@/stores/epics/cloud-epic-tasks-pages-store";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const testState = vi.hoisted(() => {
  const state: { activeHostId: string | null; userId: string | null } = {
    activeHostId: "host-1",
    userId: "user-1",
  };
  return state;
});

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => ({
    getActiveHostId: () => testState.activeHostId,
    getRequestContextUserId: () => testState.userId,
  }),
}));

interface MutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

let capturedOptions: {
  onMutate?: (variables: {
    epicId: string;
    pinned: boolean;
  }) => MutationContext;
  onSuccess?: unknown;
  onError?: (
    error: unknown,
    variables: { epicId: string; pinned: boolean },
    context: MutationContext | undefined,
  ) => void;
} = {};

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: { options: typeof capturedOptions }) => {
    capturedOptions = args.options;
    return { mutate: vi.fn(), isPending: false };
  },
}));

import {
  useEpicSetPinned,
  usePendingSetPinnedEpicIds,
} from "@/hooks/epic/use-epic-set-pinned-mutation";
import { epicMutationKeys } from "@/lib/query-keys";

function epicTask(epicId: string, pinned: boolean): ListTaskLight {
  return {
    epic: {
      light: {
        id: epicId,
        title: `Epic ${epicId}`,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "in_progress",
        createdAt: 0,
        updatedAt: 0,
        createdBy: "user-1",
        version: "1",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    phase: null,
    pinned,
  };
}

function pageWith(tasks: readonly ListTaskLight[]): ListTasksResponse {
  return { tasks: [...tasks], hasMore: false };
}

function pinnedById(
  response: ListTasksResponse | undefined,
): Record<string, boolean | undefined> {
  return Object.fromEntries(
    (response?.tasks ?? []).flatMap((task) =>
      task.epic?.light?.id === undefined
        ? []
        : [[task.epic.light.id, task.pinned]],
    ),
  );
}

interface SetPinnedVariables {
  readonly epicId: string;
  readonly pinned: boolean;
}

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useEpicSetPinned", () => {
  beforeEach(() => {
    capturedOptions = {};
    vi.clearAllMocks();
    testState.activeHostId = "host-1";
    testState.userId = "user-1";
    useCloudEpicTasksPagesStore.setState({
      pagesByIdentity: {},
      generationByIdentity: {},
    });
  });

  it("optimistically flips the row in the scoped first page and tails on mutate, leaving other scopes alone", () => {
    const queryClient = new QueryClient();
    const scopedQueryKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const otherQueryKey = cloudEpicTasksQueryKey(
      "host-2",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(
      scopedQueryKey,
      pageWith([epicTask("epic-1", false), epicTask("epic-other", true)]),
    );
    queryClient.setQueryData(
      otherQueryKey,
      pageWith([epicTask("epic-1", false)]),
    );
    const scopedIdentity = "host-1|user-1|recent";
    const otherIdentity = "host-2|user-1|recent";
    const pagesStore = useCloudEpicTasksPagesStore.getState();
    pagesStore.appendPage(
      scopedIdentity,
      cloudEpicTasksPageGeneration(scopedIdentity),
      pageWith([epicTask("epic-1", false)]),
    );
    pagesStore.appendPage(
      otherIdentity,
      cloudEpicTasksPageGeneration(otherIdentity),
      pageWith([epicTask("epic-1", false)]),
    );
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    const context = capturedOptions.onMutate?.({
      epicId: "epic-1",
      pinned: true,
    });

    expect(context).toEqual({ hostId: "host-1", userId: "user-1" });
    expect(pinnedById(queryClient.getQueryData(scopedQueryKey))).toEqual({
      "epic-1": true,
      "epic-other": true,
    });
    expect(pinnedById(queryClient.getQueryData(otherQueryKey))).toEqual({
      "epic-1": false,
    });
    const pages = useCloudEpicTasksPagesStore.getState().pagesByIdentity;
    expect(pinnedById(pages[scopedIdentity][0])).toEqual({ "epic-1": true });
    expect(pinnedById(pages[otherIdentity][0])).toEqual({ "epic-1": false });
    // No reset: the tails stay retained and their generations untouched.
    expect(useCloudEpicTasksPagesStore.getState().generationByIdentity).toEqual(
      {},
    );
  });

  it("reverts the optimistic patch and toasts when the RPC fails", () => {
    const queryClient = new QueryClient();
    const scopedQueryKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(
      scopedQueryKey,
      pageWith([epicTask("epic-1", false)]),
    );
    const scopedIdentity = "host-1|user-1|recent";
    useCloudEpicTasksPagesStore
      .getState()
      .appendPage(
        scopedIdentity,
        cloudEpicTasksPageGeneration(scopedIdentity),
        pageWith([epicTask("epic-1", false)]),
      );
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    const context = capturedOptions.onMutate?.({
      epicId: "epic-1",
      pinned: true,
    });
    expect(pinnedById(queryClient.getQueryData(scopedQueryKey))).toEqual({
      "epic-1": true,
    });

    capturedOptions.onError?.(
      { code: "RPC_ERROR", message: "test", fatalDetails: null },
      { epicId: "epic-1", pinned: true },
      context,
    );

    expect(pinnedById(queryClient.getQueryData(scopedQueryKey))).toEqual({
      "epic-1": false,
    });
    expect(
      pinnedById(
        useCloudEpicTasksPagesStore.getState().pagesByIdentity[
          scopedIdentity
        ][0],
      ),
    ).toEqual({ "epic-1": false });
    expect(toast.error).toHaveBeenCalledWith("Couldn't update pinned task.");
  });

  it("leaves every cache untouched when the mutation scope is null", () => {
    // A signed-out or host-swapping window can leave onMutate's captured
    // scope null; the optimistic patch and the error revert must both no-op
    // rather than touch an unrelated scope.
    testState.activeHostId = null;
    const queryClient = new QueryClient();
    const scopedQueryKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(
      scopedQueryKey,
      pageWith([epicTask("epic-1", false)]),
    );
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    const context = capturedOptions.onMutate?.({
      epicId: "epic-1",
      pinned: true,
    });
    expect(context).toEqual({ hostId: null, userId: "user-1" });
    expect(pinnedById(queryClient.getQueryData(scopedQueryKey))).toEqual({
      "epic-1": false,
    });

    capturedOptions.onError?.(
      { code: "RPC_ERROR", message: "test", fatalDetails: null },
      { epicId: "epic-1", pinned: true },
      context,
    );
    expect(pinnedById(queryClient.getQueryData(scopedQueryKey))).toEqual({
      "epic-1": false,
    });
    expect(toast.error).toHaveBeenCalledWith("Couldn't update pinned task.");
  });

  it("registers no success handler - the optimistic patch is the final state", () => {
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(new QueryClient()),
    });

    // The response carries exactly the bit the request wrote, so success
    // needs no invalidation, refetch, or pagination reset.
    expect(capturedOptions.onSuccess).toBeUndefined();
  });

  it("shows the host error fallback", () => {
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(new QueryClient()),
    });

    capturedOptions.onError?.(
      { code: "RPC_ERROR", message: "test", fatalDetails: null },
      { epicId: "epic-1", pinned: true },
      undefined,
    );

    expect(toast.error).toHaveBeenCalledWith("Couldn't update pinned task.");
  });
});

describe("usePendingSetPinnedEpicIds", () => {
  it("tracks two concurrently pending epics independently and drops each as its own mutation settles", async () => {
    // A real `useMutation` sharing `epicMutationKeys.setPinned()` stands in
    // for two rows calling the same shared `useEpicSetPinned()` instance -
    // the mutation cache (not this local observer) is what the hook under
    // test reads from.
    const resolvers = new Map<string, (value: { pinned: boolean }) => void>();
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });

    const { result } = renderHook(
      () => {
        const mutation = useMutation({
          mutationKey: epicMutationKeys.setPinned(),
          mutationFn: (variables: SetPinnedVariables) =>
            new Promise<{ pinned: boolean }>((resolve) => {
              resolvers.set(variables.epicId, resolve);
            }),
        });
        return {
          mutate: mutation.mutate,
          pending: usePendingSetPinnedEpicIds(),
        };
      },
      { wrapper: makeWrapper(queryClient) },
    );

    act(() => {
      result.current.mutate({ epicId: "epic-a", pinned: true });
      result.current.mutate({ epicId: "epic-b", pinned: false });
    });

    await waitFor(() => {
      expect(result.current.pending).toEqual(new Set(["epic-a", "epic-b"]));
    });

    await act(async () => {
      resolvers.get("epic-a")?.({ pinned: true });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.pending).toEqual(new Set(["epic-b"]));
    });

    await act(async () => {
      resolvers.get("epic-b")?.({ pinned: false });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.pending.size).toBe(0);
    });
  });
});
