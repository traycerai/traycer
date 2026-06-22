import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => ({}),
}));

const capturedOptions: Record<string, unknown> = {};
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: { method: string; options: unknown }) => {
    capturedOptions[args.method] = args.options;
    return { mutate: vi.fn(), isPending: false };
  },
}));

import { toast } from "sonner";
import { renderHook } from "@testing-library/react";
import {
  useEpicCreateArtifact,
  useEpicDeleteArtifact,
  useEpicUpdateArtifactStatus,
  useEpicRenameArtifact,
} from "@/hooks/epic/use-epic-node-mutations";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";

function makeError(code: RpcErrorCode): HostRpcError {
  return new HostRpcError({
    code,
    message: "test",
    requestId: "test",
    method: "test",
    fatalDetails: null,
  });
}

describe("useEpicCreateArtifact", () => {
  it("registers with epic.createArtifact and shows fallback on error", () => {
    renderHook(() => useEpicCreateArtifact());
    const opts = capturedOptions["epic.createArtifact"] as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(makeError("RPC_ERROR"));
    expect(toast.error).toHaveBeenCalledWith("Couldn't create artifact.");
  });

  it("shows permission copy for FORBIDDEN", () => {
    renderHook(() => useEpicCreateArtifact());
    const opts = capturedOptions["epic.createArtifact"] as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(makeError("FORBIDDEN"));
    expect(toast.error).toHaveBeenCalledWith(
      "You don't have permission to do that.",
    );
  });
});

describe("useEpicDeleteArtifact", () => {
  it("shows fallback on error", () => {
    renderHook(() => useEpicDeleteArtifact());
    const opts = capturedOptions["epic.deleteArtifact"] as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(makeError("RPC_ERROR"));
    expect(toast.error).toHaveBeenCalledWith("Couldn't delete artifact.");
  });
});

describe("useEpicUpdateArtifactStatus", () => {
  it("shows fallback on error", () => {
    renderHook(() => useEpicUpdateArtifactStatus());
    const opts = capturedOptions["epic.updateArtifactStatus"] as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(makeError("RPC_ERROR"));
    expect(toast.error).toHaveBeenCalledWith("Couldn't update status.");
  });
});

describe("useEpicRenameArtifact", () => {
  it("shows fallback on error", () => {
    renderHook(() => useEpicRenameArtifact());
    const opts = capturedOptions["epic.renameArtifact"] as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(makeError("RPC_ERROR"));
    expect(toast.error).toHaveBeenCalledWith("Couldn't rename artifact.");
  });
});
