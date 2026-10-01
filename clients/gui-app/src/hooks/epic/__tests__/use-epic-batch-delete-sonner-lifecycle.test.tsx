import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import type { BatchDeleteResponse } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  WorktreeCleanupOutcome,
  WorktreeCleanupRequest,
} from "@/lib/epics/run-worktree-cleanup";

/**
 * The same progress toast as `use-epic-batch-delete-toast-lifecycle`, against
 * REAL sonner and the app's `<Toaster />`, for the one thing a faked `toast`
 * cannot show: what the user sees. `toast.getToasts()` is the hook's only way
 * to know the person closed the progress toast before the cleanup phase, and
 * an update by id re-creates a toast sonner has already dismissed - so whether
 * the closed toast stays closed is a fact about sonner, not about our call.
 */

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn<(destination: unknown) => Promise<void>>(),
  openStreamTransport: vi.fn<(hostId: string) => unknown>(),
  runWorktreeCleanup:
    vi.fn<
      (
        open: (hostId: string) => unknown,
        request: WorktreeCleanupRequest,
      ) => Promise<WorktreeCleanupOutcome>
    >(),
  publishDeletedEpicNotification: vi.fn<(input: unknown) => void>(),
}));

interface HeldHostRequest {
  readonly resolve: (response: BatchDeleteResponse) => void;
}

const host = vi.hoisted(() => {
  const requests: HeldHostRequest[] = [];
  const client = {
    getActiveHostId: (): string | null => "host-1",
    getRequestContextUserId: (): string | null => "user-1",
    request: (): Promise<BatchDeleteResponse> =>
      new Promise<BatchDeleteResponse>((resolve) => {
        requests.push({ resolve });
      }),
  };
  return { requests, client };
});

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => host.client,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
  useRouterState: (options: {
    readonly select: (state: {
      readonly location: { readonly pathname: string };
    }) => unknown;
  }) => options.select({ location: { pathname: "/epics" } }),
}));

vi.mock("@/lib/host/use-worktree-delete-stream-transport", () => ({
  useWorktreeDeleteStreamTransportFactory: () => mocks.openStreamTransport,
}));

vi.mock("@/lib/epics/run-worktree-cleanup", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/epics/run-worktree-cleanup")
  >()),
  runWorktreeCleanup: mocks.runWorktreeCleanup,
}));

vi.mock("@/lib/epics/deleted-epic-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epics/deleted-epic-events")>()),
  publishDeletedEpicNotification: mocks.publishDeletedEpicNotification,
}));

import {
  useEpicBatchDelete,
  type BatchDeleteEpicVariables,
} from "@/hooks/epic/use-epic-batch-delete-mutation";

function renderBatchDelete(): {
  readonly dispatch: (variables: BatchDeleteEpicVariables) => void;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { readonly children: ReactNode }): ReactNode =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(Toaster),
      children,
    );
  const { result } = renderHook(() => useEpicBatchDelete(), { wrapper });
  return {
    dispatch: (variables) => {
      act(() => {
        result.current.mutate(variables);
      });
    },
  };
}

function toastElements(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-sonner-toast]")];
}

async function hostAnswers(response: BatchDeleteResponse): Promise<void> {
  await waitFor(() => {
    expect(host.requests).toHaveLength(1);
  });
  await act(async () => {
    host.requests[0]?.resolve(response);
    await Promise.resolve();
  });
}

function holdCleanup(): {
  readonly settle: (outcome: WorktreeCleanupOutcome) => Promise<void>;
} {
  let resolveOutcome: (outcome: WorktreeCleanupOutcome) => void = () => {
    throw new Error("the cleanup was never started");
  };
  mocks.runWorktreeCleanup.mockImplementation(
    () =>
      new Promise<WorktreeCleanupOutcome>((resolve) => {
        resolveOutcome = resolve;
      }),
  );
  return {
    settle: async (outcome) => {
      await act(async () => {
        resolveOutcome(outcome);
        await Promise.resolve();
      });
    },
  };
}

const ONE_WORKTREE: BatchDeleteEpicVariables = {
  ids: ["epic-a"],
  worktreeCleanup: {
    candidates: [{ worktreePath: "/wt/a", ownerEpicIds: ["epic-a"] }],
  },
};

const A_DELETED: BatchDeleteResponse = {
  results: [{ taskId: "epic-a", success: true, home: "cloud" }],
};

beforeEach(() => {
  host.requests.length = 0;
  mocks.navigate.mockReset();
  mocks.navigate.mockResolvedValue(undefined);
  mocks.openStreamTransport.mockReset();
  mocks.runWorktreeCleanup.mockReset();
  mocks.publishDeletedEpicNotification.mockReset();
});

afterEach(() => {
  cleanup();
  // Sonner's queue is module scope: a toast left showing here would still be
  // queued for the next test's fresh <Toaster />.
  toast.dismiss();
});

describe("the delete's progress toast, as the person sees it", () => {
  it("shows one progress toast at kickoff and replaces it with the outcome", async () => {
    const view = renderBatchDelete();

    view.dispatch({ ids: ["epic-a"], worktreeCleanup: null });

    expect(await screen.findByText("Deleting epic…")).not.toBeNull();
    expect(toastElements()).toHaveLength(1);

    await hostAnswers(A_DELETED);

    expect(await screen.findByText("Epic was deleted")).not.toBeNull();
    await waitFor(() => {
      expect(screen.queryByText("Deleting epic…")).toBeNull();
    });
    expect(toastElements()).toHaveLength(1);
  });

  it("carries the one toast from the delete into the worktree removal, then replaces it with the summary", async () => {
    const cleanup = holdCleanup();
    const view = renderBatchDelete();
    view.dispatch(ONE_WORKTREE);
    expect(await screen.findByText("Deleting epic…")).not.toBeNull();

    await hostAnswers(A_DELETED);

    expect(await screen.findByText("Removing 1 worktree…")).not.toBeNull();
    // The same toast moved on, not a second one beside it.
    expect(screen.queryByText("Deleting epic…")).toBeNull();
    expect(toastElements()).toHaveLength(1);

    await cleanup.settle({ removed: ["/wt/a"], failed: [], uncertain: [] });

    expect(
      await screen.findByText("Epic was deleted · 1 worktree removed"),
    ).not.toBeNull();
    await waitFor(() => {
      expect(screen.queryByText("Removing 1 worktree…")).toBeNull();
    });
    expect(toastElements()).toHaveLength(1);
  });

  it("does not bring back a progress toast the person closed before the worktree phase", async () => {
    const cleanup = holdCleanup();
    const view = renderBatchDelete();
    view.dispatch(ONE_WORKTREE);
    expect(await screen.findByText("Deleting epic…")).not.toBeNull();

    // What the toast's own close button does.
    const shown = toast.getToasts();
    expect(shown).toHaveLength(1);
    toast.dismiss(shown[0]?.id);
    await waitFor(() => {
      expect(screen.queryByText("Deleting epic…")).toBeNull();
    });

    await hostAnswers(A_DELETED);
    await waitFor(() => {
      expect(mocks.runWorktreeCleanup).toHaveBeenCalledTimes(1);
    });

    // The cleanup is running and nothing re-created the closed toast.
    expect(screen.queryByText("Removing 1 worktree…")).toBeNull();
    expect(toast.getToasts()).toHaveLength(0);

    await cleanup.settle({ removed: ["/wt/a"], failed: [], uncertain: [] });

    // The summary still lands - it is a fresh toast, not the closed one.
    expect(
      await screen.findByText("Epic was deleted · 1 worktree removed"),
    ).not.toBeNull();
  });
});
