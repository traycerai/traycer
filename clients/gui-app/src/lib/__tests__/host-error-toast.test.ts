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
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

function makeError(code: HostRpcError["code"], message: string): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "req-toast",
    method: "epic.revokeCollaborator",
    fatalDetails: null,
  });
}

describe("toastFromHostError", () => {
  afterEach(() => {
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

  it("uses operation copy for retryable UNAUTHORIZED host failures", () => {
    __resetAppLocalNotificationsStoreForTests();
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");
    const reason = "Signing key unavailable: request timed out";
    const error = new HostRpcError({
      code: "UNAUTHORIZED",
      message: reason,
      requestId: "req-retryable-auth",
      method: "providers.list",
      fatalDetails: {
        code: "UNAUTHORIZED",
        reason,
        incompatibleMethods: null,
        upgradeGuidance: null,
        retryable: true,
      },
    });

    toastFromHostError(error, "Couldn't refresh providers.");

    expect(toast.error).toHaveBeenCalledWith("Couldn't refresh providers.");
    expect(
      useAppLocalNotificationsStore.getState().byId[
        "host.error:providers.list:req-retryable-auth"
      ],
    ).toMatchObject({
      message: "Couldn't refresh providers.",
      detail: reason,
    });
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
});
