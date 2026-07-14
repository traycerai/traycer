import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { EpicConnectionToasts } from "@/components/epic-canvas/panels/epic-connection-toasts";
import { EpicSessionProvider } from "@/providers/epic-session-provider";
import { EpicSessionGate } from "@/providers/epic-session-gate";
import {
  __getOpenEpicRegistryForTests,
  __setEpicStreamClientFactoryForTests,
} from "@/lib/registries/epic-session-registry";

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

// `EpicSessionProvider` opens its own durable transport via this factory, but
// the test installs an `__setEpicStreamClientFactoryForTests` override that
// short-circuits before `openTransport` runs - so a stable stub opener that is
// never invoked lets the provider mount without the full host runtime.
const openTransportStub = vi.hoisted(() => () => {
  throw new Error("openTransport must not be called in this test");
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => openTransportStub,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-test",
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

function installControlledFactory(): ReadonlyArray<ControlledStream> {
  const streams: ControlledStream[] = [];
  __setEpicStreamClientFactoryForTests((_epicId, callbacks) => {
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
  });
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
    __setEpicStreamClientFactoryForTests(null);
    routerState.isActiveTab = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
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

    const originalDoc = handle.doc;
    act(() => {
      handle.store.getState().applyLocalUpdate(new Uint8Array([1]));
    });
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
    expect(handle.doc).not.toBe(originalDoc);
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
      streams[0].callbacks.onConnectionStatus("open", null);
      streams[0].callbacks.onCloudSyncStatus("connected");
    });

    act(() => {
      streams[0].callbacks.onConnectionStatus("reconnecting", null);
    });

    act(() => {
      streams[0].callbacks.onConnectionStatus("open", null);
    });

    expect(sonner.warning).not.toHaveBeenCalled();
    expect(sonner.success).not.toHaveBeenCalled();
  });
});
