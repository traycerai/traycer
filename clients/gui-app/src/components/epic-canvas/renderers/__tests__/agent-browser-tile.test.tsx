import "../../../../../__tests__/test-browser-apis";
import type { ComponentProps } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElectronTabSurface } from "@/components/epic-canvas/renderers/agent-browser-tile";
import type {
  ElectronTabBinding,
  ElectronTabSurfaceLease,
} from "@/lib/browser-view/sessions/electron-tabs";
import type { TileController } from "@/components/epic-canvas/renderers/tile-controller";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import type {
  BrowserViewTileCommand,
  BrowserViewTileCommandEvent,
} from "@traycer-clients/shared/platform/browser-view";

const state = vi.hoisted(() => ({
  visible: true,
  bridge: null as TestBridge | null,
  chromeInputs: [] as Array<Record<string, unknown>>,
  sessions: null as BrowserSessionsState | null,
  openTile: vi.fn<(intent: TileOpenIntent) => void>(),
  closeTab: vi.fn((_sessionId: string, _tabId: string) => Promise.resolve()),
  openTab: vi.fn((sessionId: string | null, _url: string) =>
    Promise.resolve({ sessionId: sessionId ?? "session-1", tabId: "tab-2" }),
  ),
  closeCanvasTile: vi.fn(),
  focusAddress: vi.fn(),
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));
vi.mock("@/components/epic-canvas/hooks/use-tile-body-visible", () => ({
  useTileBodyVisible: () => state.visible,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ browserView: state.bridge }),
}));
vi.mock(
  "@/components/epic-canvas/renderers/use-browser-view-bounds-bridge",
  () => ({
    useBrowserViewBoundsBridge: () => undefined,
  }),
);
vi.mock("@/components/epic-canvas/renderers/use-browser-view-snapshot", () => ({
  useBrowserViewSnapshot: () => null,
}));
vi.mock("@/hooks/browser/use-browser-annotation-session", () => ({
  useBrowserAnnotationSession: () => null,
}));
vi.mock("@/lib/browser-view/tiles/visible-tile-registry", async (load) => {
  const actual =
    await load<
      typeof import("@/lib/browser-view/tiles/visible-tile-registry")
    >();
  return { ...actual, useRegisterVisibleBrowserTile: () => undefined };
});
vi.mock("@/components/epic-canvas/renderers/browser-sessions-context", () => ({
  useMaybeBrowserSessionsContext: () => state.sessions,
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: state.openTile }),
}));
vi.mock("@/components/epic-canvas/renderers/browser-start-page", () => ({
  BrowserStartPage: () => <div>Local servers</div>,
}));
vi.mock(
  "@/components/epic-canvas/renderers/use-close-canvas-tile-with-nested-focus",
  () => ({
    useCloseCanvasTileWithNestedFocus: () => state.closeCanvasTile,
  }),
);
const canvasState = vi.hoisted(() => ({
  tabsById: {} as Record<string, unknown>,
  updateBrowserTileViewportPresetInTab: vi.fn(),
}));
// `getState` too, not just the hook: the popup path reads the live tab set at
// open time to see whether its own view tab is still there.
vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: Object.assign(
    (selector: (value: Record<string, unknown>) => unknown) =>
      selector(canvasState),
    { getState: () => canvasState },
  ),
}));
vi.mock("@/components/epic-canvas/renderers/use-electron-tile-chrome", () => ({
  useElectronTabChrome: (input: Record<string, unknown>) => {
    state.chromeInputs.push(input);
    return {
      controller: CHROME_CONTROLLER,
      navigateToUrl: vi.fn(),
      viewportPreset: "responsive",
      downloads: [],
      cancelDownload: vi.fn(),
      certificateError: null,
      certificateProceeding: false,
      proceedCertificate: vi.fn(),
    };
  },
}));

const CHROME_CONTROLLER: TileController = {
  capabilities: {
    navigate: false,
    back: false,
    forward: false,
    reload: false,
    zoom: false,
    viewportPreset: false,
    devtools: false,
    find: false,
    siteInfo: false,
    annotate: false,
  },
  profile: "primary",
  url: "https://example.com/",
  addressValue: "https://example.com/",
  setAddressInput: () => undefined,
  focusAddress: state.focusAddress,
  canGoBack: false,
  canGoForward: false,
  zoomPercent: 100,
  viewportPreset: "responsive",
  disabled: false,
  zoomLocked: false,
  annotation: null,
  onNavigate: () => undefined,
  onAddressChange: () => undefined,
  onAddressFocusChange: () => undefined,
  onBack: () => undefined,
  onForward: () => undefined,
  onReload: () => undefined,
  onZoomOut: () => undefined,
  onZoomIn: () => undefined,
  onResetZoom: () => undefined,
  onViewportPresetChange: () => undefined,
  onOpenDevTools: () => undefined,
  onClearSite: () => undefined,
};

interface OpenTileRequest {
  readonly viewTabId: string;
  readonly paneId: string;
  readonly tileInstanceId: string;
  readonly pageSessionId: string;
  readonly url: string;
  readonly disposition: "foreground" | "background";
}

interface NativeStatusChange {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly url: string;
  readonly title: string | null;
  readonly status: "loading" | "ready" | "dead";
  readonly reason: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly zoomPercent: number;
}

class TestBridge {
  private statusHandler: ((change: NativeStatusChange) => void) | null = null;

  onNativeTabStatusChange(handler: (change: NativeStatusChange) => void): {
    dispose: () => void;
  } {
    this.statusHandler = handler;
    return { dispose: () => (this.statusHandler = null) };
  }

  private openTileHandler: ((change: OpenTileRequest) => void) | null = null;

  onOpenTileRequest(handler: (change: OpenTileRequest) => void): {
    dispose: () => void;
  } {
    this.openTileHandler = handler;
    return { dispose: () => (this.openTileHandler = null) };
  }

  emitOpenTileRequest(change: OpenTileRequest): void {
    this.openTileHandler?.(change);
  }

  private tileCommandHandler:
    | ((event: BrowserViewTileCommandEvent) => void)
    | null = null;

  onTileCommand(handler: (event: BrowserViewTileCommandEvent) => void): {
    dispose: () => void;
  } {
    this.tileCommandHandler = handler;
    return { dispose: () => (this.tileCommandHandler = null) };
  }

  /** A browser-scoped chord main claimed from the focused guest page. */
  emitTileCommand(command: BrowserViewTileCommand): void {
    this.tileCommandHandler?.({
      viewTabId: "view-1",
      paneId: "pane-1",
      tileInstanceId: "tile-1",
      pageSessionId: "browser-session:session-1:tab-1",
      command,
    });
  }

  onFindChange(): { dispose: () => void } {
    return { dispose: () => {} };
  }

  emitStatus(change: NativeStatusChange): void {
    this.statusHandler?.(change);
  }
}

const NODE = {
  id: "browser-session:session-1:tab-1",
  instanceId: "tile-1",
  name: "Example",
  hostId: "host-1",
  sessionId: "session-1",
  url: "https://example.com/",
  viewportPreset: "responsive",
} satisfies ComponentProps<typeof ElectronTabSurface>["node"];

function createBinding(
  bindSurface: ElectronTabBinding["bindSurface"],
): ElectronTabBinding {
  return {
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    registrationId: "registration-1",
    control: vi.fn(() => Promise.resolve()),
    bindSurface,
  };
}

function renderTile(binding: ElectronTabBinding) {
  return render(
    <ElectronTabSurface
      node={NODE}
      binding={binding}
      viewTabId="view-1"
      paneId="pane-1"
    />,
  );
}

function liveSessions(): BrowserSessionsState {
  return {
    hostId: "host-1",
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: true,
    items: [],
    errorMessage: null,
    retry: () => {},
    openTab: state.openTab,
    closeTab: state.closeTab,
  };
}

function popupRequest(
  disposition: "foreground" | "background",
): OpenTileRequest {
  return {
    viewTabId: "view-1",
    paneId: "pane-1",
    tileInstanceId: "tile-1",
    pageSessionId: "browser-session:session-1:tab-1",
    url: "https://popup.example/",
    disposition,
  };
}

describe("ElectronTabSurface", () => {
  beforeEach(() => {
    state.visible = true;
    state.bridge = new TestBridge();
    state.chromeInputs = [];
    state.sessions = liveSessions();
    canvasState.tabsById = { "view-1": { epicId: "epic-1" } };
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("attaches the accepted native incarnation before enabling tile chrome", async () => {
    const detach = vi.fn(() => Promise.resolve());
    const lease: ElectronTabSurfaceLease = { detach };
    const bindSurface = vi.fn(() => Promise.resolve(lease));
    renderTile(createBinding(bindSurface));

    expect(state.chromeInputs.at(0)?.surfaceServices).toBeNull();
    await waitFor(() => {
      expect(bindSurface).toHaveBeenCalledExactlyOnceWith({
        bindingId: "canvas\u001fview-1\u001fpane-1\u001ftile-1",
        surface: {
          viewTabId: "view-1",
          paneId: "pane-1",
          tileInstanceId: "tile-1",
          pageSessionId: "browser-session:session-1:tab-1",
        },
      });
      expect(state.chromeInputs.at(-1)?.surfaceServices).toBe(state.bridge);
    });
  });

  it("shows the start page without attaching an opaque native surface", () => {
    const bindSurface = vi.fn();
    render(
      <ElectronTabSurface
        node={{ ...NODE, url: "about:blank" }}
        binding={createBinding(bindSurface)}
        viewTabId="view-1"
        paneId="pane-1"
      />,
    );

    expect(screen.getByText("Local servers")).toBeTruthy();
    expect(bindSurface).not.toHaveBeenCalled();
  });

  it("detaches the native surface when the tile becomes hidden", async () => {
    const detach = vi.fn(() => Promise.resolve());
    const lease: ElectronTabSurfaceLease = { detach };
    const bindSurface = vi.fn(() => Promise.resolve(lease));
    const binding = createBinding(bindSurface);
    const view = renderTile(binding);
    await waitFor(() => {
      expect(bindSurface).toHaveBeenCalledOnce();
    });

    state.visible = false;
    view.rerender(
      <ElectronTabSurface
        node={NODE}
        binding={binding}
        viewTabId="view-1"
        paneId="pane-1"
      />,
    );
    await waitFor(() => {
      expect(detach).toHaveBeenCalledOnce();
    });
  });

  it("shows an attach failure without creating or releasing another tab", async () => {
    renderTile(
      createBinding(() => Promise.reject(new Error("surface attach rejected"))),
    );

    expect(await screen.findByText("Agent browser unavailable")).toBeTruthy();
    expect(screen.getByText("surface attach rejected")).toBeTruthy();
  });

  it("opens an in-page popup as a tab of this pane, foreground focusing it", async () => {
    const bridge = state.bridge;
    if (bridge === null) throw new Error("bridge missing");
    state.sessions = liveSessions();
    renderTile(
      createBinding(() => Promise.resolve({ detach: () => Promise.resolve() })),
    );

    act(() => {
      bridge.emitOpenTileRequest(popupRequest("foreground"));
    });

    await waitFor(() => {
      expect(state.openTile).toHaveBeenCalledTimes(1);
    });
    expect(state.openTile.mock.calls[0]?.[0]).toMatchObject({
      target: { tabId: "view-1" },
      gesture: "explicit",
      modifiers: null,
      placement: { kind: "tab", paneId: "pane-1", index: null },
      dedupe: true,
      node: { type: "browser-session", sessionId: "session-1", tabId: "tab-2" },
    });
  });

  it("falls back to the epic when the view tab closed mid-open", async () => {
    const bridge = state.bridge;
    if (bridge === null) throw new Error("bridge missing");
    state.sessions = liveSessions();
    renderTile(
      createBinding(() => Promise.resolve({ detach: () => Promise.resolve() })),
    );

    // The tab goes away while `openTab` is in flight; targeting it would put
    // a tile in a canvas with no route (R8).
    canvasState.tabsById = {};

    act(() => {
      bridge.emitOpenTileRequest(popupRequest("foreground"));
    });

    await waitFor(() => {
      expect(state.openTile).toHaveBeenCalledTimes(1);
    });
    expect(state.openTile.mock.calls[0]?.[0].target).toEqual({
      epicId: "epic-1",
    });
  });

  it("opens a background popup as a host push, leaving the current tab active", async () => {
    const bridge = state.bridge;
    if (bridge === null) throw new Error("bridge missing");
    state.sessions = liveSessions();
    renderTile(
      createBinding(() => Promise.resolve({ detach: () => Promise.resolve() })),
    );

    act(() => {
      bridge.emitOpenTileRequest(popupRequest("background"));
    });

    await waitFor(() => {
      expect(state.openTile).toHaveBeenCalledTimes(1);
    });
    expect(state.openTile.mock.calls[0]?.[0]).toMatchObject({
      gesture: "host",
      placement: { kind: "tab", paneId: "pane-1", index: null },
    });
  });

  it("accepts status only for the exact host, session, and tab", async () => {
    const bridge = state.bridge;
    if (bridge === null) throw new Error("bridge missing");
    renderTile(
      createBinding(() =>
        Promise.resolve({
          update: () => Promise.resolve(),
          detach: () => Promise.resolve(),
        }),
      ),
    );
    await waitFor(() => {
      expect(state.chromeInputs.at(-1)?.surfaceServices).toBe(bridge);
    });

    act(() => {
      bridge.emitStatus({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "foreign-tab",
        url: "https://foreign.example/",
        title: null,
        status: "dead",
        reason: "foreign failure",
        canGoBack: false,
        canGoForward: false,
        zoomPercent: 100,
      });
    });
    expect(screen.queryByText("foreign failure")).toBeNull();

    act(() => {
      bridge.emitStatus({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        url: "https://example.com/",
        title: null,
        status: "dead",
        reason: "native guest crashed",
        canGoBack: false,
        canGoForward: false,
        zoomPercent: 100,
      });
    });
    expect(screen.getByText("native guest crashed")).toBeTruthy();
  });
});

/**
 * Browser-scoped reserved chords. Main claims these from the focused guest and
 * names the command; the app renderer's own keybindings are NOT involved -
 * that half is pinned in `browser-view-chords.test.ts`, which proves a
 * browser-scoped chord is never replayed as a keystroke.
 */
describe("ElectronTabSurface browser-scoped chords", () => {
  beforeEach(() => {
    state.visible = true;
    state.bridge = new TestBridge();
    state.chromeInputs = [];
    state.sessions = liveSessions();
    canvasState.tabsById = { "view-1": { epicId: "epic-1" } };
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("closes THIS tile's browser tab on Cmd+W, then retires the tile", async () => {
    renderTile(
      createBinding(
        vi.fn(() => Promise.resolve({ detach: () => Promise.resolve() })),
      ),
    );
    const bridge = state.bridge;
    expect(bridge).not.toBeNull();

    act(() => bridge?.emitTileCommand("closeTab"));

    expect(state.closeTab).toHaveBeenCalledExactlyOnceWith(
      "session-1",
      "tab-1",
    );
    await waitFor(() => {
      expect(state.closeCanvasTile).toHaveBeenCalledOnce();
    });
  });

  it("opens a new tab in the same session on Cmd+T", () => {
    renderTile(
      createBinding(
        vi.fn(() => Promise.resolve({ detach: () => Promise.resolve() })),
      ),
    );

    act(() => state.bridge?.emitTileCommand("newTab"));

    expect(state.openTab).toHaveBeenCalledOnce();
    expect(state.openTab.mock.calls.at(0)?.at(0)).toBe("session-1");
    expect(state.closeTab).not.toHaveBeenCalled();
  });

  it("asks the address field for the caret on Cmd+L", () => {
    renderTile(
      createBinding(
        vi.fn(() => Promise.resolve({ detach: () => Promise.resolve() })),
      ),
    );

    act(() => state.bridge?.emitTileCommand("focusAddressBar"));

    // What `focusAddress` actually does to the DOM is pinned in
    // `use-address-draft.test.ts`, which owns the field.
    expect(state.focusAddress).toHaveBeenCalledOnce();
  });
});
