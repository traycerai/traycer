import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { toast } from "sonner";
import {
  toastFromHostError,
  toastFromHostErrorWithDetail,
} from "@/lib/host-error-toast";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import {
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";

function makeError(code: HostRpcError["code"], message: string): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "req-toast",
    method: "epic.revokeCollaborator",
    fatalDetails: null,
  });
}

function unauthorizedFatal(
  requestId: string,
  method: string,
  reason: string,
  retryable: boolean,
): HostRpcError {
  return new HostRpcError({
    code: "UNAUTHORIZED",
    message: reason,
    requestId,
    method,
    fatalDetails: {
      code: "UNAUTHORIZED",
      reason,
      incompatibleMethods: null,
      upgradeGuidance: null,
      ...(retryable ? { retryable: true } : {}),
    },
  });
}

describe("toastFromHostError", () => {
  afterEach(() => {
    vi.mocked(toast.error).mockClear();
    __resetAppLocalNotificationsStoreForTests();
  });

  it("shows permission copy for FORBIDDEN", () => {
    toastFromHostError(makeError("FORBIDDEN", "test error"), "fallback");
    expect(toast.error).toHaveBeenCalledWith(
      "You don't have permission to do that.",
    );
  });

  it("shows last-owner copy when the host message preserves that reason", () => {
    toastFromHostError(
      makeError("RPC_ERROR", "Cannot revoke the last owner"),
      "Couldn't remove collaborator.",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Can't revoke the only Owner. Transfer ownership first.",
    );
  });

  it("keeps generic permission copy for other FORBIDDEN errors", () => {
    toastFromHostError(
      makeError("FORBIDDEN", "User cannot revoke someone else"),
      "fallback",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "You don't have permission to do that.",
    );
  });

  it("shows sign-in copy for UNAUTHORIZED", () => {
    toastFromHostError(makeError("UNAUTHORIZED", "test error"), "fallback");
    expect(toast.error).toHaveBeenCalledWith("Please sign in again.");
  });

  it("uses verify-session copy for retryable UNAUTHORIZED host failures", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");
    const reason = "Signing key unavailable: request timed out";

    toastFromHostError(
      unauthorizedFatal("req-retryable-auth", "providers.list", reason, true),
      "Couldn't refresh providers.",
    );

    expect(toast.error).toHaveBeenCalledWith(
      "The host couldn't verify your session. Try again in a moment.",
      { id: "host-error:UNAUTHORIZED:UNAUTHORIZED", cancel: null },
    );
    expect(
      useAppLocalNotificationsStore.getState().byId[
        "host.error:UNAUTHORIZED:UNAUTHORIZED"
      ],
    ).toMatchObject({
      message: "The host couldn't verify your session. Try again in a moment.",
      detail: reason,
    });
  });

  it("collapses repeated same-cause fatal failures into one resurfacing feed entry", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");

    toastFromHostError(
      unauthorizedFatal(
        "req-1",
        "providers.list",
        "Expected 200 OK from the JSON Web Key Set endpoint",
        false,
      ),
      "Couldn't load providers.",
    );
    useAppLocalNotificationsStore
      .getState()
      .markAsRead("host.error:UNAUTHORIZED:UNAUTHORIZED", 10);
    toastFromHostError(
      unauthorizedFatal(
        "req-2",
        "epic.list",
        "Host is not provisioned - sign in on this machine to authorize it",
        false,
      ),
      "Couldn't load epics.",
    );

    const state = useAppLocalNotificationsStore.getState();
    expect(state.orderedIds).toEqual(["host.error:UNAUTHORIZED:UNAUTHORIZED"]);
    expect(state.byId["host.error:UNAUTHORIZED:UNAUTHORIZED"]).toMatchObject({
      message: "Please sign in again.",
      detail:
        "Host is not provisioned - sign in on this machine to authorize it",
      readAt: null,
    });
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenLastCalledWith("Please sign in again.", {
      id: "host-error:UNAUTHORIZED:UNAUTHORIZED",
      cancel: null,
    });
  });

  it("does not re-flip a recently acknowledged entry back to unread", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");

    toastFromHostError(
      unauthorizedFatal(
        "req-1",
        "providers.list",
        "Expected 200 OK from the JSON Web Key Set endpoint",
        false,
      ),
      "Couldn't load providers.",
    );
    const readAt = Date.now();
    useAppLocalNotificationsStore
      .getState()
      .markAsRead("host.error:UNAUTHORIZED:UNAUTHORIZED", readAt);
    toastFromHostError(
      unauthorizedFatal(
        "req-2",
        "epic.list",
        "Host is not provisioned - sign in on this machine to authorize it",
        false,
      ),
      "Couldn't load epics.",
    );

    const state = useAppLocalNotificationsStore.getState();
    expect(state.orderedIds).toEqual(["host.error:UNAUTHORIZED:UNAUTHORIZED"]);
    // A recurrence seconds after the user read the entry keeps it read but
    // still refreshes it with the latest cause detail.
    expect(state.byId["host.error:UNAUTHORIZED:UNAUTHORIZED"]).toMatchObject({
      readAt,
      detail:
        "Host is not provisioned - sign in on this machine to authorize it",
    });
    expect(state.unreadCount).toBe(0);
  });

  it("dedupes transport-failure toasts under one id without a feed entry", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");

    toastFromHostError(
      new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "WebSocket closed before next frame",
        requestId: "req-transport",
        method: "epic.list",
        fatalDetails: null,
      }),
      "Couldn't load epics.",
    );

    expect(toast.error).toHaveBeenCalledWith(
      "Can't reach the Traycer host. It may be restarting — try again in a moment.",
      { id: "host-error:transport", cancel: null },
    );
    expect(useAppLocalNotificationsStore.getState().orderedIds).toHaveLength(0);
  });

  it("shows rebind-blocked copy for WORKTREE_REBIND_BLOCKED", () => {
    toastFromHostError(
      makeError("WORKTREE_REBIND_BLOCKED", "Cannot rebind: chat is active."),
      "Couldn't create worktree.",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Stop the active run before rebinding the worktree.",
    );
  });

  it("shows upgrade copy for E_HOST_UNSUPPORTED without an app-local failure row", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");

    toastFromHostError(
      new HostRpcError({
        code: "E_HOST_UNSUPPORTED",
        message: "host.notifications.resolve is not supported",
        requestId: "req-unsupported-resolve",
        method: "host.notifications.resolve",
        fatalDetails: {
          code: "E_HOST_UNSUPPORTED",
          reason: "Method not advertised by this host",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      }),
      "Couldn't dismiss the notification.",
    );

    expect(toast.error).toHaveBeenCalledWith(
      "This needs a newer Traycer host. Update the host to continue.",
      {
        id: "host-error:E_HOST_UNSUPPORTED:E_HOST_UNSUPPORTED",
        cancel: null,
      },
    );
    expect(useAppLocalNotificationsStore.getState().orderedIds).toHaveLength(0);
  });

  it("shows the fallback for any other error code", () => {
    toastFromHostError(
      makeError("RPC_ERROR", "test error"),
      "Couldn't do the thing.",
    );
    expect(toast.error).toHaveBeenCalledWith("Couldn't do the thing.");
  });

  it("shows the fallback for other error codes", () => {
    toastFromHostError(
      makeError("INCOMPATIBLE", "test error"),
      "custom fallback",
    );
    expect(toast.error).toHaveBeenCalledWith("custom fallback");
  });

  it("can append raw host detail for scoped mutation failures", () => {
    toastFromHostErrorWithDetail(
      makeError("RPC_ERROR", "No connected OpenCode providers."),
      "Couldn't start terminal agent session.",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't start terminal agent session. No connected OpenCode providers.",
    );
  });

  // Review #1297 finding 2: host detail is unbounded by construction. The
  // producer that motivated forwarding it - `worktreeCreateFailed` - joins one
  // line per failed workspace, each an absolute path plus raw git stderr, so
  // appended verbatim it is an arbitrarily tall toast.
  describe("bounds free-form host detail", () => {
    it("keeps a realistic single-line worktree reason intact", () => {
      // The failure this whole change set exists for. Cutting it would drop
      // the clause that says WHY, which is the entire value of forwarding it.
      const reason =
        "git worktree add failed for traycer/tidy-badger at " +
        "/Users/tgill/.traycer/worktrees/traycerai__traycer-internal/" +
        "repo-tidy-badger: fatal: a branch named 'traycer/tidy-badger' " +
        "already exists";
      toastFromHostErrorWithDetail(
        makeError("RPC_ERROR", reason),
        "Couldn't create agent.",
      );
      expect(toast.error).toHaveBeenCalledWith(
        `Couldn't create agent. ${reason}`,
      );
    });

    it("shows the first failure and COUNTS the rest for a multi-entry failure", () => {
      toastFromHostErrorWithDetail(
        makeError(
          "RPC_ERROR",
          ["first failed: fatal: a", "second failed: fatal: b", ""].join("\n"),
        ),
        "Couldn't create agent.",
      );
      // The count, not a silent first-line take: dropping the other folders
      // without saying so is the quiet omission this change set removes. The
      // trailing blank line must not be counted as a third entry.
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't create agent. first failed: fatal: a (+1 more)",
      );
    });

    it("truncates a single line that is a diagnostic dump rather than a sentence", () => {
      toastFromHostErrorWithDetail(
        makeError("RPC_ERROR", "x".repeat(400)),
        "Couldn't create agent.",
      );
      // Pinned exactly rather than "is shorter than the input": the cut has to
      // be at the documented cap and it has to SAY it was cut.
      expect(toast.error).toHaveBeenCalledWith(
        `Couldn't create agent. ${"x".repeat(240)}…`,
      );
    });

    it("falls back to the plain copy when the detail is only whitespace", () => {
      toastFromHostErrorWithDetail(
        makeError("RPC_ERROR", "\n  \n"),
        "Couldn't create agent.",
      );
      expect(toast.error).toHaveBeenCalledWith("Couldn't create agent.");
    });
  });
});
