import { beforeEach, describe, expect, it, vi } from "vitest";

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

const commandFixture = vi.hoisted(() => {
  const state = {
    writeCommands: [] as ReadonlyArray<{
      readonly state: string;
      readonly intent: { readonly kind: string };
    }>,
    enqueueWriteCommand: vi.fn<(intent: unknown) => string | null>(),
    waitForWriteCommand: vi.fn<(commandId: string) => Promise<unknown>>(),
  };
  const store = Object.assign(
    <T>(selector: (candidate: typeof state) => T): T => selector(state),
    { getState: (): typeof state => state },
  );
  return { state, handle: { store } };
});

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => commandFixture.handle,
}));

const capturedOptions: Record<string, unknown> = {};
const capturedClients: Record<string, unknown> = {};
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

function commitCommand(): void {
  commandFixture.state.enqueueWriteCommand.mockReturnValue("command-1");
  commandFixture.state.waitForWriteCommand.mockResolvedValue({
    state: "committed",
    resolution: { kind: "echo", source: "authoritative-projection" },
  });
}

function rejectCommand(reason: string): void {
  commandFixture.state.enqueueWriteCommand.mockReturnValue("command-1");
  commandFixture.state.waitForWriteCommand.mockResolvedValue({
    state: "rejected",
    resolution: { kind: "rejected", reason },
  });
}

function supersedeCommand(): void {
  commandFixture.state.enqueueWriteCommand.mockReturnValue("command-1");
  commandFixture.state.waitForWriteCommand.mockResolvedValue({
    state: "superseded",
    resolution: { kind: "superseded", source: "authoritative-projection" },
  });
}

beforeEach(() => {
  commandFixture.state.writeCommands = [];
  commandFixture.state.enqueueWriteCommand.mockReset();
  commandFixture.state.waitForWriteCommand.mockReset();
  vi.clearAllMocks();
});

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
  it("enqueues the delete and resolves a committed command", async () => {
    commitCommand();
    const { result } = renderHook(() => useEpicDeleteArtifact());

    await expect(
      result.current.mutateAsync({
        epicId: "epic-1",
        artifactId: "artifact-1",
      }),
    ).resolves.toEqual({ deleted: true });
    expect(commandFixture.state.enqueueWriteCommand).toHaveBeenCalledWith({
      kind: "delete-artifact",
      artifactId: "artifact-1",
    });
    expect(commandFixture.state.waitForWriteCommand).toHaveBeenCalledWith(
      "command-1",
    );
  });

  it("keeps rejected and superseded terminal outcomes on the error path", async () => {
    rejectCommand("write denied");
    const { result } = renderHook(() => useEpicDeleteArtifact());
    await expect(
      result.current.mutateAsync({
        epicId: "epic-1",
        artifactId: "artifact-1",
      }),
    ).rejects.toThrow("write denied");
    expect(toast.error).toHaveBeenCalledWith("Couldn't delete artifact.", {
      description: "write denied",
    });

    vi.clearAllMocks();
    supersedeCommand();
    await expect(
      result.current.mutateAsync({
        epicId: "epic-1",
        artifactId: "artifact-2",
      }),
    ).rejects.toThrow("A newer authoritative change superseded this write");
    expect(toast.error).toHaveBeenCalledWith("Couldn't delete artifact.", {
      description: "A newer authoritative change superseded this write",
    });
  });
});

describe("useEpicUpdateArtifactStatus", () => {
  it("enqueues status changes and tracks the committed command", async () => {
    commitCommand();
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const { result } = renderHook(() => useEpicUpdateArtifactStatus());

    await expect(
      result.current.mutateAsync({
        epicId: "epic-1",
        artifactId: "artifact-1",
        artifactType: "ticket",
        status: 2,
      }),
    ).resolves.toEqual({ updated: true });
    expect(commandFixture.state.enqueueWriteCommand).toHaveBeenCalledWith({
      kind: "update-artifact-status",
      artifactId: "artifact-1",
      artifactType: "ticket",
      status: 2,
    });
    expect(track).toHaveBeenCalledWith(AnalyticsEvent.ArtifactStatusChanged, {
      kind: "ticket",
      status: 2,
    });
  });
});

describe("useEpicRenameArtifact", () => {
  it("tracks ArtifactRenamed after a committed command", async () => {
    commitCommand();
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const { result } = renderHook(() => useEpicRenameArtifact(true));

    await expect(
      result.current.mutateAsync({
        epicId: "epic-1",
        artifactId: "artifact-1",
        title: "Renamed",
      }),
    ).resolves.toEqual({ updated: true });
    expect(commandFixture.state.enqueueWriteCommand).toHaveBeenCalledWith({
      kind: "rename-artifact",
      artifactId: "artifact-1",
      title: "Renamed",
    });
    expect(track).toHaveBeenCalledWith(AnalyticsEvent.ArtifactRenamed, null);
  });

  it("does not track a committed command when trackUserIntent is false", async () => {
    commitCommand();
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const { result } = renderHook(() => useEpicRenameArtifact(false));

    await result.current.mutateAsync({
      epicId: "epic-1",
      artifactId: "artifact-1",
      title: "Renamed",
    });
    expect(track).not.toHaveBeenCalled();
  });

  it("shows the fallback for a superseded command", async () => {
    supersedeCommand();
    const { result } = renderHook(() => useEpicRenameArtifact(true));

    await expect(
      result.current.mutateAsync({
        epicId: "epic-1",
        artifactId: "artifact-1",
        title: "Renamed",
      }),
    ).rejects.toThrow("A newer authoritative change superseded this write");
    expect(toast.error).toHaveBeenCalledWith("Couldn't rename artifact.", {
      description: "A newer authoritative change superseded this write",
    });
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
  it("keeps the legacy create mutation on the session client", () => {
    delete capturedClients["epic.createArtifact"];
    renderHook(() => useEpicCreateArtifact());
    expect(capturedClients["epic.createArtifact"]).toBe(clients.session);
    expect(capturedClients["epic.createArtifact"]).not.toBe(clients.ambient);
  });

  it("routes migrated node mutations through the command-backed handle", async () => {
    commitCommand();
    const deleteHook = renderHook(() => useEpicDeleteArtifact());
    await deleteHook.result.current.mutateAsync({
      epicId: "epic-1",
      artifactId: "artifact-1",
    });
    expect(capturedClients).not.toHaveProperty("epic.deleteArtifact");

    const statusHook = renderHook(() => useEpicUpdateArtifactStatus());
    await statusHook.result.current.mutateAsync({
      epicId: "epic-1",
      artifactId: "artifact-1",
      artifactType: "story",
      status: 1,
    });
    const renameHook = renderHook(() => useEpicRenameArtifact(true));
    await renameHook.result.current.mutateAsync({
      epicId: "epic-1",
      artifactId: "artifact-1",
      title: "Renamed",
    });
    expect(commandFixture.state.enqueueWriteCommand).toHaveBeenCalled();
  });
});
