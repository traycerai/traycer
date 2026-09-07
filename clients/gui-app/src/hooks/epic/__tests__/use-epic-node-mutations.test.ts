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
  // `getActiveHostId` is what scopes the deleted-artifact invalidation below to
  // the SESSION's host, so the sentinel has to answer it.
  session: { label: "session-client", getActiveHostId: () => "session-host" },
}));

const queryClientFixture = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => queryClientFixture,
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => clients.ambient,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => clients.ambient,
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => clients.session,
}));

const commandFixture = await vi.hoisted(async () => {
  // Hoisted above the static imports, so the store factory is imported here.
  const { createStore } = await import("zustand/vanilla");
  const state = {
    writeCommands: [] as ReadonlyArray<{
      readonly state: string;
      readonly intent: {
        readonly kind: string;
        readonly artifactId?: string;
      };
    }>,
    enqueueWriteCommand: vi.fn<(intent: unknown) => string | null>(),
    waitForWriteCommand: vi.fn<(commandId: string) => Promise<unknown>>(),
  };
  // A real vanilla store, not a callable stub: since the hook-order fix the
  // hooks subscribe through `useStore(handle.store, selector)`, so the fixture
  // must carry `subscribe` as well as `getState` or every render throws
  // "subscribe is not a function" from the passive-effect commit.
  const store = createStore<typeof state>(() => state);
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
import { act, renderHook } from "@testing-library/react";
import {
  useEpicCreateArtifact,
  useEpicDeleteArtifact,
  useEpicUpdateArtifactStatus,
  useEpicRenameArtifact,
} from "@/hooks/epic/use-epic-node-mutations";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { hostQueryKeys } from "@/lib/query-keys";

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
    const { result } = renderHook(() => useEpicDeleteArtifact("artifact-1"));

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
    const { result } = renderHook(() => useEpicDeleteArtifact("artifact-1"));
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

  // The tombstone inventory is a host QUERY, not a projected slice, so a
  // committed command leaves it stale unless the hook invalidates it. This
  // survived the move onto the write-command queue as an explicit call.
  it("refreshes the deleted-artifact inventory after deletion", async () => {
    commitCommand();
    const { result } = renderHook(() => useEpicDeleteArtifact("artifact-1"));

    await result.current.mutateAsync({
      epicId: "epic-1",
      artifactId: "artifact-1",
    });

    expect(queryClientFixture.invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope(
        "session-host",
        "epic.deletedArtifacts.list",
      ),
    });
  });

  it("does not invalidate when the delete is refused", async () => {
    rejectCommand("write denied");
    const { result } = renderHook(() => useEpicDeleteArtifact("artifact-1"));

    await expect(
      result.current.mutateAsync({
        epicId: "epic-1",
        artifactId: "artifact-1",
      }),
    ).rejects.toThrow("write denied");
    expect(queryClientFixture.invalidateQueries).not.toHaveBeenCalled();
  });
});

describe("useEpicUpdateArtifactStatus", () => {
  it("enqueues status changes and tracks the committed command", async () => {
    commitCommand();
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const { result } = renderHook(() =>
      useEpicUpdateArtifactStatus("artifact-1"),
    );

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
    const { result } = renderHook(() =>
      useEpicRenameArtifact("artifact-1", true),
    );

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
    // `null` rather than an id: this pin is about `trackUserIntent`, and the
    // hook's artifact is not what it discriminates on.
    const { result } = renderHook(() => useEpicRenameArtifact(null, false));

    await result.current.mutateAsync({
      epicId: "epic-1",
      artifactId: "artifact-1",
      title: "Renamed",
    });
    expect(track).not.toHaveBeenCalled();
  });

  it("shows the fallback for a superseded command", async () => {
    supersedeCommand();
    const { result } = renderHook(() =>
      useEpicRenameArtifact("artifact-1", true),
    );

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
    const deleteHook = renderHook(() => useEpicDeleteArtifact("artifact-1"));
    await deleteHook.result.current.mutateAsync({
      epicId: "epic-1",
      artifactId: "artifact-1",
    });
    expect(capturedClients).not.toHaveProperty("epic.deleteArtifact");

    const statusHook = renderHook(() =>
      useEpicUpdateArtifactStatus("artifact-1"),
    );
    await statusHook.result.current.mutateAsync({
      epicId: "epic-1",
      artifactId: "artifact-1",
      artifactType: "story",
      status: 1,
    });
    const renameHook = renderHook(() =>
      useEpicRenameArtifact("artifact-1", true),
    );
    await renameHook.result.current.mutateAsync({
      epicId: "epic-1",
      artifactId: "artifact-1",
      title: "Renamed",
    });
    expect(commandFixture.state.enqueueWriteCommand).toHaveBeenCalled();
  });
});

/**
 * The status and rename hooks' `mutate` wrappers
 * both do `void mutateAsync(v)` - `mutateAsync` toasts AND rethrows on a
 * refused write, so every refused status change / rename raises an
 * unhandled rejection nobody consumes. `useEpicDeleteArtifact`'s own `mutate`
 * (above) already attaches both a success and an error handler; these two do
 * not.
 *
 * Checked through Node's `process` event, not
 * `window.addEventListener("unhandledrejection")`: that listener does not
 * reliably fire under this repo's jsdom/vitest setup, and `vitest.config.ts`
 * sets `dangerouslyIgnoreUnhandledErrors: true` while
 * `__tests__/test-browser-apis.ts` registers its own process-level swallow -
 * so only an IN-BAND `process` listener is an honest observable here, not an
 * empty array that could just as well mean "nothing fired" as "nothing
 * rejected".
 */
interface NodeProcessLike {
  on(event: string, listener: (value: unknown) => void): void;
  off(event: string, listener: (value: unknown) => void): void;
}
const nodeProcess = (globalThis as { process?: NodeProcessLike }).process;

describe("mutate consumes the mutateAsync rejection instead of leaving it unhandled", () => {
  it("useEpicUpdateArtifactStatus: mutate toasts and does not unhandled-reject", async () => {
    if (nodeProcess === undefined) {
      throw new Error(
        "expected a Node `process` global in this test environment",
      );
    }
    rejectCommand("write denied");
    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    nodeProcess.on("unhandledRejection", onUnhandledRejection);
    try {
      const { result } = renderHook(() =>
        useEpicUpdateArtifactStatus("artifact-1"),
      );
      act(() => {
        result.current.mutate({
          epicId: "epic-1",
          artifactId: "artifact-1",
          artifactType: "ticket",
          status: 2,
        });
      });
      // Node reports `unhandledRejection` at the END of a turn, not on the
      // microtask the rejection itself settles on - a microtask flush alone
      // is not enough to observe it.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    } finally {
      nodeProcess.off("unhandledRejection", onUnhandledRejection);
    }
    expect(toast.error).toHaveBeenCalledWith("Couldn't update status.", {
      description: "write denied",
    });
    // THE REDDENING ONE.
    expect(rejections).toEqual([]);
  });

  it("useEpicRenameArtifact: mutate toasts and does not unhandled-reject", async () => {
    if (nodeProcess === undefined) {
      throw new Error(
        "expected a Node `process` global in this test environment",
      );
    }
    rejectCommand("write denied");
    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    nodeProcess.on("unhandledRejection", onUnhandledRejection);
    try {
      const { result } = renderHook(() =>
        useEpicRenameArtifact("artifact-1", true),
      );
      act(() => {
        result.current.mutate({
          epicId: "epic-1",
          artifactId: "artifact-1",
          title: "Renamed",
        });
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    } finally {
      nodeProcess.off("unhandledRejection", onUnhandledRejection);
    }
    expect(toast.error).toHaveBeenCalledWith("Couldn't rename artifact.", {
      description: "write denied",
    });
    // THE REDDENING ONE.
    expect(rejections).toEqual([]);
  });
});

/**
 * `isPending` on all three command-backed hooks matched ANY pending command of
 * that KIND, with no regard for which artifact it named - so one artifact's
 * in-flight status change disabled and spun EVERY status pill in the epic, and
 * an offline-retained command held every pill for as long as it was retained.
 *
 * Each hook now takes the artifact it speaks for. `null` means "this caller
 * speaks for no single artifact" - the sidebar's bulk-delete controller and
 * BOTH rename commit hooks, `useSwitcherRename` and its desktop twin
 * `useRenameCanvasTab`, whose node id arrives as an argument to the returned
 * callback rather than as a value at hook-call time. Three of the nine
 * production callers; none of them reads `isPending`, and `null` reports
 * `false` rather than "any".
 */
describe("isPending is scoped to the artifact the hook speaks for", () => {
  it("useEpicUpdateArtifactStatus: a pending command for X does not spin Y", () => {
    commandFixture.state.writeCommands = [
      {
        state: "pending",
        intent: { kind: "update-artifact-status", artifactId: "artifact-x" },
      },
    ];
    const forX = renderHook(() => useEpicUpdateArtifactStatus("artifact-x"));
    const forY = renderHook(() => useEpicUpdateArtifactStatus("artifact-y"));

    expect(forX.result.current.isPending).toBe(true);
    // THE REDDENING ONE - `true` before the fix, since `isPending` matched any
    // pending command of this KIND rather than this artifact's.
    expect(forY.result.current.isPending).toBe(false);
  });

  it("useEpicDeleteArtifact: a pending command for X does not spin Y", () => {
    commandFixture.state.writeCommands = [
      {
        state: "pending",
        intent: { kind: "delete-artifact", artifactId: "artifact-x" },
      },
    ];
    const forX = renderHook(() => useEpicDeleteArtifact("artifact-x"));
    const forY = renderHook(() => useEpicDeleteArtifact("artifact-y"));

    expect(forX.result.current.isPending).toBe(true);
    expect(forY.result.current.isPending).toBe(false);
  });

  it("useEpicRenameArtifact: a pending command for X does not spin Y", () => {
    commandFixture.state.writeCommands = [
      {
        state: "pending",
        intent: { kind: "rename-artifact", artifactId: "artifact-x" },
      },
    ];
    const forX = renderHook(() => useEpicRenameArtifact("artifact-x", true));
    const forY = renderHook(() => useEpicRenameArtifact("artifact-y", true));

    expect(forX.result.current.isPending).toBe(true);
    expect(forY.result.current.isPending).toBe(false);
  });

  it("a null artifactId never reports isPending, even while a command for another artifact is pending", () => {
    commandFixture.state.writeCommands = [
      {
        state: "pending",
        intent: { kind: "update-artifact-status", artifactId: "artifact-x" },
      },
    ];
    const forNull = renderHook(() => useEpicUpdateArtifactStatus(null));
    expect(forNull.result.current.isPending).toBe(false);
  });
});
