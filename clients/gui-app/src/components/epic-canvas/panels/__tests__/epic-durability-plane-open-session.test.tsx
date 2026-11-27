import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { epicStateSubscribeServerFrameSchemaV11 } from "@traycer/protocol/host/epic/state-subscribe";
import { epicStatusSubscribeServerFrameSchemaV12 } from "@traycer/protocol/host/epic/status-subscribe";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import type {
  EpicStatusSnapshotFrame,
  EpicStatusStreamCallbacks,
  EpicStatusTransitionFrame,
} from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type {
  EpicStateStreamCallbacks,
  EpicStateSnapshotFrame,
} from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type {
  ArtifactStreamClientFactory,
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type { EpicLaneSelectionSources } from "@/stores/epics/open-epic/runtime/epic-replica-runtime";
import { absentLaneUnaries } from "@/stores/epics/open-epic/test-support/absent-lane-unaries";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EpicConnectionPill } from "@/components/epic-canvas/panels/epic-connection-pill";
import { useEpicDurabilityPlane } from "@/components/epic-canvas/panels/epic-durability-plane";
import { useEpicCommentRoomAvailability } from "@/lib/epic-selectors";
import {
  EpicSessionContext,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

const EPIC_ID = "epic-durability-open-session";
const INITIAL_TITLE = "Durability evidence";
const POOL_EPOCH = "pool-mux-epoch-1";

// Captured from task-read-protocol.test.ts through the pool's real mux status
// subscription. The pool's @1.6 status producer emits cloud durability at the
// top level and does not emit a localProtection answer.
const POOL_SNAPSHOT: EpicStatusSnapshotFrame = parseStatusSnapshot({
  kind: "snapshot",
  authorityEpoch: POOL_EPOCH,
  securityEpoch: 1,
  permissionRole: "editor",
  cloudSyncStatus: "connected",
  dirty: false,
  migration: null,
  deletion: { state: "none" },
  durability: "cloud",
  hasBinaryPayload: false,
});
const POOL_DIRTY: EpicStatusTransitionFrame = parseStatusTransition({
  kind: "dirtyChanged",
  authorityEpoch: POOL_EPOCH,
  dirty: true,
  hasBinaryPayload: false,
});
const POOL_CLEAN: EpicStatusTransitionFrame = parseStatusTransition({
  kind: "dirtyChanged",
  authorityEpoch: POOL_EPOCH,
  dirty: false,
  hasBinaryPayload: false,
});

function buildRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function hostMessengerFactory(args: {
  readonly registry: HostRpcRegistry;
}): IHostMessenger<HostRpcRegistry> {
  return new MockHostMessenger<HostRpcRegistry>({
    registry: args.registry,
    requestId: () => "durability-pill-test-request",
    handlers: {
      "host.status": () =>
        Promise.resolve({
          ready: true,
          hostVersion: "1.2.3",
          protocolVersion: { major: 1, minor: 0 },
          busy: false,
          busySessionCount: 0,
          updateProgress: null,
          busyBreakdown: null,
          updateOperation: null,
          updateTransaction: null,
          storeFormats: null,
          install: null,
          processMemory: null,
          crossHostMessaging: null,
          sessions: null,
          updatesExternallyManaged: null,
          previousExit: null,
        }),
    },
  });
}

interface StatusRig {
  readonly handle: OpenedStoreForTest;
  readonly callbacks: EpicStatusStreamCallbacks;
}

function parseStatusSnapshot(
  frame: Record<string, unknown>,
): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV12.parse(frame);
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a status snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

function parseStatusTransition(
  frame: Record<string, unknown>,
): EpicStatusTransitionFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV12.parse(frame);
  if (parsed.kind === "snapshot" || parsed.kind === "pong") {
    throw new Error(`expected a status transition, got ${parsed.kind}`);
  }
  return parsed;
}

function stateSnapshot(authorityEpoch: string): EpicStateSnapshotFrame {
  const parsed = epicStateSubscribeServerFrameSchemaV11.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch,
    basis: "cold",
    position: 1,
    reconciledWithCloud: true,
    artifactRecords: [],
    deletedArtifacts: [],
    commentThreads: [],
    roleClaims: { revision: 1, claims: [] },
    epicMeta: {
      revision: 1,
      meta: { title: INITIAL_TITLE, updatedAt: 1000 },
    },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a state snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

function statusSnapshotForComputer(): EpicStatusSnapshotFrame {
  return parseStatusSnapshot({
    ...POOL_SNAPSHOT,
    authorityEpoch: "computer-status-epoch-1",
  });
}

function statusSnapshotWithoutDurability(): EpicStatusSnapshotFrame {
  const { durability: _durability, ...unknownSnapshot } = POOL_SNAPSHOT;
  return parseStatusSnapshot({
    ...unknownSnapshot,
    authorityEpoch: "pool-unknown-epoch-1",
  });
}

async function drain(handle: OpenedStoreForTest): Promise<void> {
  await handle.flush();
  await handle.flush();
  await handle.flush();
}

async function openStatusRig(
  hostId: string,
  snapshot: EpicStatusSnapshotFrame,
): Promise<StatusRig> {
  const laneCallbacks: {
    status: EpicStatusStreamCallbacks | null;
    state: EpicStateStreamCallbacks | null;
  } = { status: null, state: null };
  const statusFactory: EpicStatusStreamClientFactory = (_epicId, callbacks) => {
    laneCallbacks.status = callbacks;
    return { close: () => undefined };
  };
  const stateFactory: EpicStateStreamClientFactory = (_epicId, callbacks) => {
    laneCallbacks.state = callbacks;
    return { close: () => undefined };
  };
  const artifactFactory: ArtifactStreamClientFactory = () => ({
    applyUpdate: () => undefined,
    awareness: () => undefined,
    close: () => undefined,
  });
  const laneSelection: EpicLaneSelectionSources = {
    support: () => "supported",
    subscribeSupport: () => () => undefined,
    unaries: absentLaneUnaries(),
    stateStreamClientFactory: stateFactory,
    statusStreamClientFactory: statusFactory,
    artifactStreamClientFactory: artifactFactory,
  };
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: "user-a",
    factories: {
      streamClientFactory: () => {
        throw new Error("the real status lane must own the control snapshot");
      },
      laneSelection,
    },
    writeCommand: null,
  });
  handleHostIds.set(handle, hostId);
  const { status: callbacks, state: stateCallbacks } = laneCallbacks;
  if (callbacks === null || stateCallbacks === null) {
    throw new Error("the lane factories did not capture their callbacks");
  }
  useAuthStore.setState({ status: "signed-in" });
  callbacks.onConnectionStatus("open", null, null, null);
  stateCallbacks.onConnectionStatus("open", null, null, null);
  callbacks.onSnapshot(snapshot, true);
  stateCallbacks.onSnapshot(stateSnapshot(snapshot.authorityEpoch));
  await drain(handle);
  return { handle, callbacks };
}

function CommentAvailability() {
  const availability = useEpicCommentRoomAvailability();
  return (
    <output data-testid="comment-room-availability">{availability.kind}</output>
  );
}

function StatusPill() {
  const durability = useEpicDurabilityPlane();
  return (
    <>
      <EpicConnectionPill epicId={EPIC_ID} durability={durability} />
      <CommentAvailability />
    </>
  );
}

function renderStatus(handle: OpenedStoreForTest) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <RunnerHostProvider runnerHost={buildRunnerHost()}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={hostMessengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-testid="runtime-fallback">runtime loading</div>}
        >
          <EpicSessionContext.Provider value={handle}>
            <TooltipProvider>
              <StatusPill />
            </TooltipProvider>
          </EpicSessionContext.Provider>
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
}

function pill(): HTMLButtonElement {
  return screen.getByTestId("epic-connection-pill");
}

function expectNoRedDot(): void {
  expect(pill().innerHTML).not.toContain("bg-red-500");
  expect(pill().innerHTML).not.toContain("bg-destructive");
}

afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out" });
});

describe("open-session durability status in the connection pill", () => {
  it("uses the pool's captured cloud-only status through clean, dirty, and renderer-pending transitions", async () => {
    const { handle, callbacks } = await openStatusRig(
      POOL_HOST_ID,
      POOL_SNAPSHOT,
    );
    try {
      renderStatus(handle);
      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe("All changes synced");
        expect(
          screen.getByTestId("comment-room-availability").textContent,
        ).toBe("available");
      });
      expectNoRedDot();

      await act(async () => {
        callbacks.onTransition(POOL_DIRTY, true);
        await drain(handle);
      });
      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe("Saving changes");
      });
      expectNoRedDot();

      await act(async () => {
        callbacks.onTransition(POOL_CLEAN, true);
        await drain(handle);
      });
      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe("All changes synced");
      });
      expectNoRedDot();

      await act(async () => {
        handle.doc
          .getMap("epic")
          .set("title", "Renderer has an unacknowledged edit");
        await drain(handle);
      });
      expect(handle.store.getState().isDirty).toBe(true);
      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe("Saving changes");
      });
      expectNoRedDot();
    } finally {
      handle.dispose();
    }
  });

  it("keeps the computer's omitted backup leg unknown beside positive cloud durability", async () => {
    const { handle } = await openStatusRig(
      "computer-serving-epic",
      statusSnapshotForComputer(),
    );
    try {
      renderStatus(handle);
      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe(
          "New edits — backup status unknown",
        );
      });
      expectNoRedDot();
    } finally {
      handle.dispose();
    }
  });

  it("keeps an omitted negotiated pool durability leg unknown", async () => {
    const { handle } = await openStatusRig(
      POOL_HOST_ID,
      statusSnapshotWithoutDurability(),
    );
    try {
      renderStatus(handle);
      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toContain(
          "Storage status unknown",
        );
      });
      expect(pill().getAttribute("aria-label")).not.toContain(
        "All changes synced",
      );
      expect(pill().getAttribute("data-status")).toBe("connected");
      expectNoRedDot();
    } finally {
      handle.dispose();
    }
  });
});
