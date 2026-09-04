import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import {
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import { BrowserSessionTile } from "@/components/epic-canvas/renderers/browser-session-tile";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import type { BrowserPeekCompleteMeaning } from "@/components/browser-tile/browser-peek-tile";
import type { ElectronTabBinding } from "@/lib/browser-view/sessions/electron-tab-directory";
import type {
  BrowserTileNode,
  BrowserTilePlacement,
} from "@/components/browser-tile/browser-tile-placement";
import type { BrowserSessionTileRef } from "@/stores/epics/canvas/types";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import { registerHostedPaneActivationClaim } from "@/components/epic-canvas/pane-activation";

const harness = vi.hoisted(() => ({
  binding: null as ElectronTabBinding | null,
  items: [] as BrowserSessionInfo[],
  lifecycle: "live",
  inventoryReady: true,
  // Defaults to the Electron-capable client these cases were written for: a
  // desktop co-located with the tile's host. A viewer-only client sets it
  // false, and then never reaches the native or rebind branches at all.
  canMaterializeElectron: true,
  closeCanvasTile: vi.fn(),
  // Fixed resolution, independent of the sessionId it is called with: the
  // relocated open-link tests (below) assert on this literal return value,
  // ported unchanged from `agent-browser-tile.test.tsx`'s own openTab
  // fixture - only the CALL argument differs per file (this suite's NODE
  // uses "sess-1"), never the resolved tab.
  openTab: vi.fn((_sessionId: string | null, _url: string) =>
    Promise.resolve({ sessionId: "session-1", tabId: "tab-2" }),
  ),
  closeTab: vi.fn(),
  attachTab: vi.fn(() => {
    harness.frameOrder.push("attachTab");
    return Promise.resolve();
  }),
  moveTab: vi.fn(() => Promise.resolve()),
  /**
   * Which frame each seam issued, in issue order, across the sessions stream
   * (`attachTab`) and the screencast stream (the peek tile's subscribe). The
   * body's window hint has to be issued BEFORE the wake, because the host
   * rejects an attach for a tab already bound elsewhere and never relocates
   * it - so a wake that lands first elects the default route permanently.
   */
  frameOrder: [] as string[],
}));

/**
 * This renderer's desktop window id, as `BrowserTabTile` reads it via
 * `useDesktopWindowId()`. Mocked at the module rather than routed through a
 * real `<RunnerHostProvider>`, since this suite never stands one up.
 */
const desktopWindowIdHarness = vi.hoisted(() => ({
  windowId: "window-a" as string | null,
}));

/**
 * The relocated open-link routing tests (moved from
 * `agent-browser-tile.test.tsx`) drive `BrowserSessionTile`'s
 * `onOpenLinkInNewTile` callback, which reads the canvas tab set and the
 * epic tile-navigation hook directly - both mocked here the same way that
 * suite mocked them before the move.
 */
const canvasState = vi.hoisted(() => ({
  tabsById: {} as Record<string, unknown>,
  openTile: vi.fn<(intent: TileOpenIntent) => void>(),
  updateBrowserTileViewportPresetInTab:
    vi.fn<
      (viewTabId: string, tileInstanceId: string, preset: string) => void
    >(),
}));

/** Props `ElectronTabSurface` was actually handed on its latest render. */
const surfaceCapture = vi.hoisted(() => ({
  onOpenLinkInNewTile: null as
    | ((url: string, disposition: "foreground" | "background") => void)
    | null,
  onRequestClose: null as (() => void) | null,
  onConvertToPip: null as (() => void) | null,
  onNativeTileFocused: null as (() => void) | null,
  persistViewportPreset: null as ((preset: string) => void) | null,
  visible: null as boolean | null,
  placement: null as BrowserTilePlacement | null,
  node: null as BrowserTileNode | null,
  pageSessionId: null as string | null,
}));

/**
 * Cross-host fence bookkeeping (ticket 13): who each seam was actually
 * called for, so a test can prove the tile bound to the TILE's own
 * `node.hostId` rather than the canvas host.
 */
const hostBindingHarness = vi.hoisted(() => ({
  reachabilityHostIds: [] as string[],
  electronBindingCalls: [] as Array<{
    readonly sessionId: string;
    readonly tabId: string;
    readonly hostId: string;
  }>,
}));

type ReachabilityStatus =
  | "checking"
  | "reachable"
  | "unreachable"
  | "host-starting";

const reachabilityHarness = vi.hoisted(() => ({
  status: "reachable" as ReachabilityStatus,
  hostLabel: "host-test",
}));

const peekFrameHarness = vi.hoisted(() => ({
  frame: null as { readonly src: string; readonly sequence: number } | null,
}));

// `BrowserTabTile` (the shared body) reads `useBrowserSessionsContext`;
// `BrowserSessionTile` (the canvas adapter, under test here) reads
// `useMaybeBrowserSessionsContext` for its relocated open-tab flow. Both
// names have to resolve from this one factory or the suite dies at import
// time - and both must share `harness.openTab`/`harness.closeTab` so a test
// can assert on the same call the adapter actually made.
function sessionsContextValue() {
  return {
    hostId: "host-test",
    lifecycle: harness.lifecycle,
    inventoryReady: harness.inventoryReady,
    canMaterializeElectron: harness.canMaterializeElectron,
    items: harness.items,
    errorMessage: null,
    retry: vi.fn(),
    openTab: harness.openTab,
    closeTab: harness.closeTab,
    // This literal is untyped (no `BrowserSessionsState` annotation), so a
    // missing `attachTab` member is invisible to the type-check - only a
    // render of `BrowserTabTile` (which destructures `sessions.attachTab`)
    // would ever have caught its absence. `moveTab` is added by hand for the
    // same reason ("Show here").
    attachTab: harness.attachTab,
    moveTab: harness.moveTab,
  };
}
const toastHarness = vi.hoisted(() => ({
  error: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    error: toastHarness.error,
  },
}));
vi.mock("@/components/epic-canvas/renderers/browser-sessions-context", () => ({
  useBrowserSessionsContext: () => sessionsContextValue(),
  useMaybeBrowserSessionsContext: () => sessionsContextValue(),
}));
// Both exports, for the reason the sibling `use-runner-host` mock in
// `tile-render-browser-link-host.test.tsx` documents: a factory REPLACES the
// module, so the first importer to reach a missing export fails at module
// init rather than at an assertion. Nothing in this graph reads
// `readDesktopWindowId` today; naming it costs a line and removes the trap.
vi.mock("@/lib/windows/desktop-window-id", () => ({
  useDesktopWindowId: () => desktopWindowIdHarness.windowId,
  readDesktopWindowId: () => desktopWindowIdHarness.windowId,
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: canvasState.openTile }),
}));
vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: Object.assign(
    (selector: (value: Record<string, unknown>) => unknown) =>
      selector(canvasState),
    { getState: () => canvasState },
  ),
}));
vi.mock("@/lib/browser-view/sessions/electron-tab-directory", () => ({
  useElectronTabBindingOnHost: (
    sessionId: string,
    tabId: string,
    hostId: string,
  ) => {
    hostBindingHarness.electronBindingCalls.push({ sessionId, tabId, hostId });
    return harness.binding;
  },
}));
vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => "host-test",
}));
vi.mock(
  "@/components/epic-canvas/renderers/use-close-canvas-tile-with-nested-focus",
  () => ({
    useCloseCanvasTileWithNestedFocus: () => harness.closeCanvasTile,
  }),
);
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/components/browser-tile/agent-browser-tile", () => ({
  ElectronTabSurface: (props: {
    readonly binding: ElectronTabBinding;
    readonly pageSessionId: string;
    readonly visible: boolean;
    readonly placement: BrowserTilePlacement;
    readonly node: BrowserTileNode;
    readonly onRequestClose: () => void;
    readonly onConvertToPip: (() => void) | null;
    readonly onNativeTileFocused: (() => void) | null;
    readonly persistViewportPreset: ((preset: string) => void) | null;
    readonly onOpenLinkInNewTile:
      | ((url: string, disposition: "foreground" | "background") => void)
      | null;
  }) => {
    surfaceCapture.onOpenLinkInNewTile = props.onOpenLinkInNewTile;
    surfaceCapture.onRequestClose = props.onRequestClose;
    surfaceCapture.onConvertToPip = props.onConvertToPip;
    surfaceCapture.onNativeTileFocused = props.onNativeTileFocused;
    surfaceCapture.persistViewportPreset = props.persistViewportPreset;
    surfaceCapture.visible = props.visible;
    surfaceCapture.placement = props.placement;
    surfaceCapture.node = props.node;
    surfaceCapture.pageSessionId = props.pageSessionId;
    return (
      <div
        data-testid="managed-electron-tab"
        data-node-id={props.pageSessionId}
        data-registration={props.binding.registrationId}
      />
    );
  },
}));
// The stand-in subscribes in a PASSIVE effect, exactly as the real peek tile
// does through `useScreencastSession` - that subscription is the host-side
// wake, so a stand-in that subscribes to nothing cannot witness whether the
// window hint was issued before it. `visible` gates it the same way the real
// hook's effect does, so a conceal/reveal cycle re-subscribes here too.
vi.mock("@/components/browser-tile/browser-peek-tile", async () => {
  const { useEffect } = await import("react");
  return {
    BrowserPeekTile: (props: {
      readonly node: { readonly sessionId: string; readonly tabId: string };
      readonly completeMeans: BrowserPeekCompleteMeaning;
      readonly visible: boolean;
    }) => {
      const visible = props.visible;
      useEffect(() => {
        if (!visible) return;
        harness.frameOrder.push("screencastSubscribe");
      }, [visible]);
      return (
        <button
          type="button"
          aria-label="Browser screencast controls"
          data-testid="headless-browser-tab"
          data-session={props.node.sessionId}
          data-tab={props.node.tabId}
          data-complete-means={props.completeMeans}
        />
      );
    },
  };
});
vi.mock("@/lib/browser-view/sessions/peek-frame-cache", () => ({
  useLastBrowserPeekFrame: () => peekFrameHarness.frame,
  clearLastBrowserPeekFrame: vi.fn(),
  browserPeekFrameKey: (node: {
    readonly hostId: string;
    readonly sessionId: string;
    readonly tabId: string;
    readonly instanceId: string;
  }) => `${node.hostId}:${node.sessionId}:${node.tabId}:${node.instanceId}`,
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: (hostId: string) => {
    hostBindingHarness.reachabilityHostIds.push(hostId);
    return {
      status: reachabilityHarness.status,
      hostLabel: reachabilityHarness.hostLabel,
      unavailability:
        reachabilityHarness.status === "unreachable" ? "offline" : null,
      basis: "directory",
    };
  },
}));

const NODE: BrowserSessionTileRef = {
  id: "browser-session:sess-1:tab-1",
  instanceId: "pointer-instance-1",
  type: "browser-session",
  name: "Browser",
  hostId: "host-test",
  sessionId: "sess-1",
  tabId: "tab-1",
  viewportPreset: "responsive",
};

function session(
  status: "ready" | "dormant" | "navigating" | "crashed",
  runtime: "headless" | "electron" | "dormant",
): BrowserSessionInfo {
  return sessionInfo({
    sessionId: "sess-1",
    hostId: "host-test",
    lastActivityAt: 2,
    runtime: { kind: runtime, revision: 1 },
    tabs: [
      tabInfo({
        tabId: "tab-1",
        url: "https://example.com/page",
        status,
        title: "Example",
      }),
    ],
  });
}

/**
 * A ready Electron session whose tab records the desktop window route holding
 * its binding - the fact the multi-window branch reads.
 *
 * A separate builder rather than a third parameter on `session()` with a
 * default: defaulted parameters are banned repo-wide (the type-safety table in
 * the root AGENTS.md), and threading a required one would touch all 35 of this
 * suite's existing `session(...)` call sites for two tests' worth of state.
 */
function sessionBoundTo(boundWindowId: string | null): BrowserSessionInfo {
  const base = session("ready", "electron");
  return {
    ...base,
    tabs: base.tabs.map((tab) => ({ ...tab, boundWindowId })),
  };
}

function binding(): ElectronTabBinding {
  return {
    hostId: "host-test",
    sessionId: "sess-1",
    tabId: "tab-1",
    registrationId: "native-registration-1",
    control: vi.fn(async () => {}),
    bindSurface: vi.fn(),
  };
}

function tileElement(paneId: string): ReactElement {
  return (
    <BrowserSessionTile
      node={NODE}
      viewTabId="view-1"
      paneId={paneId}
      epicId="epic-1"
    />
  );
}

function renderTile(): void {
  render(tileElement("pane-1"));
}

describe("BrowserSessionTile lifecycle projection", () => {
  beforeEach(() => {
    surfaceCapture.onNativeTileFocused = null;
    harness.binding = null;
    harness.items = [session("dormant", "dormant")];
    harness.lifecycle = "live";
    harness.inventoryReady = true;
    harness.canMaterializeElectron = true;
    harness.closeCanvasTile.mockClear();
    harness.openTab.mockClear();
    harness.closeTab.mockClear();
    harness.attachTab.mockClear();
    harness.moveTab.mockReset();
    harness.moveTab.mockImplementation(() => Promise.resolve());
    toastHarness.error.mockClear();
    harness.frameOrder.length = 0;
    desktopWindowIdHarness.windowId = "window-a";
    reachabilityHarness.status = "reachable";
    reachabilityHarness.hostLabel = "host-test";
    peekFrameHarness.frame = null;
    hostBindingHarness.reachabilityHostIds = [];
    hostBindingHarness.electronBindingCalls = [];
    canvasState.tabsById = { "view-1": { epicId: "epic-1" } };
    canvasState.openTile.mockClear();
    surfaceCapture.onOpenLinkInNewTile = null;
    surfaceCapture.onRequestClose = null;
    surfaceCapture.onConvertToPip = null;
    surfaceCapture.persistViewportPreset = null;
    surfaceCapture.visible = null;
    surfaceCapture.placement = null;
    surfaceCapture.node = null;
    surfaceCapture.pageSessionId = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("renders an accepted native binding without copying registration into canvas identity", () => {
    harness.binding = binding();
    harness.items = [session("ready", "electron")];

    renderTile();

    const managed = screen.getByTestId("managed-electron-tab");
    expect(managed.dataset.nodeId).toBe(NODE.id);
    expect(managed.dataset.registration).toBe("native-registration-1");
  });

  it("renders the headless projection when the host says headless", () => {
    harness.items = [session("ready", "headless")];

    renderTile();

    expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
      "tab-1",
    );
    // A plain headless viewer: the host's `complete` frame is an ordinary
    // dead cast here, never a native handoff or an unreachable native tab.
    expect(
      screen.getByTestId("headless-browser-tab").dataset.completeMeans,
    ).toBe("ended");
    expect(screen.queryByTestId("managed-electron-tab")).toBeNull();
  });

  it("opens the headless projection so a dormant tab can activate", () => {
    harness.items = [session("dormant", "dormant")];

    renderTile();

    expect(screen.queryByTestId("managed-electron-tab")).toBeNull();
    expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
      "tab-1",
    );
    expect(
      screen.getByTestId("headless-browser-tab").dataset.completeMeans,
    ).toBe("ended");
  });

  it("closes a pointer only after a previously visible tab disappears from live state", async () => {
    harness.binding = binding();
    harness.items = [session("ready", "electron")];
    const view = render(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );
    harness.items = [];
    view.rerender(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    await waitFor(() => {
      expect(harness.closeCanvasTile).toHaveBeenCalledTimes(1);
    });
  });

  it("closes a cold-start orphan after the authoritative snapshot arrives", async () => {
    harness.items = [];

    renderTile();

    await waitFor(() => {
      expect(harness.closeCanvasTile).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps a pointer while the authoritative inventory is still loading", () => {
    harness.items = [];
    harness.inventoryReady = false;

    renderTile();

    expect(harness.closeCanvasTile).not.toHaveBeenCalled();
    expect(screen.getByText("Loading browser session…")).toBeTruthy();
    expect(
      screen.queryByText("Browser tab is no longer available."),
    ).toBeNull();
  });

  it("does not start a headless projection while an Electron binding is reconnecting", () => {
    harness.items = [session("ready", "electron")];

    renderTile();

    expect(screen.getByText("Reconnecting browser tab…")).toBeTruthy();
    expect(screen.queryByTestId("headless-browser-tab")).toBeNull();
  });

  it("takes the viewer branch for a non-capable client on a ready electron session, never the rebind alert", () => {
    // A viewer-only client (no co-located browserView, or a browserView bound
    // to a different host than the session's) can never place a native tab
    // for this session. `kind === "electron"` + `binding === null` alone would
    // fall into `BrowserTabRebindWait`, which waits on a desktop-side
    // re-publish that structurally cannot come for this client.
    harness.canMaterializeElectron = false;
    harness.items = [session("ready", "electron")];

    renderTile();

    expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
      "tab-1",
    );
    // The non-capable client's own view of the same `complete` frame: this
    // tab is live in the desktop's window on that host, unreachable from
    // here - never the "my own tab is arriving" handoff spinner.
    expect(
      screen.getByTestId("headless-browser-tab").dataset.completeMeans,
    ).toBe("native-elsewhere");
    expect(screen.queryByText("Reconnecting browser tab…")).toBeNull();
    expect(screen.queryByTestId("browser-tab-rebind-timeout")).toBeNull();
    expect(screen.queryByTestId("managed-electron-tab")).toBeNull();
  });

  it("takes the viewer branch for a non-capable client even once the reconnect wait would have expired", () => {
    // Same non-capable client, but proving the bounded-wait/rebind-timeout
    // machinery never engages at all for it - not merely that it starts in the
    // viewer branch. An electron-capable client (default harness) reaches the
    // timeout alert at this point (see "bounds the reconnect wait..." above);
    // this client must not.
    vi.useFakeTimers();
    try {
      harness.canMaterializeElectron = false;
      harness.items = [session("ready", "electron")];

      renderTile();

      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
        "tab-1",
      );
      expect(
        screen.getByTestId("headless-browser-tab").dataset.completeMeans,
      ).toBe("native-elsewhere");
      expect(screen.queryByTestId("browser-tab-rebind-timeout")).toBeNull();
      expect(screen.queryByText("Reconnecting browser tab…")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the electron-capable default meaningful: the same session still reaches the reconnect wait and rebind alert", () => {
    // Pins that the harness's `canMaterializeElectron: true` default (used by
    // every other case in this suite) is not accidentally masking the branch
    // this file exists to cover - the capable path still resolves to the
    // native-binding-reconnect machinery, not the viewer branch.
    harness.items = [session("ready", "electron")];

    renderTile();

    expect(screen.getByText("Reconnecting browser tab…")).toBeTruthy();
    expect(screen.queryByTestId("headless-browser-tab")).toBeNull();
  });

  it("takes the wake path for a dormant tab of an Electron session", () => {
    // `materialize` provisions only the tab it was asked for, so a live
    // Electron session routinely publishes dormant siblings. A sibling that
    // fell into the bare null-binding branch had no way back: the reconnect
    // spinner subscribes to nothing, and the screencast subscription behind
    // the peek tile is the only thing that reaches `ensureTabAttached`.
    harness.items = [session("dormant", "electron")];

    renderTile();

    expect(
      screen.getByRole("button", { name: "Browser screencast controls" })
        .dataset.tab,
    ).toBe("tab-1");
    // The capable client's own wake/peek path: the desktop is about to
    // publish a native binding for this tab, so the frame reads as a
    // handoff in progress, not an unreachable native tab.
    expect(
      screen.getByRole("button", { name: "Browser screencast controls" })
        .dataset.completeMeans,
    ).toBe("native-handoff");
    expect(
      screen.queryByRole("status", { name: "Reconnecting browser tab" }),
    ).toBeNull();
  });

  it("prefers an accepted binding over the wake path even while the tab still reads dormant", () => {
    // The renderer publishes the binding before the host's `electronTabState`
    // lands, so this window is ordinary. Native pixels win it.
    harness.binding = binding();
    harness.items = [session("dormant", "electron")];

    renderTile();

    expect(screen.getByTestId("managed-electron-tab")).toBeTruthy();
    expect(screen.queryByTestId("headless-browser-tab")).toBeNull();
  });

  it("bounds the reconnect wait and offers the wake path once it expires", () => {
    vi.useFakeTimers();
    try {
      harness.items = [session("ready", "electron")];

      renderTile();

      expect(screen.getByText("Reconnecting browser tab…")).toBeTruthy();
      expect(screen.queryByTestId("browser-tab-rebind-timeout")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(screen.queryByText("Reconnecting browser tab…")).toBeNull();
      const timedOut = screen.getByTestId("browser-tab-rebind-timeout");
      expect(timedOut.getAttribute("role")).toBe("alert");

      fireEvent.click(screen.getByRole("button", { name: "Reopen tab" }));

      expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
        "tab-1",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns to the actionable error state once the bounded wake window itself expires with no binding", () => {
    // The wake request is bounded, not latched: a reader who clicked "Reopen
    // tab" and never got a binding back must land on the same actionable
    // error state the original reconnect wait offers, not spin on the peek
    // tile forever.
    vi.useFakeTimers();
    try {
      harness.items = [session("ready", "electron")];

      renderTile();

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      fireEvent.click(screen.getByRole("button", { name: "Reopen tab" }));
      expect(screen.getByTestId("headless-browser-tab")).toBeTruthy();

      // The bounded wake window's own deadline, still with no binding.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(screen.queryByTestId("headless-browser-tab")).toBeNull();
      // Falls straight to the error state - no intervening reconnect spinner.
      expect(screen.queryByText("Reconnecting browser tab…")).toBeNull();
      const timedOut = screen.getByTestId("browser-tab-rebind-timeout");
      expect(timedOut.getAttribute("role")).toBe("alert");
      expect(screen.getByRole("button", { name: "Reopen tab" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a binding arrive mid-wake-window, then falls back to the actionable alert (not a phantom headless tab) once a stale wake request has naturally expired", () => {
    vi.useFakeTimers();
    try {
      harness.items = [session("ready", "electron")];

      const view = render(
        <BrowserSessionTile
          node={NODE}
          viewTabId="view-1"
          paneId="pane-1"
          epicId="epic-1"
        />,
      );

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      fireEvent.click(screen.getByRole("button", { name: "Reopen tab" }));
      expect(screen.getByTestId("headless-browser-tab")).toBeTruthy();

      // A binding arrives before the wake window expires - native pixels win.
      harness.binding = binding();
      view.rerender(
        <BrowserSessionTile
          node={NODE}
          viewTabId="view-1"
          paneId="pane-1"
          epicId="epic-1"
        />,
      );
      expect(screen.getByTestId("managed-electron-tab")).toBeTruthy();

      // A later, transient reconnect: the binding drops again well after the
      // original wake window would have elapsed. The stale request is inert
      // by then, so this lands on the same actionable alert a fresh expiry
      // produces - never stuck spinning, and never a phantom headless tab.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      harness.binding = null;
      view.rerender(
        <BrowserSessionTile
          node={NODE}
          viewTabId="view-1"
          paneId="pane-1"
          epicId="epic-1"
        />,
      );

      expect(screen.queryByText("Reconnecting browser tab…")).toBeNull();
      expect(screen.queryByTestId("headless-browser-tab")).toBeNull();
      const timedOut = screen.getByTestId("browser-tab-rebind-timeout");
      expect(timedOut.getAttribute("role")).toBe("alert");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a dormant placeholder for an unreachable host and never closes the tile", async () => {
    harness.items = [session("ready", "headless")];
    reachabilityHarness.status = "unreachable";
    reachabilityHarness.hostLabel = "mac-mini";

    renderTile();

    expect(
      screen.getByTestId("browser-session-dormant-placeholder"),
    ).toBeTruthy();
    expect(screen.getByText("mac-mini")).toBeTruthy();
    expect(screen.queryByTestId("headless-browser-tab")).toBeNull();
    // Give any stray effect a tick to fire before asserting the negative.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.closeCanvasTile).not.toHaveBeenCalled();
  });

  it("re-renders live once reachability recovers", () => {
    harness.items = [session("ready", "headless")];
    reachabilityHarness.status = "unreachable";
    const view = render(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    expect(
      screen.getByTestId("browser-session-dormant-placeholder"),
    ).toBeTruthy();

    reachabilityHarness.status = "reachable";
    view.rerender(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    expect(
      screen.queryByTestId("browser-session-dormant-placeholder"),
    ).toBeNull();
    expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
      "tab-1",
    );
  });

  it("shows a dismissible runtime-demotion note when a session flips electron to headless", () => {
    harness.binding = binding();
    harness.items = [session("ready", "electron")];
    const view = render(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );
    expect(screen.queryByTestId("browser-runtime-demotion-note")).toBeNull();

    harness.items = [
      {
        ...session("ready", "headless"),
        runtime: { kind: "headless", revision: 2 },
      },
    ];
    view.rerender(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    const note = screen.getByTestId("browser-runtime-demotion-note");
    expect(note.textContent).toContain("Continuing streamed from host-test");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("browser-runtime-demotion-note")).toBeNull();
  });

  it("keeps the placeholder's greyed frame stable across a re-render even if the cache changes underneath it", () => {
    harness.items = [session("ready", "headless")];
    reachabilityHarness.status = "unreachable";
    peekFrameHarness.frame = {
      src: "data:image/jpeg;base64,seed",
      sequence: 1,
    };

    const view = render(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    const img = screen
      .getByTestId("browser-session-dormant-placeholder")
      .querySelector("img");
    expect(img?.getAttribute("src")).toBe("data:image/jpeg;base64,seed");

    // The peek tile's own cache can change (or empty out) underneath an
    // already-mounted placeholder - it must not re-read it.
    peekFrameHarness.frame = null;
    view.rerender(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    const imgAfter = screen
      .getByTestId("browser-session-dormant-placeholder")
      .querySelector("img");
    expect(imgAfter?.getAttribute("src")).toBe("data:image/jpeg;base64,seed");
  });

  it("clears the runtime-demotion note once the session is re-promoted back to electron", () => {
    harness.binding = binding();
    harness.items = [session("ready", "electron")];
    const view = render(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    harness.items = [
      {
        ...session("ready", "headless"),
        runtime: { kind: "headless", revision: 2 },
      },
    ];
    view.rerender(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );
    expect(screen.getByTestId("browser-runtime-demotion-note")).toBeTruthy();

    harness.binding = binding();
    harness.items = [
      {
        ...session("ready", "electron"),
        runtime: { kind: "electron", revision: 3 },
      },
    ];
    view.rerender(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    expect(screen.queryByTestId("browser-runtime-demotion-note")).toBeNull();
  });

  it("binds the boundary, reachability, and the electron binding lookup to the tile's OWN hostId, not the canvas host", () => {
    // The canvas host (`useCanvasHostId`, mocked above) is always
    // "host-test". This node names a different host - the first case in
    // this suite where a browser tile's hostId diverges from the canvas
    // it's rendered on. Every per-host seam the tile touches must key off
    // `node.hostId`, never the canvas host it happens to be pinned inside.
    const remoteNode: BrowserSessionTileRef = {
      ...NODE,
      hostId: "host-remote",
    };
    harness.items = [
      { ...session("ready", "headless"), hostId: "host-remote" },
    ];

    render(
      <BrowserSessionTile
        node={remoteNode}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
      "tab-1",
    );
    expect(hostBindingHarness.reachabilityHostIds).toContain("host-remote");
    expect(hostBindingHarness.reachabilityHostIds).not.toContain("host-test");
    expect(hostBindingHarness.electronBindingCalls).toContainEqual({
      sessionId: "sess-1",
      tabId: "tab-1",
      hostId: "host-remote",
    });
  });

  it("fires attachTab once on activation for a capable, visible client with no binding", () => {
    harness.items = [session("ready", "electron")];

    renderTile();

    expect(harness.attachTab).toHaveBeenCalledTimes(1);
    expect(harness.attachTab).toHaveBeenCalledWith("tab-1");
  });

  it("fires attachTab again on Reopen tab, on top of the activation send", () => {
    vi.useFakeTimers();
    try {
      harness.items = [session("ready", "electron")];

      renderTile();
      expect(harness.attachTab).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      fireEvent.click(screen.getByRole("button", { name: "Reopen tab" }));

      expect(harness.attachTab).toHaveBeenCalledTimes(2);
      expect(harness.attachTab).toHaveBeenNthCalledWith(1, "tab-1");
      expect(harness.attachTab).toHaveBeenNthCalledWith(2, "tab-1");
      // The screencast wake path itself is unchanged by this send: the peek
      // branch still renders, which is what actually re-attaches the tab.
      expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
        "tab-1",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("never fires attachTab on the viewer path, even past the reconnect deadline", () => {
    vi.useFakeTimers();
    try {
      harness.canMaterializeElectron = false;
      harness.items = [session("ready", "electron")];

      renderTile();
      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(harness.attachTab).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("issues the window hint before the screencast wake on the mount path", () => {
    // The activation this ticket exists for: a dormant tab, in a window that
    // is not the scope's default route. The surface takes the peek branch, so
    // both frames go out on the same commit - and the order decides the
    // outcome, because the host answers an attach for a tab already bound
    // elsewhere with a rejection and never relocates it. Wake first means the
    // host elects the default route and the hint arrives too late to matter.
    harness.items = [session("dormant", "electron")];

    renderTile();

    expect(harness.frameOrder).toEqual(["attachTab", "screencastSubscribe"]);
  });

  it("issues the window hint before the screencast wake on the reveal path", () => {
    harness.items = [session("dormant", "electron")];

    const view = render(
      <TabBodySelectedContext.Provider value={false}>
        <BrowserSessionTile
          node={NODE}
          viewTabId="view-1"
          paneId="pane-1"
          epicId="epic-1"
        />
      </TabBodySelectedContext.Provider>,
    );

    expect(harness.frameOrder).toEqual([]);

    view.rerender(
      <TabBodySelectedContext.Provider value>
        <BrowserSessionTile
          node={NODE}
          viewTabId="view-1"
          paneId="pane-1"
          epicId="epic-1"
        />
      </TabBodySelectedContext.Provider>,
    );

    expect(harness.frameOrder).toEqual(["attachTab", "screencastSubscribe"]);
  });

  it("sends attachTab once under StrictMode's setup, cleanup, setup", () => {
    // The only place the latch is load-bearing, and it is every dev launch:
    // the desktop renderer entry wraps the app in `<StrictMode>`, which runs
    // each effect twice on mount. Without the ref the tile asks the host
    // twice for one activation.
    harness.items = [session("ready", "electron")];

    render(
      <StrictMode>
        <BrowserSessionTile
          node={NODE}
          viewTabId="view-1"
          paneId="pane-1"
          epicId="epic-1"
        />
      </StrictMode>,
    );

    expect(harness.attachTab).toHaveBeenCalledTimes(1);
  });

  it("does not fire attachTab for a live headless session", () => {
    // `canMaterializeElectron` is a property of the CLIENT - a desktop
    // co-located with the tile's host - so every local agent-driven headless
    // browser tile satisfies the other terms: no native binding is ever
    // published for a headless session. Asking there would put a pending
    // attach and its timer behind every reveal of every Playwright tile, for
    // a case the send does not exist for.
    harness.items = [session("ready", "headless")];

    renderTile();

    expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
      "tab-1",
    );
    expect(harness.attachTab).not.toHaveBeenCalled();
  });

  it("still fires attachTab for a dormant tab of a headless session", () => {
    // The narrowing above is keyed to LIVE headless: a dormant tab is one of
    // the two cases the send exists for, whatever its session's runtime says.
    harness.items = [session("dormant", "headless")];

    renderTile();

    expect(harness.attachTab).toHaveBeenCalledTimes(1);
    expect(harness.attachTab).toHaveBeenCalledWith("tab-1");
  });

  it("does not fire attachTab when a native binding is already present", () => {
    harness.binding = binding();
    harness.items = [session("ready", "electron")];

    renderTile();

    expect(harness.attachTab).not.toHaveBeenCalled();
  });

  it("does not fire attachTab for a mounted but concealed body, then fires when it is revealed", () => {
    // The ask is "attach this tab on MY route", so it is keyed to the body
    // being ON SCREEN, not merely mounted. Canvas tabs are keep-alive: every
    // unselected browser tile in the window stays mounted with
    // `display:none`, and without the visibility term each one would ask the
    // host to route its tab here on every reconnect - which is the
    // wrong-window behavior this whole ticket exists to remove.
    harness.items = [session("ready", "electron")];

    const view = render(
      <TabBodySelectedContext.Provider value={false}>
        <BrowserSessionTile
          node={NODE}
          viewTabId="view-1"
          paneId="pane-1"
          epicId="epic-1"
        />
      </TabBodySelectedContext.Provider>,
    );

    expect(harness.attachTab).not.toHaveBeenCalled();

    // Revealing the same mounted body is the activation edge.
    view.rerender(
      <TabBodySelectedContext.Provider value>
        <BrowserSessionTile
          node={NODE}
          viewTabId="view-1"
          paneId="pane-1"
          epicId="epic-1"
        />
      </TabBodySelectedContext.Provider>,
    );

    expect(harness.attachTab).toHaveBeenCalledTimes(1);
    expect(harness.attachTab).toHaveBeenCalledWith("tab-1");
  });

  it("sends attachTab only once per activation when the ack rejects", async () => {
    harness.attachTab.mockImplementationOnce(() =>
      Promise.reject(new Error("attach rejected")),
    );
    harness.items = [session("ready", "electron")];

    const view = render(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(harness.attachTab).toHaveBeenCalledTimes(1);

    view.rerender(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    expect(harness.attachTab).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Reconnecting browser tab…")).toBeTruthy();
  });

  it("sends attachTab only once per activation when the ack never settles", () => {
    vi.useFakeTimers();
    try {
      harness.attachTab.mockImplementationOnce(() => new Promise(() => {}));
      harness.items = [session("ready", "electron")];

      renderTile();
      expect(harness.attachTab).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(harness.attachTab).toHaveBeenCalledTimes(1);
      const timedOut = screen.getByTestId("browser-tab-rebind-timeout");
      expect(timedOut.getAttribute("role")).toBe("alert");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the other-window copy when the tab is bound to a different desktop window", () => {
    harness.items = [sessionBoundTo("window-b")];

    renderTile();

    const note = screen.getByTestId("browser-tab-other-window");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toBe("Open in your other window");
  });

  it("takes the ordinary reconnect wait when boundWindowId names THIS window", () => {
    harness.items = [sessionBoundTo("window-a")];

    renderTile();

    expect(screen.getByText("Reconnecting browser tab…")).toBeTruthy();
    expect(screen.queryByTestId("browser-tab-other-window")).toBeNull();
  });

  it("takes the ordinary reconnect wait when boundWindowId is null", () => {
    harness.items = [sessionBoundTo(null)];

    renderTile();

    expect(screen.getByText("Reconnecting browser tab…")).toBeTruthy();
    expect(screen.queryByTestId("browser-tab-other-window")).toBeNull();
  });

  it("keeps the other-window copy up past the reconnect deadline, pre-empting the rebind alert", () => {
    vi.useFakeTimers();
    try {
      harness.items = [sessionBoundTo("window-b")];

      renderTile();
      expect(screen.getByTestId("browser-tab-other-window")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(screen.getByTestId("browser-tab-other-window")).toBeTruthy();
      expect(screen.queryByTestId("browser-tab-rebind-timeout")).toBeNull();
      expect(screen.queryByText("Reconnecting browser tab…")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never shows the other-window copy on the viewer path", () => {
    harness.canMaterializeElectron = false;
    harness.items = [sessionBoundTo("window-b")];

    renderTile();

    expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
      "tab-1",
    );
    expect(screen.queryByTestId("browser-tab-other-window")).toBeNull();
  });

  /**
   * The native `disabled` property, not `toBeDisabled()`: jest-dom's matchers
   * are not wired into this suite.
   */
  function isDisabled(element: HTMLElement): boolean {
    return element instanceof HTMLButtonElement && element.disabled;
  }

  it("renders the Show here button only when the tab is bound to another window", () => {
    harness.items = [sessionBoundTo("window-b")];
    renderTile();
    expect(screen.getByRole("button", { name: "Show here" })).toBeTruthy();
    cleanup();

    harness.items = [sessionBoundTo("window-a")];
    renderTile();
    expect(screen.queryByRole("button", { name: "Show here" })).toBeNull();
    cleanup();

    harness.items = [sessionBoundTo(null)];
    renderTile();
    expect(screen.queryByRole("button", { name: "Show here" })).toBeNull();
    cleanup();

    harness.canMaterializeElectron = false;
    harness.items = [sessionBoundTo("window-b")];
    renderTile();
    expect(screen.queryByRole("button", { name: "Show here" })).toBeNull();
  });

  it("sends exactly one moveTab on a Show here click", () => {
    harness.items = [sessionBoundTo("window-b")];
    renderTile();

    fireEvent.click(screen.getByRole("button", { name: "Show here" }));

    expect(harness.moveTab).toHaveBeenCalledTimes(1);
    expect(harness.moveTab).toHaveBeenCalledWith("tab-1");
  });

  it("disables the button and shows a spinner, with the copy unchanged, while the move is unresolved", async () => {
    let releaseMove: () => void = () => undefined;
    harness.moveTab.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseMove = resolve;
        }),
    );
    harness.items = [sessionBoundTo("window-b")];
    renderTile();

    fireEvent.click(screen.getByRole("button", { name: "Show here" }));

    // The pending-UX rule: `disabled` plus an inline spinner, and NEVER a
    // swapped label or swapped copy. The note still states where the tab is,
    // because that has not stopped being true while the move is in flight.
    const spinner = await screen.findByTestId("browser-tab-show-here-spinner");
    expect(spinner).toBeTruthy();
    expect(isDisabled(screen.getByRole("button", { name: "Show here" }))).toBe(
      true,
    );
    expect(screen.getByTestId("browser-tab-other-window").textContent).toBe(
      "Open in your other window",
    );

    releaseMove();
  });

  it("re-enables the button when a move resolves without a binding arriving", async () => {
    let releaseMove: () => void = () => undefined;
    harness.moveTab.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseMove = resolve;
        }),
    );
    harness.items = [sessionBoundTo("window-b")];
    renderTile();

    fireEvent.click(screen.getByRole("button", { name: "Show here" }));
    // Pinned disabled FIRST, and deliberately: the button is enabled at rest,
    // so asserting the re-enable alone would pass against a `moving` that
    // never became true at all.
    await screen.findByTestId("browser-tab-show-here-spinner");
    expect(isDisabled(screen.getByRole("button", { name: "Show here" }))).toBe(
      true,
    );

    releaseMove();

    // A successful move normally unmounts this branch before its ack lands.
    // This is the OTHER resolve: the host's degrade-to-attach arm answers
    // `ok` without this window's binding arriving, so the branch stays
    // mounted - and clearing `moving` only on rejection would strand the
    // reader on a permanently disabled button.
    await waitFor(() => {
      expect(
        isDisabled(screen.getByRole("button", { name: "Show here" })),
      ).toBe(false);
    });
    expect(screen.queryByTestId("browser-tab-show-here-spinner")).toBeNull();
    expect(toastHarness.error).not.toHaveBeenCalled();
  });

  it("toasts the rejection reason and restores the button on a refused move", async () => {
    harness.moveTab.mockImplementation(() =>
      Promise.reject(
        new Error("This browser tab is being driven by an agent."),
      ),
    );
    harness.items = [sessionBoundTo("window-b")];
    renderTile();

    fireEvent.click(screen.getByRole("button", { name: "Show here" }));

    await waitFor(() => {
      expect(toastHarness.error).toHaveBeenCalledWith(
        "This browser tab is being driven by an agent.",
      );
    });

    const note = screen.getByTestId("browser-tab-other-window");
    expect(note.textContent).toBe("Open in your other window");
    expect(isDisabled(screen.getByRole("button", { name: "Show here" }))).toBe(
      false,
    );
  });
});

/**
 * Moved from `agent-browser-tile.test.tsx`: the whole "open a tab in this
 * pane's session and place it beside this tile" flow lives in the canvas
 * adapter (`BrowserSessionTile.onOpenLinkInNewTile`) now, not in the native
 * surface - the surface only forwards `(url, disposition)`. Driven directly
 * through the mocked `ElectronTabSurface`'s captured `onOpenLinkInNewTile`,
 * never through a native bridge, since the surface is a stub here.
 *
 * `expect(...)` bodies are unchanged from the originals. The one thing that
 * cannot be byte-identical is `harness.openTab`'s call argument: it is
 * `props.node.sessionId`, and this suite's own `NODE.sessionId` is
 * "sess-1" (`agent-browser-tile.test.tsx`'s was "session-1") - so that one
 * assertion reads "sess-1" while the RESOLVED tab (`harness.openTab`'s
 * fixed return value, which is under this file's control) still reads
 * "session-1", matching the original `node: { ..., sessionId: "session-1" }`
 * assertions exactly.
 */
describe("BrowserSessionTile open-link routing", () => {
  beforeEach(() => {
    harness.binding = binding();
    harness.items = [session("ready", "electron")];
    // Restated rather than relying on the previous describe block's own
    // teardown: it is the harness's default, but a case there that flips it
    // to exercise the viewer path must not leak into this suite depending on
    // run order.
    harness.canMaterializeElectron = true;
    harness.openTab.mockClear();
    harness.closeTab.mockClear();
    canvasState.tabsById = { "view-1": { epicId: "epic-1" } };
    canvasState.openTile.mockClear();
    surfaceCapture.onOpenLinkInNewTile = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("opens an in-page popup as a tab of this pane, foreground focusing it", async () => {
    renderTile();

    act(() => {
      surfaceCapture.onOpenLinkInNewTile?.(
        "https://popup.example/",
        "foreground",
      );
    });

    await waitFor(() => {
      expect(canvasState.openTile).toHaveBeenCalledTimes(1);
    });
    expect(canvasState.openTile.mock.calls[0]?.[0]).toMatchObject({
      target: { tabId: "view-1" },
      gesture: "explicit",
      modifiers: null,
      placement: { kind: "tab", paneId: "pane-1", index: null },
      dedupe: true,
      node: { type: "browser-session", sessionId: "session-1", tabId: "tab-2" },
    });
  });

  it("falls back to the epic when the view tab closed mid-open", async () => {
    // Held open so the tab is still there when the request arrives and gone
    // only while `openTab` is in flight - which is what makes this a test of
    // WHEN the target is resolved, not just that a missing tab falls back.
    const pending: {
      settle: (tab: { sessionId: string; tabId: string }) => void;
    } = { settle: () => undefined };
    harness.openTab.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          pending.settle = resolve;
        }),
    );
    renderTile();

    act(() => {
      surfaceCapture.onOpenLinkInNewTile?.(
        "https://popup.example/",
        "foreground",
      );
    });
    await waitFor(() => {
      expect(harness.openTab).toHaveBeenCalledTimes(1);
    });
    expect(canvasState.openTile).not.toHaveBeenCalled();

    // The tab goes away mid-flight; targeting it would put a tile in a canvas
    // with no route (R8).
    canvasState.tabsById = {};
    act(() => {
      pending.settle({ sessionId: "session-1", tabId: "tab-2" });
    });

    await waitFor(() => {
      expect(canvasState.openTile).toHaveBeenCalledTimes(1);
    });
    expect(canvasState.openTile.mock.calls[0]?.[0].target).toEqual({
      epicId: "epic-1",
    });
  });

  it("opens a background popup as a host push, leaving the current tab active", async () => {
    renderTile();

    act(() => {
      surfaceCapture.onOpenLinkInNewTile?.(
        "https://popup.example/",
        "background",
      );
    });

    await waitFor(() => {
      expect(canvasState.openTile).toHaveBeenCalledTimes(1);
    });
    expect(canvasState.openTile.mock.calls[0]?.[0]).toMatchObject({
      gesture: "host",
      placement: { kind: "tab", paneId: "pane-1", index: null },
    });
  });

  it("opens a new tab in the same session for a foreground default-URL request", async () => {
    renderTile();

    act(() => {
      surfaceCapture.onOpenLinkInNewTile?.("about:blank", "foreground");
    });

    await waitFor(() => {
      expect(harness.openTab).toHaveBeenCalledOnce();
    });
    // "sess-1", not "session-1": this is the argument the adapter actually
    // passed (`props.node.sessionId`), which is this suite's own NODE - see
    // the doc comment above for why this one value cannot be byte-identical
    // to the original while the rest of this file's assertions still are.
    expect(harness.openTab.mock.calls.at(0)?.at(0)).toBe("sess-1");
    expect(harness.closeTab).not.toHaveBeenCalled();
  });
});

describe("BrowserSessionTile adapter props", () => {
  beforeEach(() => {
    harness.binding = binding();
    harness.items = [session("ready", "electron")];
    harness.lifecycle = "live";
    harness.inventoryReady = true;
    harness.canMaterializeElectron = true;
    reachabilityHarness.status = "reachable";
    surfaceCapture.placement = null;
    surfaceCapture.node = null;
    surfaceCapture.visible = null;
    surfaceCapture.onConvertToPip = null;
    surfaceCapture.onNativeTileFocused = null;
    surfaceCapture.persistViewportPreset = null;
    surfaceCapture.onRequestClose = null;
    canvasState.updateBrowserTileViewportPresetInTab.mockClear();
    harness.closeCanvasTile.mockClear();
  });

  /**
   * Clicking into the native guest moves the OS focus into it, and the pane it
   * sits in has to claim activation or the previously active pane keeps it and
   * the next pane-scoped gesture goes to the wrong tile.
   *
   * The surface hears the desktop's report - it is the only layer that knows
   * which tile a report names - and hands it up. The claim itself is here,
   * because `viewTabId` and `paneId` are canvas facts the shared body has no
   * business carrying: it is also the Start Page panel's body, and a panel has
   * no panes.
   */
  it("claims its pane's activation when the native guest takes focus", () => {
    const claim = vi.fn();
    const unregister = registerHostedPaneActivationClaim(
      "view-1",
      "pane-1",
      claim,
    );
    renderTile();

    expect(surfaceCapture.onNativeTileFocused).not.toBeNull();
    act(() => {
      surfaceCapture.onNativeTileFocused?.();
    });

    expect(claim).toHaveBeenCalledExactlyOnceWith({
      defaultPrevented: false,
      scope: null,
      target: null,
    });
    unregister();
  });

  // The claim is for THIS tile's pane, not the tab's first: two tiles in one
  // view tab would otherwise activate the same pane.
  it("claims the pane it was rendered in", () => {
    const otherPane = vi.fn();
    const unregister = registerHostedPaneActivationClaim(
      "view-1",
      "pane-1",
      otherPane,
    );
    render(tileElement("pane-2"));

    act(() => {
      surfaceCapture.onNativeTileFocused?.();
    });

    expect(otherPane).not.toHaveBeenCalled();
    unregister();
  });

  it("derives every prop the body needs from canvas context", () => {
    renderTile();

    expect(surfaceCapture.placement).toEqual({
      kind: "canvas",
      epicId: "epic-1",
      viewTabId: "view-1",
      paneId: "pane-1",
    });
    // The surface's node carries the LIVE tab url, not the canvas ref's fields:
    // the body re-wraps the scope-free node with whatever the inventory says
    // the tab is showing right now.
    expect(surfaceCapture.node).toEqual({
      instanceId: NODE.instanceId,
      hostId: NODE.hostId,
      sessionId: NODE.sessionId,
      url: "https://example.com/page",
      viewportPreset: NODE.viewportPreset,
    });
    expect(surfaceCapture.pageSessionId).toBe(NODE.id);
    // The canvas can do all three, so none of the capability callbacks is null
    // - a null here is what the Start Page placement will mean, not this one.
    expect(surfaceCapture.onConvertToPip).not.toBeNull();
    expect(surfaceCapture.persistViewportPreset).not.toBeNull();
    expect(surfaceCapture.onRequestClose).not.toBeNull();
    expect(surfaceCapture.visible).toBe(true);
  });

  it("routes the close and viewport-preset callbacks to the canvas", () => {
    renderTile();

    surfaceCapture.onRequestClose?.();
    expect(harness.closeCanvasTile).toHaveBeenCalledOnce();

    surfaceCapture.persistViewportPreset?.("mobile");
    expect(
      canvasState.updateBrowserTileViewportPresetInTab,
    ).toHaveBeenCalledWith("view-1", NODE.instanceId, "mobile");
  });

  /**
   * The one failure mode in this refactor with no natural alarm. The native
   * surface memoizes its tile key and binding id on `placement`,
   * `node.instanceId` and `pageSessionId`, and keys its surface-attach effect
   * on the resulting tile key - so if any of those three stops being stable
   * across a render, the native view detaches and re-attaches every render and
   * settles at `bounds === null`, with every other test in this file green.
   * Inline the adapter's `placement` object literal and this is what reddens.
   *
   * The surface's `node` OBJECT is deliberately fresh per render and is not
   * pinned here: the body rebuilds it to carry the live `tab.url`, and nothing
   * memoizes on its identity. Only its `instanceId` reaches the tile key.
   */
  it("hands the body a referentially stable placement across a rerender", () => {
    const view = render(tileElement("pane-1"));
    const firstPlacement = surfaceCapture.placement;
    const firstInstanceId = surfaceCapture.node?.instanceId;
    const firstPageSessionId = surfaceCapture.pageSessionId;
    expect(firstPlacement).not.toBeNull();

    view.rerender(tileElement("pane-1"));

    expect(surfaceCapture.placement).toBe(firstPlacement);
    expect(surfaceCapture.node?.instanceId).toBe(firstInstanceId);
    expect(surfaceCapture.pageSessionId).toBe(firstPageSessionId);
  });

  it("mints a new placement when the pane changes", () => {
    const view = render(tileElement("pane-1"));
    const firstPlacement = surfaceCapture.placement;

    view.rerender(tileElement("pane-2"));

    // Stability must not be latching: a real change has to travel, or the
    // native surface would keep addressing the pane it was first mounted in.
    expect(surfaceCapture.placement).not.toBe(firstPlacement);
    const placement = surfaceCapture.placement;
    expect(placement?.kind === "canvas" ? placement.paneId : null).toBe(
      "pane-2",
    );
  });
});
