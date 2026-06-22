import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const mockSetQueryData = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: mockSetQueryData }),
}));

const mockGetActiveHostId = vi.fn<() => string | null>(() => "host-1");
vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => ({ getActiveHostId: mockGetActiveHostId }),
}));

const capturedOptions: Record<
  string,
  {
    onSuccess: ((data: unknown, variables: unknown) => void) | undefined;
    onError: ((err: unknown) => void) | undefined;
  }
> = {};

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: {
    method: string;
    options: {
      onSuccess: ((data: unknown, variables: unknown) => void) | undefined;
      onError: ((err: unknown) => void) | undefined;
    } | null;
  }) => {
    capturedOptions[args.method] = args.options ?? {
      onSuccess: undefined,
      onError: undefined,
    };
    return { mutate: vi.fn(), isPending: false };
  },
}));

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

  it("applies the same-client list update instantly from the grant response", () => {
    renderHook(() => useEpicGrantAccess());
    const data = makeCollabResponse();
    const variables = {
      epicId: "epic-abc",
      input: { kind: "users" as const, invites: [] },
    };
    capturedOptions["epic.grantAccess"].onSuccess?.(data, variables);
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
    capturedOptions["epic.grantAccess"].onSuccess?.(data, variables);
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
    capturedOptions["epic.batchUpdateRoles"].onSuccess?.(data, variables);
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
    capturedOptions["epic.batchUpdateRoles"].onSuccess?.(data, variables);
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
    capturedOptions["epic.revokeCollaborator"].onSuccess?.(data, variables);
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
    capturedOptions["epic.revokeCollaborator"].onSuccess?.(data, variables);
    expect(mockSetQueryData).not.toHaveBeenCalled();
  });
});
