/**
 * Task delete when the active host is down (issue #1628, design 4.6).
 *
 * `epic.batchDelete` goes to the active host while its lease can serve. When
 * it cannot, the call goes to a live host - this machine's host first, then any
 * other live host - carrying only the cloud-homed ids; the local-homed ones
 * exist on the down host alone and are answered "not deleted", counted in the
 * outcome toast with the reason.
 *
 * A stand-in deletes its ids from the ACCOUNT, so the answer it gives is
 * tombstoned account-wide even when an older one omits `home`; and the active
 * host's worktrees cannot be removed while it is down, which the toast says.
 *
 * Real: the hook, `useHostMutation`, the `QueryClient`, the selection
 * authority store, the auth store (signed in). Faked at their boundaries: the
 * hosts (one client per host id, recording what it was sent), the router,
 * sonner, the reportable toasts, the worktree cleanup and the host-error toast.
 */
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { BatchDeleteResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";

const mocks = vi.hoisted(() => ({
  toastMessage: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  toastDismiss: vi.fn(),
  toastGetToasts: vi.fn(() => []),
  toastFromHostError: vi.fn(),
  reportableWarningToast: vi.fn(),
  reportableErrorToast: vi.fn(),
  publishDeletedEpicNotification: vi.fn(),
  navigate: vi.fn(() => Promise.resolve()),
  runWorktreeCleanup: vi.fn(() =>
    Promise.resolve({ removed: [], failed: [], uncertain: [] }),
  ),
}));

interface SentRequest {
  readonly hostId: string;
  readonly method: string;
  readonly params: { readonly ids: readonly string[] };
}

const hosts = vi.hoisted(() => {
  const state: {
    activeHostId: string;
    localHostId: string | null;
    sent: SentRequest[];
    /** The `home` every success row states; `null` is an older host's omission. */
    home: "cloud" | "local" | null;
    /** What every request rejects with, instead of answering; `null` answers. */
    failWith: Error | null;
  } = {
    activeHostId: "active",
    localHostId: "this-machine",
    sent: [],
    home: "cloud",
    failWith: null,
  };
  const clientFor = (hostId: string) => ({
    getActiveHostId: (): string => hostId,
    getRequestContextUserId: (): string => "user-1",
    request: (
      method: string,
      params: { readonly ids: readonly string[] },
    ): Promise<BatchDeleteResponse> => {
      state.sent.push({ hostId, method, params });
      if (state.failWith !== null) return Promise.reject(state.failWith);
      return Promise.resolve({
        results: params.ids.map((taskId) =>
          state.home === null
            ? { taskId, success: true }
            : { taskId, success: true, home: state.home },
        ),
      });
    },
  });
  return { state, clientFor };
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
  useHostClient: () => hosts.clientFor(hosts.state.activeHostId),
  useHostBinding: () => ({
    hostId: null,
    hostClient: { createRequesterForHostId: hosts.clientFor },
  }),
}));

vi.mock("@/lib/host/local-host-id-snapshot", () => ({
  readLocalHostIdSnapshot: () => hosts.state.localHostId,
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
  useWorktreeDeleteStreamTransportFactory: () => () => null,
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

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableWarningToast: mocks.reportableWarningToast,
  reportableErrorToast: mocks.reportableErrorToast,
}));

vi.mock("@/lib/epics/deleted-epic-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epics/deleted-epic-events")>()),
  publishDeletedEpicNotification: mocks.publishDeletedEpicNotification,
}));

import {
  EPIC_DELETE_ACCOUNT_CHANGED_MESSAGE,
  EPIC_DELETE_HOST_UNREACHABLE_MESSAGE,
  WORKTREE_CLEANUP_SKIPPED_DETAIL,
  routeEpicBatchDelete,
  useEpicBatchDelete,
  type BatchDeleteEpicVariables,
} from "@/hooks/epic/use-epic-batch-delete-mutation";
import { OWNER_HOST_UNREACHABLE_NOTICE } from "@/lib/owner-host-write-error-toast";
import {
  deletedCloudEpicTasksPageEpicIdsForScope,
  useCloudEpicTasksPagesStore,
} from "@/stores/epics/cloud-epic-tasks-pages-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

function lease(
  hostId: string,
  status: "ready" | "connecting" | "dead",
): HostLeaseSnapshot {
  return status === "dead"
    ? { hostId, status, dead: { reason: "offline" } }
    : { hostId, status, dead: null };
}

function publishLeases(...leases: HostLeaseSnapshot[]): void {
  useSelectionAuthorityStore.setState({ attached: true, leases });
}

async function dispatch(variables: BatchDeleteEpicVariables): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const { result } = renderHook(() => useEpicBatchDelete(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync(variables).catch(() => undefined);
  });
}

/** The rows local-homed now, among `ids`. */
function localHomed(...ids: string[]): (epicId: string) => boolean {
  return (epicId) => ids.includes(epicId);
}

beforeEach(() => {
  hosts.state.activeHostId = "active";
  hosts.state.localHostId = "this-machine";
  hosts.state.sent.length = 0;
  hosts.state.home = "cloud";
  hosts.state.failWith = null;
  useCloudEpicTasksPagesStore.setState({
    pagesByIdentity: {},
    generationByIdentity: {},
    deletedEpicIdsByScope: {},
  });
  for (const mock of Object.values(mocks)) mock.mockClear();
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
});

describe("Task delete while the active host is down", () => {
  it("goes to this machine's host first, with only the cloud-homed ids", async () => {
    publishLeases(
      lease("active", "dead"),
      lease("elsewhere", "ready"),
      lease("this-machine", "ready"),
    );

    await dispatch({
      ids: ["cloud-a", "local-b", "cloud-c"],
      isLocalHomedNow: localHomed("local-b"),
      boundUserId: "user-1",
      worktreeCleanup: null,
    });

    expect(hosts.state.sent).toEqual([
      {
        hostId: "this-machine",
        method: "epic.batchDelete",
        params: { ids: ["cloud-a", "cloud-c"] },
      },
    ]);
    // The outcome counts the person's whole selection: the refused Task is
    // one of three, with the reason it was not deleted.
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.reportableWarningToast).toHaveBeenCalledTimes(1);
    expect(mocks.reportableWarningToast.mock.calls[0]?.[0]).toBe(
      "Deleted 2 of 3; 1 failed.",
    );
    expect(mocks.reportableWarningToast.mock.calls[0]?.[1]).toEqual({
      description: EPIC_DELETE_HOST_UNREACHABLE_MESSAGE,
    });
  });

  it("goes to another live host when this machine's host is not live", async () => {
    publishLeases(
      lease("active", "dead"),
      lease("this-machine", "connecting"),
      lease("elsewhere", "ready"),
    );

    await dispatch({
      ids: ["cloud-a"],
      isLocalHomedNow: localHomed(),
      boundUserId: "user-1",
      worktreeCleanup: null,
    });

    expect(hosts.state.sent.map((request) => request.hostId)).toEqual([
      "elsewhere",
    ]);
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    expect(mocks.reportableWarningToast).not.toHaveBeenCalled();
  });

  it("sends nothing when every id is local-homed, and says why", async () => {
    publishLeases(lease("active", "dead"), lease("this-machine", "ready"));

    await dispatch({
      ids: ["local-a", "local-b"],
      isLocalHomedNow: localHomed("local-a", "local-b"),
      boundUserId: "user-1",
      worktreeCleanup: null,
    });

    expect(hosts.state.sent).toEqual([]);
    expect(mocks.reportableErrorToast).toHaveBeenCalledTimes(1);
    expect(mocks.reportableErrorToast.mock.calls[0]?.[0]).toBe(
      "Couldn't delete 2 tasks.",
    );
    expect(mocks.reportableErrorToast.mock.calls[0]?.[1]).toEqual({
      description: EPIC_DELETE_HOST_UNREACHABLE_MESSAGE,
    });
    expect(mocks.toastFromHostError).not.toHaveBeenCalled();
    // The progress toast is taken down, never left spinning.
    expect(mocks.toastDismiss).toHaveBeenCalled();
  });

  // #2561 composed with the fallback route: a delete chosen under another
  // account sends nothing, on any route. The ids the stand-in would have
  // been sent are refused for the account; the local-homed ones keep their
  // own reason, since choosing them again cannot reach the down host.
  it("sends nothing when the account changed, keeping the down host's reason for its local-homed ids", async () => {
    publishLeases(lease("active", "dead"), lease("this-machine", "ready"));

    await dispatch({
      ids: ["cloud-a", "local-b"],
      isLocalHomedNow: localHomed("local-b"),
      boundUserId: "someone-else",
      worktreeCleanup: null,
    });

    expect(hosts.state.sent).toEqual([]);
    expect(mocks.reportableErrorToast).toHaveBeenCalledTimes(1);
    expect(mocks.reportableErrorToast.mock.calls[0]?.[0]).toBe(
      "Couldn't delete 2 tasks.",
    );
    expect(mocks.reportableErrorToast.mock.calls[0]?.[1]).toEqual({
      description: `${EPIC_DELETE_HOST_UNREACHABLE_MESSAGE} · ${EPIC_DELETE_ACCOUNT_CHANGED_MESSAGE}`,
    });
  });

  // traycer#2556 composed with the fallback route: the stand-in's request
  // never reaches its host, so its cloud-homed ids were not deleted either.
  // One notice gives both reasons - the stand-in unreachable and the
  // local-homed Task left on the down host - over the whole selection.
  it("names the down host's local-homed Task beside the unreachable stand-in, in one notice", async () => {
    publishLeases(lease("active", "dead"), lease("this-machine", "ready"));
    hosts.state.failWith = new RetryableTransportError({
      replaySafetyFromKey: false,
      code: "RPC_ERROR",
      message: "Remote session is not ready",
      requestId: "request-1",
      method: "epic.batchDelete",
      fatalDetails: null,
    });

    await dispatch({
      ids: ["cloud-a", "local-b"],
      isLocalHomedNow: localHomed("local-b"),
      boundUserId: "user-1",
      worktreeCleanup: null,
    });

    expect(hosts.state.sent).toEqual([
      {
        hostId: "this-machine",
        method: "epic.batchDelete",
        params: { ids: ["cloud-a"] },
      },
    ]);
    expect(mocks.reportableErrorToast).toHaveBeenCalledTimes(1);
    expect(mocks.reportableErrorToast.mock.calls[0]?.[0]).toBe(
      "Couldn't delete 2 tasks.",
    );
    expect(mocks.reportableErrorToast.mock.calls[0]?.[1]).toEqual({
      description: `${OWNER_HOST_UNREACHABLE_NOTICE} · ${EPIC_DELETE_HOST_UNREACHABLE_MESSAGE}`,
    });
    // One notice: the unreachable-host line is not raised on its own too.
    expect(mocks.toastFromHostError).not.toHaveBeenCalled();
    expect(mocks.toastDismiss).toHaveBeenCalled();
  });

  it("does not try to remove the down host's worktrees", async () => {
    publishLeases(lease("active", "dead"), lease("this-machine", "ready"));

    await dispatch({
      ids: ["cloud-a"],
      isLocalHomedNow: localHomed(),
      boundUserId: "user-1",
      worktreeCleanup: {
        candidates: [{ worktreePath: "/wt/a", ownerEpicIds: ["cloud-a"] }],
      },
    });

    expect(hosts.state.sent.map((request) => request.hostId)).toEqual([
      "this-machine",
    ]);
    expect(mocks.runWorktreeCleanup).not.toHaveBeenCalled();
  });

  it("warns that the approved worktree was not removed, and why", async () => {
    publishLeases(lease("active", "dead"), lease("this-machine", "ready"));

    await dispatch({
      ids: ["cloud-a"],
      isLocalHomedNow: localHomed(),
      boundUserId: "user-1",
      worktreeCleanup: {
        candidates: [{ worktreePath: "/wt/a", ownerEpicIds: ["cloud-a"] }],
      },
    });

    expect(mocks.runWorktreeCleanup).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.reportableWarningToast).toHaveBeenCalledTimes(1);
    expect(String(mocks.reportableWarningToast.mock.calls[0]?.[0])).toMatch(
      / · 1 worktree not removed$/,
    );
    expect(mocks.reportableWarningToast.mock.calls[0]?.[1]).toEqual({
      description: WORKTREE_CLEANUP_SKIPPED_DETAIL,
    });
  });

  it("counts every approved worktree whose owners were all deleted", async () => {
    publishLeases(lease("active", "dead"), lease("this-machine", "ready"));

    await dispatch({
      ids: ["cloud-a", "cloud-b"],
      isLocalHomedNow: localHomed(),
      boundUserId: "user-1",
      worktreeCleanup: {
        candidates: [
          { worktreePath: "/wt/a", ownerEpicIds: ["cloud-a"] },
          { worktreePath: "/wt/b", ownerEpicIds: ["cloud-b"] },
        ],
      },
    });

    expect(mocks.runWorktreeCleanup).not.toHaveBeenCalled();
    expect(String(mocks.reportableWarningToast.mock.calls[0]?.[0])).toMatch(
      / · 2 worktrees not removed$/,
    );
  });

  it("does not count a worktree one of whose owners was not deleted: it was never due for removal", async () => {
    publishLeases(lease("active", "dead"), lease("this-machine", "ready"));

    await dispatch({
      ids: ["cloud-a", "local-b"],
      isLocalHomedNow: localHomed("local-b"),
      boundUserId: "user-1",
      worktreeCleanup: {
        candidates: [
          { worktreePath: "/wt/shared", ownerEpicIds: ["cloud-a", "local-b"] },
        ],
      },
    });

    expect(mocks.reportableWarningToast.mock.calls[0]?.[0]).toBe(
      "Deleted 1 of 2; 1 failed.",
    );
    expect(mocks.reportableWarningToast.mock.calls[0]?.[1]).toEqual({
      description: EPIC_DELETE_HOST_UNREACHABLE_MESSAGE,
    });
  });
});

describe("Task delete through a stand-in host that omits `home`", () => {
  // `deletedCloudEpicTasksPageEpicIdsForScope(host, user)` is what a retained
  // History page of `host` is filtered by: the account-wide bucket plus that
  // host's own. A host that is neither the active host nor the stand-in sees
  // only an account-wide tombstone.
  const BYSTANDER = "bystander-host";

  function tombstonedOn(hostId: string): readonly string[] {
    return [...deletedCloudEpicTasksPageEpicIdsForScope(hostId, "user-1")];
  }

  it("tombstones the success account-wide, so another host's retained page drops the Task too", async () => {
    publishLeases(lease("active", "dead"), lease("this-machine", "ready"));
    hosts.state.home = null;

    await dispatch({
      ids: ["cloud-a"],
      isLocalHomedNow: localHomed(),
      boundUserId: "user-1",
      worktreeCleanup: null,
    });

    expect(hosts.state.sent.map((request) => request.hostId)).toEqual([
      "this-machine",
    ]);
    expect(tombstonedOn(BYSTANDER)).toEqual(["cloud-a"]);
  });

  it("keeps a stand-in's explicit `home: local` scoped to the stand-in that deleted it", async () => {
    // Codex thread 4303057015 on dc648adf0: the local tombstone belongs to the
    // host that performed the delete, never to the down host it stood in for.
    publishLeases(lease("active", "dead"), lease("this-machine", "ready"));
    hosts.state.home = "local";

    await dispatch({
      ids: ["cloud-a"],
      isLocalHomedNow: localHomed(),
      boundUserId: "user-1",
      worktreeCleanup: null,
    });

    expect(tombstonedOn("this-machine")).toEqual(["cloud-a"]);
    expect(tombstonedOn("active")).toEqual([]);
    expect(tombstonedOn(BYSTANDER)).toEqual([]);
  });

  it("tells other windows the scopes this window tombstoned in, under the host that deleted", async () => {
    // Codex thread 4303240636 on d74e2198: the cross-window notice named the
    // down active host and every receiver tombstoned account-wide, hiding a
    // local-homed Task a sibling host still serves.
    publishLeases(lease("active", "dead"), lease("this-machine", "ready"));
    hosts.state.home = "local";

    await dispatch({
      ids: ["cloud-a"],
      isLocalHomedNow: localHomed(),
      boundUserId: "user-1",
      worktreeCleanup: null,
    });

    expect(mocks.publishDeletedEpicNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "this-machine",
        userId: "user-1",
        epicIds: ["cloud-a"],
        hostScopedEpicIds: ["cloud-a"],
      }),
    );
  });

  it("keeps the same omission host-scoped on a direct route: only a stand-in's ids are known cloud-homed", async () => {
    publishLeases(lease("active", "ready"), lease("this-machine", "ready"));
    hosts.state.home = null;

    await dispatch({
      ids: ["cloud-a"],
      isLocalHomedNow: localHomed(),
      boundUserId: "user-1",
      worktreeCleanup: null,
    });

    expect(hosts.state.sent.map((request) => request.hostId)).toEqual([
      "active",
    ]);
    expect(tombstonedOn("active")).toEqual(["cloud-a"]);
    expect(tombstonedOn(BYSTANDER)).toEqual([]);
  });

  it("tombstones a stand-in's explicit `home: cloud` account-wide", async () => {
    publishLeases(lease("active", "dead"), lease("this-machine", "ready"));

    await dispatch({
      ids: ["cloud-a"],
      isLocalHomedNow: localHomed(),
      boundUserId: "user-1",
      worktreeCleanup: null,
    });

    expect(tombstonedOn(BYSTANDER)).toEqual(["cloud-a"]);
  });
});

describe("Task delete while the active host is down and the session is not signed in", () => {
  it("answers the cloud-homed ids not deleted for the sign-in and the local-homed ones for the host, sending nothing", async () => {
    publishLeases(lease("active", "dead"), lease("this-machine", "ready"));
    useAuthStore.setState({ status: "unverified" });

    await dispatch({
      ids: ["cloud-a", "local-b"],
      isLocalHomedNow: localHomed("local-b"),
      boundUserId: "user-1",
      worktreeCleanup: null,
    });

    expect(hosts.state.sent).toEqual([]);
    expect(mocks.reportableErrorToast).toHaveBeenCalledTimes(1);
    expect(mocks.reportableErrorToast.mock.calls[0]?.[0]).toBe(
      "Couldn't delete 2 tasks.",
    );
    const detail = String(
      (
        mocks.reportableErrorToast.mock.calls[0]?.[1] as
          | { readonly description: string }
          | undefined
      )?.description,
    );
    expect(detail).toContain(EPIC_DELETE_HOST_UNREACHABLE_MESSAGE);
    expect(detail).toContain("couldn't confirm your sign-in");
  });
});

describe("unchanged paths", () => {
  it("an active host that can serve removes the approved worktrees, with no skipped note", async () => {
    publishLeases(lease("active", "ready"), lease("this-machine", "ready"));

    await dispatch({
      ids: ["cloud-a"],
      isLocalHomedNow: localHomed(),
      boundUserId: "user-1",
      worktreeCleanup: {
        candidates: [{ worktreePath: "/wt/a", ownerEpicIds: ["cloud-a"] }],
      },
    });

    expect(mocks.runWorktreeCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.reportableWarningToast).not.toHaveBeenCalled();
  });

  it("an active host that can serve takes every id, local-homed included", async () => {
    publishLeases(lease("active", "ready"), lease("this-machine", "ready"));

    await dispatch({
      ids: ["cloud-a", "local-b"],
      isLocalHomedNow: localHomed("local-b"),
      boundUserId: "user-1",
      worktreeCleanup: null,
    });

    expect(hosts.state.sent).toEqual([
      {
        hostId: "active",
        method: "epic.batchDelete",
        params: { ids: ["cloud-a", "local-b"] },
      },
    ]);
    expect(mocks.reportableWarningToast).not.toHaveBeenCalled();
  });

  it("with no live host the call still goes to the active host", async () => {
    publishLeases(
      lease("active", "dead"),
      lease("this-machine", "dead"),
      lease("elsewhere", "connecting"),
    );

    await dispatch({
      ids: ["cloud-a", "local-b"],
      isLocalHomedNow: localHomed("local-b"),
      boundUserId: "user-1",
      worktreeCleanup: null,
    });

    expect(hosts.state.sent.map((request) => request.hostId)).toEqual([
      "active",
    ]);
    expect(hosts.state.sent[0]?.params.ids).toEqual(["cloud-a", "local-b"]);
  });
});

describe("routeEpicBatchDelete", () => {
  const fleet = {
    authorityAttached: true,
    leases: [lease("active", "dead"), lease("elsewhere", "ready")],
  };

  it("splits on the row's home only when it falls back", () => {
    expect(
      routeEpicBatchDelete({
        activeHostId: "active",
        ids: ["a", "b"],
        isLocalHomedNow: localHomed("b"),
        fleet,
        localHostId: () => null,
      }),
    ).toEqual({
      kind: "fallback",
      hostId: "elsewhere",
      sentIds: ["a"],
      refusedIds: ["b"],
    });
  });

  it("is direct with no active host", () => {
    expect(
      routeEpicBatchDelete({
        activeHostId: null,
        ids: ["a"],
        isLocalHomedNow: localHomed(),
        fleet,
        localHostId: () => null,
      }),
    ).toEqual({ kind: "direct", hostId: null, sentIds: ["a"], refusedIds: [] });
  });
});
