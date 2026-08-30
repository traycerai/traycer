import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Two DISTINGUISHABLE sentinels, so a regression to the ambient host fails on
// the value rather than on an absence: a build that reads `useHostClient()`
// again gets a real object back and would satisfy any "a client was passed"
// assertion.
const clients = vi.hoisted(() => ({
  ambient: { label: "ambient-client" },
  session: { label: "session-client" },
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => clients.ambient,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => clients.ambient,
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => clients.session,
}));

const capturedOptions: Record<string, unknown> = {};
const capturedClients: Record<string, unknown> = {};
const capturedScopedArgs: Record<string, unknown> = {};
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: {
    method: string;
    options: unknown;
    client: unknown;
  }) => {
    capturedOptions[args.method] = args.options;
    capturedClients[args.method] = args.client;
    return { mutate: vi.fn(), isPending: false };
  },
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: (
    client: unknown,
    args: { readonly method: string },
  ) => {
    capturedScopedArgs[args.method] = args;
    capturedClients[args.method] = client;
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
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

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
  it("refreshes the deleted-artifact inventory after deletion", () => {
    renderHook(() => useEpicDeleteArtifact());
    const args = capturedScopedArgs["epic.deleteArtifact"] as {
      readonly invalidateMethods: readonly string[];
      readonly errorMessage: string;
    };

    expect(args.invalidateMethods).toContain("epic.deletedArtifacts.list");
    expect(args.errorMessage).toBe("Couldn't delete artifact.");
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
    renderHook(() => useEpicRenameArtifact(true));
    const opts = capturedOptions["epic.renameArtifact"] as {
      onError: (e: HostRpcError) => void;
    };
    opts.onError(makeError("RPC_ERROR"));
    expect(toast.error).toHaveBeenCalledWith("Couldn't rename artifact.");
  });

  it("tracks ArtifactRenamed on success when trackUserIntent is true", () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();
    renderHook(() => useEpicRenameArtifact(true));
    const opts = capturedOptions["epic.renameArtifact"] as {
      onSuccess: () => void;
    };
    opts.onSuccess();
    expect(track).toHaveBeenCalledWith(AnalyticsEvent.ArtifactRenamed, null);
  });

  it("does not track on success when trackUserIntent is false", () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();
    renderHook(() => useEpicRenameArtifact(false));
    const opts = capturedOptions["epic.renameArtifact"] as {
      onSuccess: () => void;
    };
    opts.onSuccess();
    expect(track).not.toHaveBeenCalled();
  });
});

/**
 * An artifact is a row IN an Epic, and an Epic is projected from exactly one
 * machine - so every write here must address the SESSION's host, never the
 * app-wide effective one.
 *
 * The window where those differ is not theoretical: `EpicSessionProvider`
 * keeps the previous handle rendered while a re-point establishes and after
 * one fails, and only the CANVAS is made inert for it (`epic-shell.tsx` passes
 * `readOnly` to the tile subtree alone). The sidebar that issues these
 * mutations stays live, so a Delete clicked on a row projected from host A was
 * sent to host B.
 */
describe("epic node mutations address the Epic session's host", () => {
  const CASES: ReadonlyArray<[string, () => unknown]> = [
    ["epic.createArtifact", () => useEpicCreateArtifact()],
    ["epic.deleteArtifact", () => useEpicDeleteArtifact()],
    ["epic.updateArtifactStatus", () => useEpicUpdateArtifactStatus()],
    ["epic.renameArtifact", () => useEpicRenameArtifact(true)],
  ];

  it.each(CASES)("%s resolves the session client", (method, useHook) => {
    delete capturedClients[method];
    renderHook(useHook);

    // Premise, positively: the hook registered at all. Without this the
    // inequality below is satisfied by `undefined`.
    expect(capturedClients).toHaveProperty(method);
    expect(capturedClients[method]).toBe(clients.session);
    expect(capturedClients[method]).not.toBe(clients.ambient);
  });
});
