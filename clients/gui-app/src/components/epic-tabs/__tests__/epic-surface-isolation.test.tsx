import * as Y from "yjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { isUnknownHost } from "@/lib/host/constants";
import { TestRouterProvider } from "@/__tests__/with-test-router";
import { EpicSurface } from "@/components/epic-tabs/epic-surface";
import { TabSurfaceActivityProvider } from "@/components/layout/tab-surface-activity";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  __getOpenEpicRegistryForTests,
  __setEpicStreamClientFactoryForTests,
} from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";

interface FakeStream {
  readonly callbacks: EpicStreamCallbacks;
  readonly epicId: string;
}

const hostBoundary = vi.hoisted(() => ({
  seenTileHostIds: new Set<string>(),
}));

const activeHostEntry = vi.hoisted(() => ({
  hostId: "default-host",
  label: "Default host",
  kind: "mock" as const,
  websocketUrl: "ws://default-host.test/stream",
  version: null,
  transportDialability: "dialable" as const,
}));

const activeHostClient = vi.hoisted(() => {
  const client = {
    // The remote-aware owner identity key (R-1) reads the full active entry, not
    // just its id, so the fake must answer `getActiveHost` too - with the real
    // entry, matching `resolveHostById` below rather than contradicting it.
    getActiveHost: () => activeHostEntry,
    getActiveHostId: () => "default-host",
    getRequestContext: () => null,
    getRequestContextUserId: () => null,
    onChange: () => () => undefined,
    request: () => Promise.resolve({}),
    resolveHostById: (hostId: string) =>
      hostId === activeHostEntry.hostId ? activeHostEntry : null,
    // Redesign P4.2's introduced symbol: `useAddressableHostId` resolves the
    // effective host through an id-pinned requester now that the active slot is
    // gone, so a hand-rolled client that does not answer this throws on the
    // first render that reaches the hook - here, transitively, via the sidebar
    // rail. Added under an explicit grant rather than by P4.2's own sweep so
    // this file keeps one writer; the line belongs to their class and their
    // census, and is attributed there.
    //
    // SELF-RETURNING, and only honestly so because this fixture has exactly ONE
    // host: the requester for `default-host` IS this client. A fixture with a
    // second host would have to resolve per id, and returning `this` would then
    // hand back a client addressing the wrong machine.
    createRequesterForHostId: (): unknown => null,
  };
  client.createRequesterForHostId = () => client;
  return client;
});

// ONE hoisted opener, not a fresh closure per render. This suite is the one
// that hung for over nine minutes during P2.4 — a synchronous render loop
// starves the event loop, so `--testTimeout` cannot fire and the run simply
// stops terminating — and an unstable opener is exactly the dep churn that
// feeds that shape. The mechanism was fixed at its owner (the provider's
// presentation writes are idempotent by value), so this is the fixture no
// longer contradicting the contract of the hook it doubles, not a live fix.
// Full rationale: `lib/registries/__tests__/chat-session-registry.test.ts`.
const refuseDurableTransport = vi.hoisted(() => () => {
  throw new Error("the Epic stream override must prevent socket creation");
});
const hostDirectory = vi.hoisted(() => ({
  findById: (hostId: string) =>
    hostId === activeHostEntry.hostId ? activeHostEntry : null,
  onChange: () => ({ dispose: () => undefined }),
}));

vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => refuseDurableTransport,
}));

vi.mock("@/hooks/host/use-host-stream-client-for", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-stream-client-for")
  >()),
  useHostStreamClientFor: () => null,
  useHostStreamClientBindingFor: () => null,
}));

// Spread the real module rather than enumerate the three exports this suite
// overrides: this is a whole-app render, so it reaches host hooks no one
// listed here (`useHostDirectory`, via the status row's sweep dialog). An
// enumerating factory does not leave those undefined - Vitest THROWS on the
// access, and the nearest boundary swallows it into a degraded subtree, so
// the suite fails on an unrelated assertion instead of on the missing export.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useAuthService: () => ({
      revalidateCurrentContext: () =>
        Promise.resolve({ kind: "valid" as const }),
    }),
    useHostBinding: () => ({ hostClient: activeHostClient }),
    useHostClient: () => activeHostClient,
    useHostDirectory: () => hostDirectory,
  };
});

vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    useAuthService: () => ({
      revalidateCurrentContext: () =>
        Promise.resolve({ kind: "valid" as const }),
    }),
    useHostBinding: () => ({ hostClient: activeHostClient }),
    useHostClient: () => activeHostClient,
    // An `importOriginal` spread hands back the REAL spine hook, which throws
    // outside a provider; `useHostRuntimeClient` is a separate export since
    // redesign P2.1 and must be overridden explicitly.
    useHostRuntimeClient: () => activeHostClient,
    useHostDirectory: () => hostDirectory,
  };
});

// `EpicSessionProvider` resolves its host through the selection authority's
// derived pointer (selection model §1), whose store only a mounted kernel
// bridge writes - no component test mounts one. Seed it with the same id
// `activeHostClient.getActiveHostId()` answers, so both scopes agree.
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "default-host",
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: (hostId: string) => {
    // `UNKNOWN_HOST_PLACEHOLDER` is the sentinel tab-kind-agnostic callers
    // pass to keep hook order stable across tab kinds - the real hook answers
    // "reachable" for it without consulting the directory. It names no host,
    // so recording it would put a value in `seenTileHostIds` that the
    // isolation assertion below is not about.
    if (!isUnknownHost(hostId)) {
      hostBoundary.seenTileHostIds.add(hostId);
    }
    return { status: "reachable" as const, hostLabel: hostId };
  },
  resolvedHostLabel: (r: {
    readonly status: string;
    readonly hostLabel: string;
  }) => (r.status === "checking" ? null : r.hostLabel),
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: undefined, fetchStatus: "idle" }),
}));

vi.mock("@/hooks/agent/use-terminal-tile-bootstrap", () => ({
  TerminalXtermHost: () => null,
  useTerminalTileBootstrap: () => ({
    handle: null,
    createError: null,
    createIsError: false,
    createIsSuccess: false,
    hostHasSession: false,
    hostSessionExited: false,
    reportMeasuredGrid: () => undefined,
    retry: () => undefined,
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-session-recovery", () => ({
  useTerminalSessionRecovery: () => ({
    recoverNonce: 0,
    recoveryExhausted: false,
    onManualReconnect: () => undefined,
    onSessionHealthy: () => undefined,
    onSessionLost: () => undefined,
  }),
}));

const EPIC_A = "epic-a";
const EPIC_B = "epic-b";
const TAB_A = "tab-a";
const TAB_B = "tab-b";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function snapshotMeta(epicId: string): SnapshotMetaEpic {
  const hostDoc = new Y.Doc();
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: epicId,
      title: `Epic ${epicId}`,
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "test-user",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(hostDoc)),
  };
}

function terminalRef(id: string, hostId: string) {
  return {
    id,
    instanceId: `${id}-instance`,
    type: "terminal" as const,
    name: id,
    titleSource: "manual" as const,
    hostId,
    cwd: "/workspace",
  };
}

function getSurface(tabId: string): HTMLElement {
  const surface = document.querySelector(`[data-epic-surface="${tabId}"]`);
  if (!(surface instanceof HTMLElement)) {
    throw new Error(`expected Epic surface for ${tabId}`);
  }
  return surface;
}

function getSidebarScroller(sidebar: HTMLElement): HTMLElement {
  const scroller = Array.from(sidebar.querySelectorAll("div")).find(
    (element) =>
      element instanceof HTMLElement &&
      element.classList.contains("overflow-auto"),
  );
  if (!(scroller instanceof HTMLElement)) {
    throw new Error("expected the real Epic sidebar scroll container");
  }
  return scroller;
}

function renderTwoEpicSurfaces(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TestRouterProvider>
          <TabSurfaceActivityProvider
            activity={{ visible: true, focused: true }}
          >
            <EpicSurface epicId={EPIC_A} tabId={TAB_A} />
          </TabSurfaceActivityProvider>
          <TabSurfaceActivityProvider
            activity={{ visible: true, focused: false }}
          >
            <EpicSurface epicId={EPIC_B} tabId={TAB_B} />
          </TabSurfaceActivityProvider>
        </TestRouterProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("<EpicSurface /> split isolation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    hostBoundary.seenTileHostIds.clear();
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "test-user" },
      [],
    );
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLeftPanelStore.setState(useLeftPanelStore.getInitialState(), true);
    useEpicCanvasStore.getState().openEpicTabWithId(TAB_A, EPIC_A, "Epic A");
    useEpicCanvasStore.getState().openEpicTabWithId(TAB_B, EPIC_B, "Epic B");
    useEpicCanvasStore
      .getState()
      .openTileInTab(TAB_A, terminalRef("terminal-a", "tile-host-a"));
    useEpicCanvasStore
      .getState()
      .openTileInTab(TAB_B, terminalRef("terminal-b", "tile-host-b"));
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLeftPanelStore.setState(useLeftPanelStore.getInitialState(), true);
    useAuthStore.getState().setSignedOut();
  });

  it("keeps two live Epic bodies isolated across sessions, sidebars, canvases, hosts, and scrolling", async () => {
    const streams: FakeStream[] = [];
    __setEpicStreamClientFactoryForTests((epicId, callbacks) => {
      streams.push({ epicId, callbacks });
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => undefined,
      };
    });

    renderTwoEpicSurfaces();

    await waitFor(() => {
      expect(streams.map((stream) => stream.epicId).sort()).toEqual([
        EPIC_A,
        EPIC_B,
      ]);
    });

    act(() => {
      streams.forEach((stream) => {
        stream.callbacks.onConnectionStatus("open", null);
        stream.callbacks.onSnapshot(
          snapshotMeta(stream.epicId),
          Y.encodeStateAsUpdate(new Y.Doc()),
        );
      });
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("tile-canvas")).toHaveLength(2);
      expect(hostBoundary.seenTileHostIds).toEqual(
        new Set(["tile-host-a", "tile-host-b"]),
      );
    });

    const firstHandle = __getOpenEpicRegistryForTests().get(EPIC_A);
    const secondHandle = __getOpenEpicRegistryForTests().get(EPIC_B);
    if (firstHandle === null || secondHandle === null) {
      throw new Error("expected both Epic sessions to be live");
    }
    expect(firstHandle).not.toBe(secondHandle);
    expect(firstHandle.store).not.toBe(secondHandle.store);

    act(() => {
      firstHandle.store.getState().setEpicTitle("Only Epic A changed");
      useEpicCanvasStore
        .getState()
        .openTileInTab(TAB_A, terminalRef("terminal-a-second", "tile-host-a"));
    });

    expect(firstHandle.store.getState().epic.title).toBe("Only Epic A changed");
    expect(secondHandle.store.getState().epic.title).toBe("");
    expect(
      useEpicCanvasStore.getState().canvasByTabId[TAB_A]?.tilesByInstanceId[
        "terminal-a-second-instance"
      ],
    ).toBeDefined();
    expect(
      useEpicCanvasStore.getState().canvasByTabId[TAB_B]?.tilesByInstanceId[
        "terminal-a-second-instance"
      ],
    ).toBeUndefined();

    const surfaceA = getSurface(TAB_A);
    const surfaceB = getSurface(TAB_B);
    const sidebarA = within(surfaceA).getByTestId("epic-sidebar-column");
    const sidebarB = within(surfaceB).getByTestId("epic-sidebar-column");
    const canvasA = within(surfaceA).getByTestId("tile-canvas");
    const canvasB = within(surfaceB).getByTestId("tile-canvas");
    expect(sidebarA.dataset.epicId).toBe(EPIC_A);
    expect(sidebarB.dataset.epicId).toBe(EPIC_B);
    expect(sidebarA).not.toBe(sidebarB);
    expect(canvasA).not.toBe(canvasB);

    const sidebarScrollerA = getSidebarScroller(sidebarA);
    const sidebarScrollerB = getSidebarScroller(sidebarB);
    sidebarScrollerA.scrollTop = 91;
    sidebarScrollerB.scrollTop = 27;
    expect(sidebarScrollerA).not.toBe(sidebarScrollerB);
    expect(sidebarScrollerA.scrollTop).toBe(91);
    expect(sidebarScrollerB.scrollTop).toBe(27);
  });
});
