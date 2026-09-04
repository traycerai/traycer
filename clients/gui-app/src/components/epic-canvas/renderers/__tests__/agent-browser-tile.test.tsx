import "../../../../../__tests__/test-browser-apis";
import type { ComponentProps, ReactElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ElectronTabSurface,
  settleMatchesLatch,
} from "@/components/browser-tile/agent-browser-tile";
import type { BrowserTilePlacement } from "@/components/browser-tile/browser-tile-placement";
import { startPersistentBrowserGuestHost } from "@/lib/browser-view/guest/persistent-browser-guest-host";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import type {
  ElectronTabBinding,
  ElectronTabSurfaceLease,
} from "@/lib/browser-view/sessions/electron-tab-directory";
import type { TileController } from "@/components/epic-canvas/renderers/tile-controller";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";
import type {
  BrowserViewViewportPresetId,
  BrowserViewTileCommand,
  BrowserViewTileCommandEvent,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";

const state = vi.hoisted(() => ({
  visible: true,
  bridge: null as TestBridge | null,
  chromeInputs: [] as Array<Record<string, unknown>>,
  sessions: null as BrowserSessionsState | null,
  onOpenLinkInNewTile:
    vi.fn<(url: string, disposition: "foreground" | "background") => void>(),
  onNativeTileFocused: vi.fn<() => void>(),
  /** Attach/detach in the order they actually happened. */
  events: [] as string[],
  closeTab: vi.fn((_sessionId: string, _tabId: string) => Promise.resolve()),
  openTab: vi.fn((sessionId: string | null, _url: string) =>
    Promise.resolve({ sessionId: sessionId ?? "session-1", tabId: "tab-2" }),
  ),
  closeCanvasTile: vi.fn(),
  focusAddress: vi.fn(),
  /** Shared across renders so a Retry click can be asserted against it. */
  navigateToUrl: vi.fn<(url: string) => void>(),
  /** The tile's latch callback, captured from the chrome hook's inputs. */
  latchAttemptedUrl: null as ((url: string) => void) | null,
  /** Every `useBrowserAnnotationSession` call, newest last. */
  annotationInputs: [] as Array<{ readonly browserView: unknown }>,
  persistViewportPreset: vi.fn<(preset: BrowserViewViewportPresetId) => void>(),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ browserView: state.bridge }),
}));
vi.mock("@/hooks/browser/use-browser-annotation-session", () => ({
  useBrowserAnnotationSession: (input: { readonly browserView: unknown }) => {
    state.annotationInputs.push(input);
    return null;
  },
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
vi.mock("@/components/browser-tile/browser-start-page", () => ({
  BrowserStartPage: () => <div>Local servers</div>,
}));
interface ChromeMockInput extends Record<string, unknown> {
  readonly onAttemptedUrl: (url: string) => void;
}
vi.mock("@/components/epic-canvas/renderers/use-electron-tile-chrome", () => ({
  useElectronTabChrome: (input: ChromeMockInput) => {
    state.chromeInputs.push(input);
    state.latchAttemptedUrl = input.onAttemptedUrl;
    return {
      controller: CHROME_CONTROLLER,
      navigateToUrl: state.navigateToUrl,
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
  private tileFocusedHandler: ((tile: BrowserViewTileKey) => void) | null =
    null;

  onTileFocused(handler: (tile: BrowserViewTileKey) => void): {
    dispose: () => void;
  } {
    this.tileFocusedHandler = handler;
    return { dispose: () => (this.tileFocusedHandler = null) };
  }

  /** This suite's canvas `PLACEMENT`, which is the tile the surface matches. */
  emitTileFocused(): void {
    this.emitTileFocusedForTile({
      viewTabId: "view-1",
      paneId: "pane-1",
      tileInstanceId: "tile-1",
      pageSessionId: "browser-session:session-1:tab-1",
    });
  }

  /**
   * The identity is an ARGUMENT here, because the surface filters every tile
   * report by its OWN key - so a helper that only ever emits this tile's
   * identity cannot show that the filter does anything.
   */
  emitTileFocusedForTile(tile: {
    readonly viewTabId: string;
    readonly paneId: string;
    readonly tileInstanceId: string;
    readonly pageSessionId: string;
  }): void {
    this.tileFocusedHandler?.(tile);
  }

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
    this.emitTileCommandForTile(
      { viewTabId: "view-1", paneId: "pane-1" },
      command,
    );
  }

  /**
   * The same chord addressed to a tile at other coordinates. The surface
   * filters every event on its own tile key, and a Start Page tile's key is
   * `{landingPageId, "landing-panel"}` rather than `{viewTabId, paneId}` - so a
   * canvas-shaped event would be discarded before any arm saw it, and a test
   * that emitted one would pass by never reaching the code it names.
   */
  emitTileCommandForTile(
    tile: { readonly viewTabId: string; readonly paneId: string },
    command: BrowserViewTileCommand,
  ): void {
    this.tileCommandHandler?.({
      viewTabId: tile.viewTabId,
      paneId: tile.paneId,
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

const PLACEMENT: BrowserTilePlacement = {
  kind: "canvas",
  epicId: "epic-1",
  viewTabId: "view-1",
  paneId: "pane-1",
};
const PAGE_SESSION_ID = "browser-session:session-1:tab-1";

const NODE = {
  instanceId: "tile-1",
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

beforeEach(() => {
  state.events = [];
  state.annotationInputs = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A binding whose attach/detach land in {@link state.events}. */
function createRecordingBinding(): ElectronTabBinding {
  return createBinding(() => {
    state.events.push("bind");
    return Promise.resolve({
      detach: () => {
        state.events.push("detach");
        return Promise.resolve();
      },
    });
  });
}

function surfaceElement(
  node: typeof NODE,
  binding: ElectronTabBinding,
): ReactElement {
  return (
    <ElectronTabSurface
      node={node}
      binding={binding}
      placement={PLACEMENT}
      visible={state.visible}
      pageSessionId={PAGE_SESSION_ID}
      onRequestClose={state.closeCanvasTile}
      persistViewportPreset={state.persistViewportPreset}
      onOpenLinkInNewTile={state.onOpenLinkInNewTile}
      onRequestNewTab={null}
      onConvertToPip={() => undefined}
      onNativeTileFocused={state.onNativeTileFocused}
    />
  );
}

function renderTile(binding: ElectronTabBinding) {
  return render(surfaceElement(NODE, binding));
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
    attachTab: () => Promise.reject(new Error("not used")),
    moveTab: () => Promise.reject(new Error("not used")),
  };
}

let stopGuestHost: (() => void) | null = null;

function mountGuestForTile(): void {
  const bridge = new FakeBrowserViewBridge();
  stopGuestHost = startPersistentBrowserGuestHost(bridge, {
    pointerDown: () => {},
    focus: () => {},
  });
  bridge.emitGuestMountRequested({
    registrationId: "registration-1",
    partition: "persist:primary",
  });
}

function queryTileGuestWrapper(): HTMLElement {
  const wrapper = document.querySelector(
    '[data-browser-guest-registration="registration-1"]',
  );
  if (!(wrapper instanceof HTMLElement)) {
    throw new Error("expected guest wrapper for registration-1");
  }
  return wrapper;
}

describe("ElectronTabSurface", () => {
  beforeEach(() => {
    state.visible = true;
    state.bridge = new TestBridge();
    state.chromeInputs = [];
    state.sessions = liveSessions();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    stopGuestHost?.();
    stopGuestHost = null;
  });

  it("attaches the accepted native incarnation before enabling tile chrome", async () => {
    mountGuestForTile();
    const detach = vi.fn(() => Promise.resolve());
    const lease: ElectronTabSurfaceLease = { detach };
    const bindSurface = vi.fn(() => Promise.resolve(lease));
    renderTile(createBinding(bindSurface));

    expect(state.chromeInputs.at(0)?.surfaceServices).toBeNull();
    expect(
      queryTileGuestWrapper().getAttribute("data-browser-guest-state"),
    ).not.toBe("presented");
    await waitFor(() => {
      expect(bindSurface).toHaveBeenCalledExactlyOnceWith({
        bindingId: "canvasview-1pane-1tile-1",
        surface: {
          viewTabId: "view-1",
          paneId: "pane-1",
          tileInstanceId: "tile-1",
          pageSessionId: "browser-session:session-1:tab-1",
        },
      });
      expect(state.chromeInputs.at(-1)?.surfaceServices).toBe(state.bridge);
    });
    const wrapper = queryTileGuestWrapper();
    expect(wrapper.getAttribute("data-browser-guest-state")).toBe("presented");
    expect(wrapper.style.pointerEvents).toBe("auto");
    expect(wrapper.inert).toBe(false);
  });

  it("shows the start page without attaching an opaque native surface", () => {
    const bindSurface = vi.fn();
    render(
      surfaceElement(
        { ...NODE, url: "about:blank" },
        createBinding(bindSurface),
      ),
    );

    expect(screen.getByText("Local servers")).toBeTruthy();
    expect(bindSurface).not.toHaveBeenCalled();
  });

  /**
   * An annotation is captured into a chat in an epic, so a placement that names
   * no epic has nowhere to put one. Pinned rather than left to the epic id
   * being empty: with a live browser view the toolbar's Annotate button is
   * enabled (`canStart` reads `browserView !== null && status === "ready"`), so
   * the reader would get a working overlay whose capture resolves no targets.
   * This is the rule the Start Page tile inherits.
   */
  it("keeps the annotation session inert under a placement with no epic", () => {
    state.bridge = new TestBridge();
    render(
      <ElectronTabSurface
        node={NODE}
        binding={createRecordingBinding()}
        placement={{ kind: "landing", landingPageId: "landing-1" }}
        visible
        pageSessionId={PAGE_SESSION_ID}
        onRequestClose={state.closeCanvasTile}
        persistViewportPreset={null}
        onOpenLinkInNewTile={state.onOpenLinkInNewTile}
        onRequestNewTab={null}
        onConvertToPip={null}
        onNativeTileFocused={null}
      />,
    );

    expect(state.annotationInputs.length).toBeGreaterThan(0);
    for (const input of state.annotationInputs) {
      expect(input.browserView).toBeNull();
    }
  });

  it("gives the annotation session a live browser view on a canvas placement", () => {
    // The other arm, so the assertion above cannot pass by the surface simply
    // never handing a browser view to anything - which is what it would do if
    // the bridge were absent rather than the epic.
    state.bridge = new TestBridge();
    render(surfaceElement(NODE, createRecordingBinding()));

    expect(state.annotationInputs.at(-1)?.browserView).not.toBeNull();
  });

  /**
   * `onTileFocused` is a browser fact only this surface hears - the desktop
   * reports it per tile, and nothing above knows which tile a report is for.
   * What it MEANS is the host's: the canvas claims its pane's activation
   * (covered in `browser-session-tile.test.tsx`), and the Start Page panel has
   * no pane to claim. So what this surface owes is the forward, and the
   * identity filter in front of it.
   */
  it("forwards native focus for its own tile to the host", () => {
    renderTile(createRecordingBinding());

    act(() => {
      state.bridge?.emitTileFocused();
    });

    expect(state.onNativeTileFocused).toHaveBeenCalledTimes(1);
  });

  it("ignores native focus reported for a different tile", () => {
    renderTile(createRecordingBinding());

    act(() => {
      state.bridge?.emitTileFocusedForTile({
        viewTabId: "view-9",
        paneId: "pane-9",
        tileInstanceId: "tile-9",
        pageSessionId: "browser-session:other-session:other-tab",
      });
    });

    expect(state.onNativeTileFocused).not.toHaveBeenCalled();
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
    view.rerender(surfaceElement(NODE, binding));
    await waitFor(() => {
      expect(detach).toHaveBeenCalledOnce();
    });
  });

  it("re-attaches when a hidden tile comes back", async () => {
    const binding = createRecordingBinding();
    const view = renderTile(binding);
    await waitFor(() => {
      expect(state.events).toEqual(["bind"]);
    });

    const show = (visible: boolean): void => {
      state.visible = visible;
      view.rerender(surfaceElement(NODE, binding));
    };

    show(false);
    await waitFor(() => {
      expect(state.events).toEqual(["bind", "detach"]);
    });

    show(true);
    await waitFor(() => {
      expect(state.events).toEqual(["bind", "detach", "bind"]);
    });
  });

  it("shows an attach failure without creating or releasing another tab", async () => {
    mountGuestForTile();
    renderTile(
      createBinding(() => Promise.reject(new Error("surface attach rejected"))),
    );

    expect(await screen.findByText("Agent browser unavailable")).toBeTruthy();
    expect(screen.getByText("surface attach rejected")).toBeTruthy();
    const wrapper = queryTileGuestWrapper();
    expect(wrapper.getAttribute("data-browser-guest-state")).toBe("retained");
    expect(wrapper.getAttribute("data-browser-guest-state")).not.toBe(
      "presented",
    );
    expect(wrapper.style.pointerEvents).toBe("none");
    expect(wrapper.inert).toBe(true);
  });

  it("forwards an in-page popup open request to onOpenLinkInNewTile untouched", async () => {
    const bridge = state.bridge;
    if (bridge === null) throw new Error("bridge missing");
    renderTile(
      createBinding(() => Promise.resolve({ detach: () => Promise.resolve() })),
    );

    act(() => {
      bridge.emitOpenTileRequest({
        viewTabId: "view-1",
        paneId: "pane-1",
        tileInstanceId: "tile-1",
        pageSessionId: "browser-session:session-1:tab-1",
        url: "https://popup.example/",
        disposition: "background",
      });
    });

    await waitFor(() => {
      expect(state.onOpenLinkInNewTile).toHaveBeenCalledExactlyOnceWith(
        "https://popup.example/",
        "background",
      );
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    stopGuestHost?.();
    stopGuestHost = null;
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

  // The Start Page shape. Its panel close is a whole sequence - host close,
  // store removal, tombstone, neighbour promotion - so a tile that ALSO sent
  // the close would issue two for one gesture, the second racing a tab the host
  // has already removed and surfacing its refusal as a toast nobody earned.
  it("asks the host surface to close on Cmd+W under a landing placement, and sends nothing itself", async () => {
    render(
      <ElectronTabSurface
        node={NODE}
        binding={createBinding(
          vi.fn(() => Promise.resolve({ detach: () => Promise.resolve() })),
        )}
        placement={{ kind: "landing", landingPageId: "landing-1" }}
        visible={state.visible}
        pageSessionId={PAGE_SESSION_ID}
        onRequestClose={state.closeCanvasTile}
        persistViewportPreset={state.persistViewportPreset}
        onOpenLinkInNewTile={state.onOpenLinkInNewTile}
        onRequestNewTab={null}
        onConvertToPip={() => undefined}
        onNativeTileFocused={null}
      />,
    );
    const bridge = state.bridge;
    expect(bridge).not.toBeNull();

    act(() =>
      bridge?.emitTileCommandForTile(
        { viewTabId: "landing-1", paneId: "landing-panel" },
        "closeTab",
      ),
    );

    await waitFor(() => {
      expect(state.closeCanvasTile).toHaveBeenCalledOnce();
    });
    // The canvas arm above still sends it; this one must not, or one Cmd+W is
    // two closes.
    expect(state.closeTab).not.toHaveBeenCalled();
  });

  it("forwards Cmd+T to onOpenLinkInNewTile as a foreground open of the default URL", () => {
    renderTile(
      createBinding(
        vi.fn(() => Promise.resolve({ detach: () => Promise.resolve() })),
      ),
    );

    act(() => state.bridge?.emitTileCommand("newTab"));

    expect(state.onOpenLinkInNewTile).toHaveBeenCalledExactlyOnceWith(
      "about:blank",
      "foreground",
    );
    expect(state.closeTab).not.toHaveBeenCalled();
  });

  it("still reaches onOpenLinkInNewTile for Cmd+T when onRequestNewTab is null, exactly as the canvas adapter passes it", () => {
    renderTile(
      createBinding(
        vi.fn(() => Promise.resolve({ detach: () => Promise.resolve() })),
      ),
    );

    act(() => state.bridge?.emitTileCommand("newTab"));

    expect(state.onOpenLinkInNewTile).toHaveBeenCalledExactlyOnceWith(
      "about:blank",
      "foreground",
    );
  });

  it("calls a non-null onRequestNewTab for Cmd+T instead of onOpenLinkInNewTile", () => {
    const onRequestNewTab = vi.fn<() => void>();
    render(
      <ElectronTabSurface
        node={NODE}
        binding={createBinding(
          vi.fn(() => Promise.resolve({ detach: () => Promise.resolve() })),
        )}
        placement={PLACEMENT}
        visible={state.visible}
        pageSessionId={PAGE_SESSION_ID}
        onRequestClose={state.closeCanvasTile}
        persistViewportPreset={state.persistViewportPreset}
        onOpenLinkInNewTile={state.onOpenLinkInNewTile}
        onRequestNewTab={onRequestNewTab}
        onConvertToPip={() => undefined}
        onNativeTileFocused={null}
      />,
    );

    act(() => state.bridge?.emitTileCommand("newTab"));

    expect(onRequestNewTab).toHaveBeenCalledOnce();
    expect(state.onOpenLinkInNewTile).not.toHaveBeenCalled();
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

/**
 * A `loading` that neither settles nor reports further progress within
 * `NAVIGATION_STALL_TIMEOUT_MS` resolves to the terminal stalled/Retry
 * surface. Each fresh `loading` status rearms the clock; a `ready`/`dead`
 * status clears the stalled state outright.
 */
describe("ElectronTabSurface navigation stall", () => {
  function loadingStatus(): NativeStatusChange {
    return {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      url: "https://example.com/",
      title: null,
      status: "loading",
      reason: null,
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100,
    };
  }

  function readyStatus(): NativeStatusChange {
    return { ...loadingStatus(), status: "ready" };
  }

  beforeEach(() => {
    state.visible = true;
    state.bridge = new TestBridge();
    state.chromeInputs = [];
    state.sessions = liveSessions();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    // Let any pending microtasks (e.g. the surface attach promise) settle
    // under fake timers before tearing the timers down.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    cleanup();
    stopGuestHost?.();
    stopGuestHost = null;
    vi.useRealTimers();
  });

  it("shows the spinner while loading, then the stalled Retry surface once the stall timeout elapses", async () => {
    renderTile(
      createBinding(() => Promise.resolve({ detach: () => Promise.resolve() })),
    );
    await act(() => Promise.resolve());

    expect(screen.getByText("Reconnecting to this session")).toBeTruthy();
    expect(screen.queryByText("This page did not load")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(screen.getByText("This page did not load")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("rearms the stall clock on every fresh loading status", async () => {
    const bridge = state.bridge;
    if (bridge === null) throw new Error("bridge missing");
    renderTile(
      createBinding(() => Promise.resolve({ detach: () => Promise.resolve() })),
    );
    await act(() => Promise.resolve());

    // 20s in, a fresh loading report arrives - this must push the deadline
    // out rather than let the original 30s window expire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    act(() => {
      bridge.emitStatus(loadingStatus());
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.queryByText("This page did not load")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText("This page did not load")).toBeTruthy();
  });

  it("clears the stalled surface once the status settles to ready", async () => {
    const bridge = state.bridge;
    if (bridge === null) throw new Error("bridge missing");
    renderTile(
      createBinding(() => Promise.resolve({ detach: () => Promise.resolve() })),
    );
    await act(() => Promise.resolve());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText("This page did not load")).toBeTruthy();

    act(() => {
      bridge.emitStatus(readyStatus());
    });

    expect(screen.queryByText("This page did not load")).toBeNull();
  });

  it("Retry re-drives navigation to the tile's node url", async () => {
    renderTile(
      createBinding(() => Promise.resolve({ detach: () => Promise.resolve() })),
    );
    await act(() => Promise.resolve());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    const retryButton = screen.getByRole("button", { name: "Retry" });

    act(() => {
      retryButton.click();
    });

    expect(state.navigateToUrl).toHaveBeenCalledExactlyOnceWith(NODE.url);
  });
});

/**
 * The honest loader's stale-settle guard must not pin `status` at `loading`
 * forever after an echo-less settle. A back/forward history nav or a session
 * reconnect re-attach settles straight to `ready` with no preceding `loading`
 * echo, so `echoSeen` never flips; a settle whose URL matches the latch is
 * that attempt completing, not a stale settle, and clears the latch.
 */
describe("ElectronTabSurface echo-less settle", () => {
  function statusChange(
    url: string,
    status: "loading" | "ready" | "dead",
  ): NativeStatusChange {
    return {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      url,
      title: null,
      status,
      reason: null,
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100,
    };
  }

  beforeEach(() => {
    state.visible = true;
    state.bridge = new TestBridge();
    state.chromeInputs = [];
    state.latchAttemptedUrl = null;
    state.sessions = liveSessions();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    cleanup();
    stopGuestHost?.();
    stopGuestHost = null;
    vi.useRealTimers();
  });

  function latch(url: string): void {
    if (state.latchAttemptedUrl === null) {
      throw new Error("latch callback missing");
    }
    state.latchAttemptedUrl(url);
  }

  // The loader panel stays mounted at `opacity-0` when hidden, so its
  // painted-ness is the overlay ancestor's opacity class, not the text's
  // presence in the DOM.
  function loaderOverlayClassName(): string {
    const banner = screen.getByText("Reconnecting to this session");
    const overlay = banner.closest('[class*="opacity-"]');
    if (!(overlay instanceof HTMLElement)) {
      throw new Error("expected loader overlay ancestor");
    }
    return overlay.className;
  }

  it("accepts an echo-less ready for the latched url and never stalls", async () => {
    const bridge = state.bridge;
    if (bridge === null) throw new Error("bridge missing");
    renderTile(
      createBinding(() => Promise.resolve({ detach: () => Promise.resolve() })),
    );
    await act(() => Promise.resolve());
    expect(loaderOverlayClassName()).toContain("opacity-100");

    // Back/forward (or reconnect) latches the destination, then the page
    // settles straight to ready with no `loading` echo.
    act(() => {
      latch("https://example.com/");
      bridge.emitStatus(statusChange("https://example.com/", "ready"));
    });

    expect(loaderOverlayClassName()).toContain("opacity-0");

    // Latch cleared: the stall clock is moot now that status is ready.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.queryByText("This page did not load")).toBeNull();
  });

  it("still drops an echo-less ready for a different url (newest submit wins)", async () => {
    const bridge = state.bridge;
    if (bridge === null) throw new Error("bridge missing");
    renderTile(
      createBinding(() => Promise.resolve({ detach: () => Promise.resolve() })),
    );
    await act(() => Promise.resolve());

    act(() => {
      latch("https://example.com/page-b");
      bridge.emitStatus(statusChange("https://other.example/", "ready"));
    });

    // Dropped as a stale pre-echo settle: overlay stays painted, latch kept.
    expect(loaderOverlayClassName()).toContain("opacity-100");
  });

  it("clears the latch on the normal echo path (loading echo then ready)", async () => {
    const bridge = state.bridge;
    if (bridge === null) throw new Error("bridge missing");
    renderTile(
      createBinding(() => Promise.resolve({ detach: () => Promise.resolve() })),
    );
    await act(() => Promise.resolve());

    act(() => {
      latch("https://example.com/page-b");
      bridge.emitStatus(statusChange("https://example.com/page-b", "loading"));
      bridge.emitStatus(statusChange("https://example.com/page-b", "ready"));
    });

    expect(loaderOverlayClassName()).toContain("opacity-0");
  });
});

describe("settleMatchesLatch", () => {
  it("matches across trailing-slash, hash and http↔https differences", () => {
    expect(
      settleMatchesLatch("https://example.com/a", "https://example.com/a/"),
    ).toBe(true);
    expect(
      settleMatchesLatch("https://example.com/a", "https://example.com/a#x"),
    ).toBe(true);
    expect(
      settleMatchesLatch("http://example.com/a", "https://example.com/a"),
    ).toBe(true);
  });

  it("distinguishes genuinely different pages", () => {
    expect(
      settleMatchesLatch("https://example.com/a", "https://other.example/a"),
    ).toBe(false);
    expect(
      settleMatchesLatch("https://example.com/a", "https://example.com/b"),
    ).toBe(false);
  });

  it("falls back to exact equality for non-http(s) urls", () => {
    expect(settleMatchesLatch("about:blank", "about:blank")).toBe(true);
    expect(settleMatchesLatch("about:blank", "about:config")).toBe(false);
  });
});
