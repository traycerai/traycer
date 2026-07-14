import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
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

interface MutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

let capturedOptions: {
  onMutate?: () => MutationContext;
  onSuccess?: (
    response: { pinned: boolean },
    variables: { epicId: string; pinned: boolean },
    context: MutationContext,
  ) => Promise<void>;
  onError?: (error: unknown) => void;
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

const PAGE: ListTasksResponse = { tasks: [], hasMore: false };

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
    useCloudEpicTasksPagesStore.setState({
      pagesByIdentity: {},
      generationByIdentity: {},
    });
  });

  it("drops stale scoped pages and inactive history queries after success", async () => {
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
    queryClient.setQueryData(scopedQueryKey, PAGE);
    queryClient.setQueryData(otherQueryKey, PAGE);
    const scopedIdentity = "host-1|user-1|recent";
    const otherIdentity = "host-2|user-1|recent";
    const pagesStore = useCloudEpicTasksPagesStore.getState();
    pagesStore.appendPage(
      scopedIdentity,
      cloudEpicTasksPageGeneration(scopedIdentity),
      PAGE,
    );
    pagesStore.appendPage(
      otherIdentity,
      cloudEpicTasksPageGeneration(otherIdentity),
      PAGE,
    );
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    await capturedOptions.onSuccess?.(
      { pinned: true },
      { epicId: "epic-1", pinned: true },
      capturedOptions.onMutate?.() ?? { hostId: null, userId: null },
    );

    expect(queryClient.getQueryData(scopedQueryKey)).toBeUndefined();
    expect(queryClient.getQueryData(otherQueryKey)).toEqual(PAGE);
    expect(
      useCloudEpicTasksPagesStore.getState().pagesByIdentity[scopedIdentity],
    ).toBeUndefined();
    expect(
      useCloudEpicTasksPagesStore.getState().pagesByIdentity[otherIdentity],
    ).toEqual([PAGE]);
  });

  it("shows the host error fallback", () => {
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(new QueryClient()),
    });

    capturedOptions.onError?.({
      code: "RPC_ERROR",
      message: "test",
      fatalDetails: null,
    });

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
