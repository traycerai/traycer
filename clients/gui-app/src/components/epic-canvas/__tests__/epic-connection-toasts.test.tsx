import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { NO_CLOUD_SYNC_DURABILITY } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { EpicConnectionToasts } from "@/components/epic-canvas/panels/epic-connection-toasts";
import { EpicSessionProvider } from "@/providers/epic-session-provider";
import { EpicSessionGate } from "@/providers/epic-session-gate";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  __setEpicRuntimeWorkerFactoryForTests,
  getEpicRuntimeWorkerFactoryOverride,
} from "@/lib/registries/epic-runtime-worker-factory-slot";
import { createInProcessEpicRuntimeWorker } from "@/stores/epics/open-epic/test-support/in-process-epic-runtime-worker";
import type { RuntimeWorkerLike } from "@/stores/epics/open-epic/runtime/worker/spawn-epic-runtime-worker";

const routerState = vi.hoisted(() => ({
  isActiveTab: true,
}));

const sonner = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useRouterState: () => routerState.isActiveTab,
}));

vi.mock("sonner", () => ({
  toast: {
    info: sonner.info,
    success: sonner.success,
    warning: sonner.warning,
  },
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

// `EpicSessionProvider` opens its own durable transport via this factory, and
// UNCONDITIONALLY now: the stream-factory override that used to short-circuit
// before `openTransport` ran is gone, so a stub that threw here - which was
// this file's shape, safe only because it was never reached - would now fail
// every test. The fake supplies "no socket in tests" at the opener instead.
// What this suite drives the session's stream with is the WORKER factory.
vi.mock("@/lib/host/use-durable-stream-transport", async () => {
  const { fakeDurableStreamTransports } =
    await import("@/lib/host/test-support/fake-durable-stream-transport");
  return {
    useDurableStreamTransportFactory: () =>
      fakeDurableStreamTransports().opener,
  };
});

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-test",
}));

// The Epic session resolves its host through the selection authority's derived
// pointer (selection model §1), not the active-host projection above - seed the
// decider at its own name (the P1.2 convention in epic-shell-usage-entry-point).
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-test",
}));

interface ControlledStream {
  readonly callbacks: EpicStreamCallbacks;
  closeCount: number;
}

const EPIC_ID = "epic-role-toast";

function buildMeta(role: PermissionRole | null): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight:
      role === null
        ? null
        : {
            id: EPIC_ID,
            title: "Epic Role Toast",
            initialUserPrompt: "",
            ticketCount: 0,
            specCount: 0,
            storyCount: 0,
            reviewCount: 0,
            status: "open",
            createdAt: 0,
            updatedAt: 0,
            createdBy: "u",
            version: "1",
          },
    permissionRole: role,
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

function emptySnapshot(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

/**
 * What was installed before this suite's worker, so `afterEach` can put it
 * back. NEVER `null`: the jsdom setup file installs a coreless worker for every
 * suite, and `null` means "use the production constructor" - the one form
 * (`new Worker(new URL(...))`) jsdom cannot execute.
 */
let previousWorkerFactory: (() => RuntimeWorkerLike) | null = null;

/**
 * The suite's stream, one seam over.
 *
 * The factory itself is unchanged - the same callbacks, the same `closeCount`.
 * What changed is where it is installed: a stream factory built on MAIN cannot
 * cross `postMessage` to a runtime that lives in the worker, so it is supplied
 * to the worker's own composition instead, through the shared in-process helper
 * `openStoreForTest` also uses.
 */
function installControlledFactory(): ReadonlyArray<ControlledStream> {
  const streams: ControlledStream[] = [];
  previousWorkerFactory = getEpicRuntimeWorkerFactoryOverride();
  // A FRESH helper per spawn. One instance owns one bridge pair and one
  // composition, so a shared one would hand two sessions the same runtime -
  // and would hand a re-acquired session a pipe its predecessor's
  // `terminate()` already severed. Constructing per call is also what the
  // deleted stream override did: the provider called it once per session.
  __setEpicRuntimeWorkerFactoryForTests(() =>
    createInProcessEpicRuntimeWorker({
      streamClientFactory: (_epicId, callbacks) => {
        const stream: ControlledStream = {
          callbacks,
          closeCount: 0,
        };
        streams.push(stream);
        return {
          applyUpdate: () => undefined,
          awareness: () => undefined,
          applyArtifactRoomUpdate: () => undefined,
          artifactRoomAwareness: () => undefined,
          retryMigration: () => undefined,
          close: () => {
            stream.closeCount += 1;
          },
        };
      },
      laneSelection: null,
    }).createWorker(),
  );
  return streams;
}

function renderToasts() {
  return render(
    <EpicSessionProvider epicId={EPIC_ID} tabId={EPIC_ID}>
      <EpicSessionGate fallback={null}>
        <EpicConnectionToasts epicId={EPIC_ID} />
      </EpicSessionGate>
    </EpicSessionProvider>,
  );
}

function getHandle() {
  const handle = __getOpenEpicRegistryForTests().get(EPIC_ID);
  if (handle === null) {
    throw new Error("expected epic session handle");
  }
  return handle;
}

describe("<EpicConnectionToasts />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __getOpenEpicRegistryForTests().disposeAll();
    routerState.isActiveTab = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    // RESTORED, not nulled - see `previousWorkerFactory`.
    __setEpicRuntimeWorkerFactoryForTests(previousWorkerFactory);
    vi.useRealTimers();
  });

  it("fires a neutral info toast for owner to editor transitions", async () => {
    const streams = installControlledFactory();
    renderToasts();

    act(() => {
      streams[0].callbacks.onSnapshot(buildMeta("owner"), emptySnapshot());
    });

    const handle = getHandle();
    await waitFor(() => {
      expect(handle.store.getState().permissionRole).toBe("owner");
    });

    act(() => {
      handle.store.setState({ permissionRole: "editor" });
    });

    await waitFor(() => {
      expect(sonner.info).toHaveBeenCalledWith(
        "Your role on this Epic is now Editor.",
        { id: "epic-role:epic-role-toast", cancel: null },
      );
    });
    expect(sonner.warning).not.toHaveBeenCalled();
  });

  it("preserves the viewer downgrade warning and fresh-snapshot rebind", async () => {
    const streams = installControlledFactory();
    renderToasts();

    act(() => {
      streams[0].callbacks.onSnapshot(buildMeta("owner"), emptySnapshot());
    });

    const handle = getHandle();
    await waitFor(() => {
      expect(handle.store.getState().permissionRole).toBe("owner");
    });

    // The replica REPLACEMENT is observed through `bindingVersion`, not by
    // comparing `Y.Doc` references: the doc lives on the worker thread now and
    // main has no reference to compare. `bindingVersion` IS the binding epoch
    // the runtime advances when it swaps a replica, and it is what production
    // consumers remount on - so this asserts the same event through the
    // channel that still carries it.
    const originalBinding = handle.store.getState().bindingVersion;

    // A real local edit, through the root-state port. `applyLocalUpdate` is
    // gone; `applyRootUpdate(update, /* asLocalEdit */ true)` is the member
    // that puts local bytes into the replica, and it needs real update bytes
    // rather than a placeholder because it actually applies them.
    const donor = new Y.Doc();
    donor.getMap("epic").set("unsynced", "edit");
    await act(async () => {
      await handle.applyRootUpdate(Y.encodeStateAsUpdate(donor), true);
    });
    donor.destroy();
    expect(handle.store.getState().unsyncedQueueSize).toBe(1);

    act(() => {
      streams[0].callbacks.onPermissionChanged("viewer");
    });

    await waitFor(() => {
      expect(sonner.warning).toHaveBeenCalledWith(
        "Your role on this Epic is now Viewer. Pending edits were discarded.",
        { id: "epic-role:epic-role-toast", cancel: null },
      );
    });
    expect(handle.store.getState().unsyncedQueueSize).toBe(0);
    expect(handle.store.getState().bindingVersion).not.toBe(originalBinding);
    expect(streams).toHaveLength(2);
    expect(streams[0].closeCount).toBe(1);
  });

  it("does not toast sustained disconnect and reconnect cycles", async () => {
    const streams = installControlledFactory();
    renderToasts();

    act(() => {
      streams[0].callbacks.onSnapshot(buildMeta("owner"), emptySnapshot());
    });

    const handle = getHandle();
    await waitFor(() => {
      expect(handle.store.getState().permissionRole).toBe("owner");
    });

    // Establish the connection so the drop below is a genuine reconnect, not
    // first-time bootstrap (which reads as "connecting" and fires no toast).
    // Transport open + cloud caught up is what latches "connected once".
    act(() => {
      streams[0].callbacks.onConnectionStatus("open", null, true);
      streams[0].callbacks.onCloudSyncStatus(
        "connected",
        NO_CLOUD_SYNC_DURABILITY,
      );
    });

    act(() => {
      streams[0].callbacks.onConnectionStatus("reconnecting", null, true);
    });

    act(() => {
      streams[0].callbacks.onConnectionStatus("open", null, true);
    });

    expect(sonner.warning).not.toHaveBeenCalled();
    expect(sonner.success).not.toHaveBeenCalled();
  });
});
