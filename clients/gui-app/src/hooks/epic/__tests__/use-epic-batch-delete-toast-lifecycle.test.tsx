import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ExternalToast } from "sonner";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { BatchDeleteResponse } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  WorktreeCleanupOutcome,
  WorktreeCleanupRequest,
} from "@/lib/epics/run-worktree-cleanup";

/**
 * The progress toast a confirmed delete leaves up while the host works, on the
 * REAL `useEpicBatchDelete`: shown from `onMutate` under a per-dispatch id, then
 * dismissed (success, error) or advanced to the worktree phase (approved
 * cleanup) from the mutation's own lifecycle.
 *
 * Real: the hook, `useHostMutation`, the `QueryClient`'s mutation cache, the
 * `progressToast` seam and the outcome emitters. Faked at their boundaries: the
 * host (a client whose `epic.batchDelete` promise the test holds and settles),
 * the router, the worktree cleanup stream, `sonner` itself, and the host-error
 * toast (which has its own suite).
 */

type ToastCall = readonly [ReactNode, ExternalToast | undefined];

const mocks = vi.hoisted(() => ({
  toastMessage:
    vi.fn<
      (
        message: ReactNode,
        options: ExternalToast | undefined,
      ) => string | number
    >(),
  toastSuccess:
    vi.fn<
      (
        message: ReactNode,
        options: ExternalToast | undefined,
      ) => string | number
    >(),
  toastWarning:
    vi.fn<
      (
        message: ReactNode,
        options: ExternalToast | undefined,
      ) => string | number
    >(),
  toastError:
    vi.fn<
      (
        message: ReactNode,
        options: ExternalToast | undefined,
      ) => string | number
    >(),
  toastDismiss: vi.fn<(id: string | number | undefined) => string | number>(),
  toastGetToasts:
    vi.fn<() => ReadonlyArray<{ readonly id: string | number }>>(),
  toastFromHostError: vi.fn<(error: unknown, fallback: string) => void>(),
  publishDeletedEpicNotification: vi.fn<(input: unknown) => void>(),
  navigate: vi.fn<(destination: unknown) => Promise<void>>(),
  openStreamTransport: vi.fn<(hostId: string) => unknown>(),
  runWorktreeCleanup:
    vi.fn<
      (
        open: (hostId: string) => unknown,
        request: WorktreeCleanupRequest,
      ) => Promise<WorktreeCleanupOutcome>
    >(),
}));

interface HeldHostRequest {
  readonly method: string;
  readonly params: unknown;
  readonly resolve: (response: BatchDeleteResponse) => void;
  readonly reject: (error: Error) => void;
}

const host = vi.hoisted(() => {
  const state: {
    activeHostId: string | null;
    userId: string | null;
    requests: HeldHostRequest[];
  } = { activeHostId: "host-1", userId: "user-1", requests: [] };
  const client = {
    getActiveHostId: (): string | null => state.activeHostId,
    getRequestContextUserId: (): string | null => state.userId,
    request: (method: string, params: unknown): Promise<BatchDeleteResponse> =>
      new Promise<BatchDeleteResponse>((resolve, reject) => {
        state.requests.push({ method, params, resolve, reject });
      }),
  };
  return { state, client };
});

vi.mock("sonner", () => ({
  toast: {
    message: mocks.toastMessage,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
    error: mocks.toastError,
    dismiss: mocks.toastDismiss,
    getToasts: mocks.toastGetToasts,
  },
}));

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

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: mocks.toastFromHostError,
}));

vi.mock("@/lib/epics/deleted-epic-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epics/deleted-epic-events")>()),
  publishDeletedEpicNotification: mocks.publishDeletedEpicNotification,
}));

import {
  useEpicBatchDelete,
  useEpicDeleteInFlightReader,
  useIsEpicDeleteInFlight,
  type BatchDeleteEpicVariables,
} from "@/hooks/epic/use-epic-batch-delete-mutation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { emptyTabStripLayout } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";

/**
 * What the test says about the sonner toast the user could close: whether a
 * toast carrying the progress id is still up when the hook asks
 * (`toast.getToasts()`), and the id the first `progressToast` call used.
 */
const toastScreen: { stillShown: boolean; shownId: string | number | null } = {
  stillShown: true,
  shownId: null,
};

/**
 * What a case drives and reads. Each accessor reads the hook's CURRENT result,
 * so a case asks again after the cache moved rather than holding a stale render.
 */
interface BatchDeleteHarness {
  readonly dispatch: (variables: BatchDeleteEpicVariables) => void;
  /** `useIsEpicDeleteInFlight("epic-a")`, as the render last saw it. */
  readonly rendersEpicAInFlight: () => boolean;
  /** `useEpicDeleteInFlightReader()`'s answer, asked now. */
  readonly isInFlight: (epicId: string) => boolean;
}

function renderBatchDelete(): BatchDeleteHarness {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const { result } = renderHook(
    () => ({
      batchDelete: useEpicBatchDelete(),
      inFlightA: useIsEpicDeleteInFlight("epic-a"),
      reader: useEpicDeleteInFlightReader(),
    }),
    { wrapper },
  );
  return {
    dispatch: (variables) => {
      act(() => {
        result.current.batchDelete.mutate(variables);
      });
    },
    rendersEpicAInFlight: () => result.current.inFlightA,
    isInFlight: (epicId) => result.current.reader(epicId),
  };
}

function deleteOf(
  ids: ReadonlyArray<string>,
  worktreeCleanup: BatchDeleteEpicVariables["worktreeCleanup"],
): BatchDeleteEpicVariables {
  return { ids, worktreeCleanup };
}

function cleanupOf(...worktreePaths: ReadonlyArray<string>) {
  return {
    candidates: worktreePaths.map((worktreePath) => ({
      worktreePath,
      ownerEpicIds: ["epic-a"],
    })),
  };
}

function hostRequest(index: number): HeldHostRequest {
  const request = host.state.requests.at(index);
  if (request === undefined) throw new Error("expected a held host request");
  return request;
}

async function answer(
  index: number,
  response: BatchDeleteResponse,
): Promise<void> {
  await act(async () => {
    hostRequest(index).resolve(response);
    await Promise.resolve();
  });
}

function deleted(...taskIds: ReadonlyArray<string>): BatchDeleteResponse {
  return {
    results: taskIds.map((taskId) => ({
      taskId,
      success: true,
      home: "cloud",
    })),
  };
}

function progressCalls(): ReadonlyArray<ToastCall> {
  return mocks.toastMessage.mock.calls;
}

/** The id the progress toast was put up under, read off the call itself. */
function progressToastId(callIndex: number): string | number {
  const options = progressCalls().at(callIndex)?.[1];
  const id = options?.id;
  if (id === undefined) throw new Error("expected a progress toast with an id");
  return id;
}

function orderOf(fn: {
  readonly mock: { readonly invocationCallOrder: number[] };
}) {
  const order = fn.mock.invocationCallOrder.at(0);
  if (order === undefined) throw new Error("expected the mock to be called");
  return order;
}

describe("the delete's progress toast", () => {
  beforeEach(() => {
    for (const fn of [
      mocks.toastMessage,
      mocks.toastSuccess,
      mocks.toastWarning,
      mocks.toastError,
      mocks.toastDismiss,
      mocks.toastGetToasts,
      mocks.toastFromHostError,
      mocks.publishDeletedEpicNotification,
      mocks.navigate,
      mocks.openStreamTransport,
      mocks.runWorktreeCleanup,
    ]) {
      fn.mockReset();
    }
    host.state.activeHostId = "host-1";
    host.state.userId = "user-1";
    host.state.requests.length = 0;
    toastScreen.stillShown = true;
    toastScreen.shownId = null;
    mocks.toastMessage.mockImplementation((_message, options) => {
      toastScreen.shownId = options?.id ?? null;
      return options?.id ?? "unnamed-toast";
    });
    mocks.toastGetToasts.mockImplementation(() =>
      toastScreen.stillShown && toastScreen.shownId !== null
        ? [{ id: toastScreen.shownId }]
        : [],
    );
    mocks.navigate.mockResolvedValue(undefined);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
  });

  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  });

  describe("at kickoff", () => {
    it("is on screen before the host has answered, as a persistent progress toast under its own id", async () => {
      const view = renderBatchDelete();

      view.dispatch(deleteOf(["epic-a"], null));

      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
      });
      const [message, options] = progressCalls().at(0) ?? [];
      expect(message).toBe("Deleting epic…");
      expect(typeof options?.id).toBe("string");
      expect(options?.id).not.toBe("");
      expect(options?.duration).toBe(Infinity);
      // Still the regular toast variant, so it stays closable.
      expect(options?.closeButton).toBe(true);
      expect(options?.dismissible).toBe(true);
      // The host has been asked and has not answered.
      expect(hostRequest(0).method).toBe("epic.batchDelete");
      expect(mocks.toastDismiss).not.toHaveBeenCalled();
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
    });

    it("names the epic when its title is known", async () => {
      // The title is read off the open header tab, so the tab has to be in the
      // strip as well as in the canvas store.
      const tabId = useEpicCanvasStore
        .getState()
        .openEpicTab("epic-a", "Customer onboarding");
      useTabsStore.setState({
        ...emptyTabStripLayout(),
        stripOrder: [{ kind: "epic", id: tabId }],
      });
      const view = renderBatchDelete();

      view.dispatch(deleteOf(["epic-a"], null));

      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
      });
      expect(progressCalls().at(0)?.[0]).toBe(
        'Deleting epic "Customer onboarding"…',
      );
    });

    it("counts a bulk delete", async () => {
      const view = renderBatchDelete();

      view.dispatch(deleteOf(["epic-a", "epic-b", "epic-c"], null));

      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
      });
      expect(progressCalls().at(0)?.[0]).toBe("Deleting 3 epics…");
    });

    it("gives each dispatch its own toast, because two batches can be in flight at once", async () => {
      const view = renderBatchDelete();

      view.dispatch(deleteOf(["epic-a"], null));
      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
      });
      view.dispatch(deleteOf(["epic-b"], null));
      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(2);
      });

      expect(progressToastId(0)).not.toBe(progressToastId(1));
    });

    it("leaves the task reading as being deleted for exactly as long as the toast is up", async () => {
      const view = renderBatchDelete();
      expect(view.rendersEpicAInFlight()).toBe(false);

      view.dispatch(deleteOf(["epic-a"], null));

      await waitFor(() => {
        expect(view.rendersEpicAInFlight()).toBe(true);
      });
      expect(view.isInFlight("epic-a")).toBe(true);
      expect(view.isInFlight("epic-b")).toBe(false);

      await answer(0, deleted("epic-a"));

      await waitFor(() => {
        expect(view.rendersEpicAInFlight()).toBe(false);
      });
      expect(view.isInFlight("epic-a")).toBe(false);
    });
  });

  describe("when the delete succeeds with no worktree cleanup", () => {
    it("dismisses the progress toast it put up, then emits the outcome", async () => {
      const view = renderBatchDelete();
      view.dispatch(deleteOf(["epic-a"], null));
      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
      });
      const id = progressToastId(0);

      await answer(0, deleted("epic-a"));

      await waitFor(() => {
        expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
      });
      expect(mocks.toastDismiss).toHaveBeenCalledTimes(1);
      expect(mocks.toastDismiss).toHaveBeenCalledWith(id);
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Epic was deleted");
      // Dismiss-then-emit, in that order: an update by id would hand the
      // outcome the progress toast's infinite lifetime and spinner.
      expect(orderOf(mocks.toastDismiss)).toBeLessThan(
        orderOf(mocks.toastSuccess),
      );
      // One progress toast, never re-used for the outcome.
      expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
      expect(mocks.runWorktreeCleanup).not.toHaveBeenCalled();
    });

    it("dismisses it for a partial failure too, and the outcome is the warning", async () => {
      const view = renderBatchDelete();
      view.dispatch(deleteOf(["epic-a", "epic-b"], null));
      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
      });
      const id = progressToastId(0);

      await answer(0, {
        results: [
          { taskId: "epic-a", success: true, home: "cloud" },
          { taskId: "epic-b", success: false, errorMessage: "No access." },
        ],
      });

      await waitFor(() => {
        expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
      });
      expect(mocks.toastDismiss).toHaveBeenCalledWith(id);
      expect(mocks.toastWarning.mock.calls.at(0)?.[0]).toBe(
        "Deleted 1 of 2; 1 failed.",
      );
      expect(orderOf(mocks.toastDismiss)).toBeLessThan(
        orderOf(mocks.toastWarning),
      );
    });

    it("dismisses it when every row was refused, and the outcome is the error", async () => {
      const view = renderBatchDelete();
      view.dispatch(deleteOf(["epic-a"], null));
      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
      });
      const id = progressToastId(0);

      await answer(0, {
        results: [{ taskId: "epic-a", success: false, errorMessage: "No." }],
      });

      await waitFor(() => {
        expect(mocks.toastError).toHaveBeenCalledTimes(1);
      });
      expect(mocks.toastDismiss).toHaveBeenCalledWith(id);
      expect(mocks.toastError.mock.calls.at(0)?.[0]).toBe(
        "Couldn't delete epic.",
      );
    });

    it("still dismisses it when the host's client carries no host id, where cleanup cannot run", async () => {
      host.state.activeHostId = null;
      const view = renderBatchDelete();
      view.dispatch(deleteOf(["epic-a"], cleanupOf("/wt/a")));
      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
      });
      const id = progressToastId(0);

      await answer(0, deleted("epic-a"));

      await waitFor(() => {
        expect(mocks.toastSuccess).toHaveBeenCalledWith("Epic was deleted");
      });
      expect(mocks.toastDismiss).toHaveBeenCalledWith(id);
      expect(mocks.runWorktreeCleanup).not.toHaveBeenCalled();
      expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
    });

    it("does not start a cleanup, or a second progress phase, for a worktree whose owner failed to delete", async () => {
      const view = renderBatchDelete();
      view.dispatch(deleteOf(["epic-a", "epic-b"], cleanupOf("/wt/a")));
      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
      });
      const id = progressToastId(0);

      // `epic-a` owns the worktree and is the one that failed.
      await answer(0, {
        results: [
          { taskId: "epic-a", success: false, errorMessage: "No access." },
          { taskId: "epic-b", success: true, home: "cloud" },
        ],
      });

      await waitFor(() => {
        expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
      });
      expect(mocks.runWorktreeCleanup).not.toHaveBeenCalled();
      expect(mocks.toastDismiss).toHaveBeenCalledWith(id);
      expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("when the delete fails", () => {
    function hostFailure(): HostRpcError {
      return new HostRpcError({
        code: "RPC_ERROR",
        requestId: "request-1",
        method: "epic.batchDelete",
        message: "Host refused the delete.",
        fatalDetails: null,
      });
    }

    it("dismisses the progress toast, then hands the failure to the error toast", async () => {
      const view = renderBatchDelete();
      view.dispatch(deleteOf(["epic-a"], null));
      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
      });
      const id = progressToastId(0);
      const failure = hostFailure();

      await act(async () => {
        hostRequest(0).reject(failure);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(mocks.toastFromHostError).toHaveBeenCalledTimes(1);
      });
      expect(mocks.toastDismiss).toHaveBeenCalledTimes(1);
      expect(mocks.toastDismiss).toHaveBeenCalledWith(id);
      expect(orderOf(mocks.toastDismiss)).toBeLessThan(
        orderOf(mocks.toastFromHostError),
      );
      const [error, fallback] = mocks.toastFromHostError.mock.calls.at(0) ?? [];
      expect(error).toBeInstanceOf(HostRpcError);
      expect(fallback).toBe("Couldn't delete epics.");
      // No outcome toast on a failure that never reached a result.
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      expect(mocks.runWorktreeCleanup).not.toHaveBeenCalled();
    });

    // `toastFromHostError` stays silent for an aborted or recoverable-
    // unauthorized request. This stand-in is silent for every error, so the
    // dismissal below can only have come from the hook itself.
    it("dismisses it even when the error toast says nothing", async () => {
      const view = renderBatchDelete();
      view.dispatch(deleteOf(["epic-a"], null));
      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
      });
      const id = progressToastId(0);

      await act(async () => {
        hostRequest(0).reject(hostFailure());
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(mocks.toastDismiss).toHaveBeenCalledWith(id);
      });
      expect(mocks.toastError).not.toHaveBeenCalled();
    });

    it("frees the task to read as deletable again", async () => {
      const view = renderBatchDelete();
      view.dispatch(deleteOf(["epic-a"], null));
      await waitFor(() => {
        expect(view.rendersEpicAInFlight()).toBe(true);
      });

      await act(async () => {
        hostRequest(0).reject(hostFailure());
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(view.rendersEpicAInFlight()).toBe(false);
      });
    });
  });

  describe("with approved worktree cleanup", () => {
    function holdCleanup(): {
      readonly settle: (outcome: WorktreeCleanupOutcome) => Promise<void>;
      readonly fail: (error: Error) => Promise<void>;
    } {
      let resolveOutcome: (outcome: WorktreeCleanupOutcome) => void = () => {
        throw new Error("the cleanup was never started");
      };
      let rejectOutcome: (error: Error) => void = () => {
        throw new Error("the cleanup was never started");
      };
      mocks.runWorktreeCleanup.mockImplementation(
        () =>
          new Promise<WorktreeCleanupOutcome>((resolve, reject) => {
            resolveOutcome = resolve;
            rejectOutcome = reject;
          }),
      );
      return {
        settle: async (outcome) => {
          await act(async () => {
            resolveOutcome(outcome);
            await Promise.resolve();
          });
        },
        fail: async (error) => {
          await act(async () => {
            rejectOutcome(error);
            await Promise.resolve();
          });
        },
      };
    }

    async function startWithCleanup(
      view: BatchDeleteHarness,
    ): Promise<string | number> {
      view.dispatch(deleteOf(["epic-a"], cleanupOf("/wt/a")));
      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
      });
      return progressToastId(0);
    }

    it("moves the same toast on to the worktree phase while it is still up, and leaves it up until the cleanup settles", async () => {
      const cleanup = holdCleanup();
      const view = renderBatchDelete();
      const id = await startWithCleanup(view);

      await answer(0, deleted("epic-a"));

      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(2);
      });
      const [message, options] = progressCalls().at(1) ?? [];
      expect(message).toBe("Removing 1 worktree…");
      expect(options?.id).toBe(id);
      expect(options?.duration).toBe(Infinity);
      expect(mocks.runWorktreeCleanup).toHaveBeenCalledTimes(1);
      expect(mocks.runWorktreeCleanup.mock.calls.at(0)?.[1].paths).toEqual([
        "/wt/a",
      ]);
      // The tasks are gone, the worktrees are not: nothing is dismissed or
      // summarised yet.
      expect(mocks.toastDismiss).not.toHaveBeenCalled();
      expect(mocks.toastSuccess).not.toHaveBeenCalled();

      await cleanup.settle({ removed: ["/wt/a"], failed: [], uncertain: [] });

      await waitFor(() => {
        expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
      });
      expect(mocks.toastDismiss).toHaveBeenCalledTimes(1);
      expect(mocks.toastDismiss).toHaveBeenCalledWith(id);
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Epic was deleted · 1 worktree removed",
      );
      expect(orderOf(mocks.toastDismiss)).toBeLessThan(
        orderOf(mocks.toastSuccess),
      );
    });

    it("counts the worktrees in the second phase", async () => {
      holdCleanup();
      const view = renderBatchDelete();
      view.dispatch(deleteOf(["epic-a"], cleanupOf("/wt/a", "/wt/b")));
      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
      });

      await answer(0, deleted("epic-a"));

      await waitFor(() => {
        expect(mocks.toastMessage).toHaveBeenCalledTimes(2);
      });
      expect(progressCalls().at(1)?.[0]).toBe("Removing 2 worktrees…");
    });

    // Sonner re-creates a toast an update names by id, so advancing a progress
    // toast the person has already closed would put it straight back.
    it("does not bring back a progress toast the person closed, and still shows the summary", async () => {
      const cleanup = holdCleanup();
      const view = renderBatchDelete();
      const id = await startWithCleanup(view);
      toastScreen.stillShown = false;

      await answer(0, deleted("epic-a"));

      await waitFor(() => {
        expect(mocks.runWorktreeCleanup).toHaveBeenCalledTimes(1);
      });
      expect(mocks.toastGetToasts).toHaveBeenCalled();
      expect(mocks.toastMessage).toHaveBeenCalledTimes(1);

      await cleanup.settle({ removed: ["/wt/a"], failed: [], uncertain: [] });

      await waitFor(() => {
        expect(mocks.toastSuccess).toHaveBeenCalledWith(
          "Epic was deleted · 1 worktree removed",
        );
      });
      expect(mocks.toastDismiss).toHaveBeenCalledWith(id);
    });

    it("downgrades the summary to a warning when a worktree could not be removed, still dismissing first", async () => {
      const cleanup = holdCleanup();
      const view = renderBatchDelete();
      const id = await startWithCleanup(view);
      await answer(0, deleted("epic-a"));
      await waitFor(() => {
        expect(mocks.runWorktreeCleanup).toHaveBeenCalledTimes(1);
      });

      await cleanup.settle({
        removed: [],
        failed: [{ worktreePath: "/wt/a", reason: "Still in use." }],
        uncertain: [],
      });

      await waitFor(() => {
        expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
      });
      expect(mocks.toastDismiss).toHaveBeenCalledWith(id);
      expect(orderOf(mocks.toastDismiss)).toBeLessThan(
        orderOf(mocks.toastWarning),
      );
    });

    it("dismisses the toast and reports the deletion if the cleanup itself rejects", async () => {
      const cleanup = holdCleanup();
      const view = renderBatchDelete();
      const id = await startWithCleanup(view);
      await answer(0, deleted("epic-a"));
      await waitFor(() => {
        expect(mocks.runWorktreeCleanup).toHaveBeenCalledTimes(1);
      });
      expect(mocks.toastDismiss).not.toHaveBeenCalled();

      await cleanup.fail(new Error("stream dropped"));

      await waitFor(() => {
        expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
      });
      expect(mocks.toastDismiss).toHaveBeenCalledWith(id);
      // The Task deletion happened, so the plain epic outcome is what says so.
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Epic was deleted");
      expect(orderOf(mocks.toastDismiss)).toBeLessThan(
        orderOf(mocks.toastSuccess),
      );
    });
  });
});
