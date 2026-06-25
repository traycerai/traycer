import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { EpicShell } from "@/components/epic-canvas/epic-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EpicSessionProvider } from "@/providers/epic-session-provider";
import {
  __getOpenEpicRegistryForTests,
  __setEpicStreamClientFactoryForTests,
} from "@/lib/registries/epic-session-registry";

const hostClient = {
  getActiveHostId: () => "host-test",
  onChange: () => () => undefined,
  request: vi.fn(() => Promise.resolve({ tasks: [], hasMore: false })),
};

const authService = {
  revalidateCurrentContext: vi.fn(() => Promise.resolve({ kind: "valid" })),
};

vi.mock("@/lib/host", () => ({
  useHostClient: () => hostClient,
  useHostBinding: () => ({ hostClient }),
  useAuthService: () => authService,
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

vi.mock("@/hooks/epic/use-epic-title-mutation", () => ({
  useEpicUpdateTitle: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
    data: undefined,
    variables: undefined,
  }),
}));

vi.mock("@/components/epic-canvas/panels/epic-connection-pill", () => ({
  EpicConnectionPill: () => <div data-testid="epic-connection-pill" />,
}));

vi.mock("@/components/epic-canvas/panels/epic-connection-toasts", () => ({
  EpicConnectionToasts: () => null,
}));

vi.mock("@/components/epic-canvas/canvas/tile-canvas", () => ({
  TileCanvas: () => <div data-testid="tile-canvas-stub" />,
}));

interface ControlledStream {
  readonly callbacks: EpicStreamCallbacks;
  closeCount: number;
}

const EPIC_ID = "epic-shell";
const TAB_ID = "epic-shell-tab";

function buildMeta(
  title: string,
  permissionRole: PermissionRole | null,
): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight:
      permissionRole === null
        ? null
        : {
            id: EPIC_ID,
            title,
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
    permissionRole,
    repos: [
      {
        task: null,
        repoIdentifier: { owner: "traycer", repo: "cached-repo" },
        createdAt: 0,
        createdBy: "u",
      },
    ],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

function buildSnapshot(title: string): Uint8Array {
  const donor = new Y.Doc();
  const epic = donor.getMap("epic");
  epic.set("title", title);
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("chats", new Y.Map<unknown>());
  return Y.encodeStateAsUpdate(donor);
}

function installControlledFactory(): {
  readonly streams: () => ReadonlyArray<ControlledStream>;
} {
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
  return {
    streams: () => streams,
  };
}

function renderShell(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <EpicSessionProvider epicId={EPIC_ID} tabId={EPIC_ID}>
          <EpicShell epicId={EPIC_ID} tabId={TAB_ID} active />
        </EpicSessionProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("<EpicShell />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
  });

  it("renders the stable shell frame while the session is not ready", () => {
    render(<EpicShell epicId={EPIC_ID} tabId={TAB_ID} active />);

    expect(screen.getByTestId("epic-shell").dataset.sessionReady).toBe("false");
    expect(screen.getByTestId("tile-canvas-loading")).not.toBeNull();
    expect(screen.queryByTestId("epic-session-loading")).toBeNull();
  });

  it("is canvas-only: the sidebar is hoisted out of the keep-alive pane", () => {
    render(<EpicShell epicId={EPIC_ID} tabId={TAB_ID} active />);

    expect(screen.queryByTestId("epic-sidebar")).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-rail")).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-column")).toBeNull();
  });

  it("omits the duplicated epic title from the shell header once the snapshot arrives", async () => {
    const controlled = installControlledFactory();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 0,
          staleTime: 60_000,
        },
      },
    });

    renderShell(queryClient);

    controlled.streams()[0].callbacks.onConnectionStatus("open", null);
    controlled
      .streams()[0]
      .callbacks.onSnapshot(
        buildMeta("Live Epic", "editor"),
        buildSnapshot("Live Epic"),
      );

    await waitFor(() => {
      expect(screen.getByTestId("epic-connection-pill")).not.toBeNull();
    });
    expect(screen.queryByTestId("epic-shell-title")).toBeNull();
    expect(screen.queryByText("Live Epic")).toBeNull();

    queryClient.clear();
  });

  it("does not render a header title skeleton or raw epic id while the snapshot is loading", () => {
    installControlledFactory();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 0,
          staleTime: 60_000,
        },
      },
    });

    renderShell(queryClient);

    expect(screen.queryByTestId("epic-shell-title-skeleton")).toBeNull();
    expect(screen.queryByText(EPIC_ID)).toBeNull();

    queryClient.clear();
  });

  it("keeps the open-in-editor control out of the shell header", async () => {
    const controlled = installControlledFactory();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 0,
          staleTime: 60_000,
        },
      },
    });

    renderShell(queryClient);

    controlled.streams()[0].callbacks.onConnectionStatus("open", null);
    controlled
      .streams()[0]
      .callbacks.onSnapshot(
        buildMeta("Epic With Folder", "editor"),
        buildSnapshot("Epic With Folder"),
      );

    await waitFor(() => {
      expect(screen.getByTestId("epic-connection-pill")).not.toBeNull();
    });
    expect(screen.queryByTestId("epic-open-button")).toBeNull();

    queryClient.clear();
  });

  it("no longer renders an in-place access-lost banner on revoke (eject is coordinator-owned)", async () => {
    const controlled = installControlledFactory();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 0,
          staleTime: 60_000,
        },
      },
    });

    renderShell(queryClient);

    controlled.streams()[0].callbacks.onConnectionStatus("open", null);
    controlled
      .streams()[0]
      .callbacks.onSnapshot(
        buildMeta("Hidden Epic", "editor"),
        buildSnapshot("Hidden Epic"),
      );
    await waitFor(() => {
      expect(screen.getByTestId("epic-connection-pill")).not.toBeNull();
    });

    controlled.streams()[0].callbacks.onPermissionChanged(null);

    // The shell does not swap in a banner/pill on revoke anymore -
    // EpicAccessCoordinator (mounted app-level, not in this isolated test)
    // force-closes the tab instead. The body keeps rendering until then.
    await waitFor(() => {
      expect(screen.getByTestId("epic-connection-pill")).not.toBeNull();
    });
    expect(screen.queryByTestId("epic-access-lost")).toBeNull();
    expect(screen.queryByTestId("epic-access-lost-pill")).toBeNull();

    queryClient.clear();
  });
});
