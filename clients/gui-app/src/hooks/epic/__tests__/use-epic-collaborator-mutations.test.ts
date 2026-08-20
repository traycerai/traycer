import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const mockSetQueryData = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: mockSetQueryData }),
}));

const mockGetActiveHostId = vi.fn<() => string | null>(() => "host-1");
// The EPIC SESSION's client, which is what these three hooks resolve: they are
// mounted only by the Sharing panel, inside the Epic canvas, and their cache
// writes must key the host that panel's list is read on. This suite used to
// mock the app-wide `useHostClient` instead - a mock that, after the hooks
// were re-pointed, would have been stranded (still installed, no longer read)
// and the suite would have gone red at the ctx read below rather than told
// us which host it was testing.
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => ({ getActiveHostId: mockGetActiveHostId }),
}));

interface MutateContext {
  readonly hostId: string | null;
}

interface CapturedMutationOptions {
  onMutate: (() => MutateContext) | undefined;
  onSuccess:
    | ((data: unknown, variables: unknown, ctx: MutateContext) => void)
    | undefined;
  onError: ((err: unknown) => void) | undefined;
}

const capturedOptions: Record<string, CapturedMutationOptions> = {};

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: {
    method: string;
    options: CapturedMutationOptions | null;
  }) => {
    capturedOptions[args.method] = args.options ?? {
      onMutate: undefined,
      onSuccess: undefined,
      onError: undefined,
    };
    return { mutate: vi.fn(), isPending: false };
  },
}));

/**
 * Drives `onSuccess` the way `useHostMutation` does: the context is whatever
 * `onMutate` captured at mutate time (the host-swap convention), so a hook
 * that reads the host at success time instead of mutate time cannot pass.
 */
function fireSuccess(method: string, data: unknown, variables: unknown): void {
  const options = capturedOptions[method];
  const ctx = options.onMutate?.() ?? { hostId: null };
  options.onSuccess?.(data, variables, ctx);
}

import { toast } from "sonner";
import { renderHook } from "@testing-library/react";
import {
  useEpicGrantAccess,
  useEpicBatchUpdateRoles,
  useEpicRevokeCollaborator,
} from "@/hooks/epic/use-epic-collaborator-mutations";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework/versioned-rpc-types";
import type { ListEpicCollaboratorsResponse } from "@traycer/protocol/host/epic/unary-schemas";

function makeError(code: RpcErrorCode, message: string): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "r1",
    method: "test.method",
    fatalDetails: null,
  });
}

function makeCollabResponse(): ListEpicCollaboratorsResponse {
  return { collaborators: [], collaboratorsAvailable: true };
}

beforeEach(() => {
  mockSetQueryData.mockClear();
  mockGetActiveHostId.mockReturnValue("host-1");
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

describe("useEpicGrantAccess", () => {
  it("registers with epic.grantAccess", () => {
    renderHook(() => useEpicGrantAccess());
    expect(capturedOptions["epic.grantAccess"]).toBeDefined();
  });

  it("shows permission copy for FORBIDDEN error", () => {
    renderHook(() => useEpicGrantAccess());
    capturedOptions["epic.grantAccess"].onError?.(
      makeError("FORBIDDEN", "test"),
    );
    expect(toast.error).toHaveBeenCalledWith(
      "You don't have permission to do that.",
    );
  });

  it("shows fallback copy for generic error", () => {
    renderHook(() => useEpicGrantAccess());
    capturedOptions["epic.grantAccess"].onError?.(
      makeError("RPC_ERROR", "test"),
    );
    expect(toast.error).toHaveBeenCalledWith("Couldn't invite collaborators.");
  });

  // ── `s5-status-truthfulness` instance 5 ───────────────────────────────
  //
  // Every case below hit one of the two sentences above on the pre-fix code:
  // a plan limit arrived as 403/`FORBIDDEN` and was reported as a permission
  // failure - false about the user's OWN account - and every pending state
  // arrived as a generic 409 and lost both its reason and its retry guidance.

  it("calls a plan limit a plan limit, with the upgrade path", () => {
    renderHook(() => useEpicGrantAccess());
    capturedOptions["epic.grantAccess"].onError?.(
      makeError("E_SHARE_NEEDS_CLOUD_SYNC", "host prose"),
    );
    const message = vi.mocked(toast.error).mock.calls[0]?.[0];
    expect(message).toContain("Upgrade");
    expect(message).not.toContain("You don't have permission");
  });

  it("does not blame permissions for a foreign local home either", () => {
    renderHook(() => useEpicGrantAccess());
    capturedOptions["epic.grantAccess"].onError?.(
      makeError("E_SHARE_NOT_OWNED", "host prose"),
    );
    const message = vi.mocked(toast.error).mock.calls[0]?.[0];
    expect(message).toContain("different account");
    expect(message).not.toContain("You don't have permission");
  });

  it("renders each promotion-pending reason with its own guidance", () => {
    // Split rather than sharing one string BECAUSE the advice differs: three
    // of these mean "wait", and `failed` is the one where it does not.
    const cases: ReadonlyArray<readonly [RpcErrorCode, string]> = [
      ["E_SHARE_PENDING_RECENT_ATTEMPT", "still being copied"],
      ["E_SHARE_PENDING_BUSY", "busy right now"],
      ["E_SHARE_PENDING_OFFLINE", "Check your connection"],
      ["E_SHARE_PENDING_FAILED", "Retrying won't help"],
    ];
    for (const [code, fragment] of cases) {
      vi.mocked(toast.error).mockClear();
      renderHook(() => useEpicGrantAccess());
      capturedOptions["epic.grantAccess"].onError?.(makeError(code, "prose"));
      const message = vi.mocked(toast.error).mock.calls[0]?.[0];
      expect(message).toContain(fragment);
      expect(message).not.toBe("Couldn't invite collaborators.");
    }
  });

  it("applies the same-client list update instantly from the grant response", () => {
    renderHook(() => useEpicGrantAccess());
    const data = makeCollabResponse();
    const variables = {
      epicId: "epic-abc",
      input: { kind: "users" as const, invites: [] },
    };
    fireSuccess("epic.grantAccess", data, variables);
    expect(mockSetQueryData).toHaveBeenCalledWith(
      ["host", "host-1", "epic.listCollaborators", { epicId: "epic-abc" }],
      data,
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("skips cache write when host id is null", () => {
    mockGetActiveHostId.mockReturnValue(null);
    renderHook(() => useEpicGrantAccess());
    const data = makeCollabResponse();
    const variables = {
      epicId: "epic-abc",
      input: { kind: "users" as const, invites: [] },
    };
    fireSuccess("epic.grantAccess", data, variables);
    expect(mockSetQueryData).not.toHaveBeenCalled();
  });
});

describe("useEpicBatchUpdateRoles", () => {
  it("registers with epic.batchUpdateRoles", () => {
    renderHook(() => useEpicBatchUpdateRoles());
    expect(capturedOptions["epic.batchUpdateRoles"]).toBeDefined();
  });

  it("shows permission copy for FORBIDDEN error", () => {
    renderHook(() => useEpicBatchUpdateRoles());
    capturedOptions["epic.batchUpdateRoles"].onError?.(
      makeError("FORBIDDEN", "test"),
    );
    expect(toast.error).toHaveBeenCalledWith(
      "You don't have permission to do that.",
    );
  });

  it("shows fallback copy for generic error", () => {
    renderHook(() => useEpicBatchUpdateRoles());
    capturedOptions["epic.batchUpdateRoles"].onError?.(
      makeError("RPC_ERROR", "test"),
    );
    expect(toast.error).toHaveBeenCalledWith("Couldn't update role.");
  });

  it("applies the same-client list update instantly from the role response", () => {
    renderHook(() => useEpicBatchUpdateRoles());
    const data = makeCollabResponse();
    const variables = { epicId: "epic-xyz", input: { changes: [] } };
    fireSuccess("epic.batchUpdateRoles", data, variables);
    expect(mockSetQueryData).toHaveBeenCalledWith(
      ["host", "host-1", "epic.listCollaborators", { epicId: "epic-xyz" }],
      data,
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("skips cache write when host id is null", () => {
    mockGetActiveHostId.mockReturnValue(null);
    renderHook(() => useEpicBatchUpdateRoles());
    const data = makeCollabResponse();
    const variables = { epicId: "epic-xyz", input: { changes: [] } };
    fireSuccess("epic.batchUpdateRoles", data, variables);
    expect(mockSetQueryData).not.toHaveBeenCalled();
  });
});

describe("useEpicRevokeCollaborator", () => {
  it("registers with epic.revokeCollaborator", () => {
    renderHook(() => useEpicRevokeCollaborator());
    expect(capturedOptions["epic.revokeCollaborator"]).toBeDefined();
  });

  it("shows permission copy for FORBIDDEN error", () => {
    renderHook(() => useEpicRevokeCollaborator());
    capturedOptions["epic.revokeCollaborator"].onError?.(
      makeError("FORBIDDEN", "test"),
    );
    expect(toast.error).toHaveBeenCalledWith(
      "You don't have permission to do that.",
    );
  });

  it("shows fallback copy for generic error", () => {
    renderHook(() => useEpicRevokeCollaborator());
    capturedOptions["epic.revokeCollaborator"].onError?.(
      makeError("RPC_ERROR", "test"),
    );
    expect(toast.error).toHaveBeenCalledWith("Couldn't remove collaborator.");
  });

  it("shows last-owner copy when revoke preserves that host reason", () => {
    renderHook(() => useEpicRevokeCollaborator());
    capturedOptions["epic.revokeCollaborator"].onError?.(
      makeError("RPC_ERROR", "Cannot revoke the last owner"),
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Can't revoke the only Owner. Transfer ownership first.",
    );
  });

  it("applies the same-client list update instantly from the revoke response", () => {
    renderHook(() => useEpicRevokeCollaborator());
    const data = makeCollabResponse();
    const variables = {
      epicId: "epic-rev",
      input: { kind: "users" as const, userId: "u-1" },
    };
    fireSuccess("epic.revokeCollaborator", data, variables);
    expect(mockSetQueryData).toHaveBeenCalledWith(
      ["host", "host-1", "epic.listCollaborators", { epicId: "epic-rev" }],
      data,
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("skips cache write when host id is null", () => {
    mockGetActiveHostId.mockReturnValue(null);
    renderHook(() => useEpicRevokeCollaborator());
    const data = makeCollabResponse();
    const variables = {
      epicId: "epic-rev",
      input: { kind: "users" as const, userId: "u-1" },
    };
    fireSuccess("epic.revokeCollaborator", data, variables);
    expect(mockSetQueryData).not.toHaveBeenCalled();
  });
});
