import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EpicSidebarColumn } from "@/components/epic-canvas/sidebar/epic-sidebar-column";
import { pointerEvent } from "@/components/epic-canvas/canvas/__tests__/test-pointer-events";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import {
  DEFAULT_SIDEBAR_WIDTH_PX,
  MAX_SIDEBAR_WIDTH_PX,
  MIN_SIDEBAR_WIDTH_PX,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabAutoTint } from "@/components/layout/tabs/tab-identity";
import { useSidebarRailWidthStore } from "@/stores/epics/sidebar-rail-width-store";

const sidebarRenderCounts = vi.hoisted(() => ({
  liveHost: 0,
  loadingHost: 0,
}));

vi.mock("@/components/epic-canvas/sidebar/epic-sidebar", () => ({
  EpicLeftPanelHost: (props: { epicId: string; tabId: string }) => {
    sidebarRenderCounts.liveHost += 1;
    return (
      <div
        data-testid="epic-sidebar-host-stub"
        data-epic-id={props.epicId}
        data-tab-id={props.tabId}
      />
    );
  },
  EpicLeftPanelLoadingHost: (props: { epicId: string; tabId: string }) => {
    sidebarRenderCounts.loadingHost += 1;
    return (
      <div
        data-testid="epic-sidebar-loading-stub"
        data-epic-id={props.epicId}
        data-tab-id={props.tabId}
      />
    );
  },
}));

vi.mock("@/components/epic-canvas/sidebar/epic-sidebar-rail", () => ({
  EpicLeftPanelRail: (props: { orientation: string }) => (
    <div
      data-testid="epic-rail-live-stub"
      data-orientation={props.orientation}
    />
  ),
  EpicLeftPanelStaticRail: (props: { orientation: string }) => (
    <div
      data-testid="epic-rail-static-stub"
      data-orientation={props.orientation}
    />
  ),
}));

// The snapshot scope reads session-bound selectors; stub them so the live
// branch renders against the fake handle without a full projector store.
// Everything else (incl. `useRegisteredEpicTitle` /
// `useRegisteredEpicTitleGenerating`, which the panel task header reads) stays
// real: both fall back safely to `null`/`false` for an epic id with no
// registered handle, which is every case in this file.
vi.mock("@/lib/epic-selectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/epic-selectors")>();
  return {
    ...actual,
    useEpicSnapshotLoaded: () => true,
    useEpicSnapshotFetchError: () => null,
  };
});

const EPIC_ID = "sidebar-column-epic";
const TAB_ID = "sidebar-column-tab";

const KEYBINDING_ROUTER: KeybindingRouter = {
  getPathname: () => `/epics/${EPIC_ID}/${TAB_ID}`,
  navigateHome: () => undefined,
  navigateSettings: () => undefined,
  navigateToEpic: () => undefined,
  navigateToEpicTab: () => undefined,
  navigateToEpicList: () => undefined,
  navigateSettingsSection: () => undefined,
  navigateToTabIntent: () => undefined,
  goBack: () => undefined,
  goForward: () => undefined,
  isHistoryNavAvailable: () => false,
  canGoBack: () => false,
  canGoForward: () => false,
};

// A REAL per-Epic store handle on a no-op stream client (the same factory
// shape `test-epic-session-harness.ts` installs, minus the snapshot frame):
// honestly typed with zero casts. The column only checks handle presence and
// the session-bound selectors are mocked above, so no snapshot ever needs to
// arrive on this stream.
const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function buildSessionHandle(epicId: string): OpenedStoreForTest {
  return openStoreForTest({
    epicId: epicId,
    userId: null,
    // The factories go to the COMPOSITION now: the store stopped
    // constructing a runtime, so a `streamClientFactory` has nowhere
    // else to go.
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
}

/** The app root's query client; the panel header's rename reads it. */
function QueryWrapper(props: { readonly children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
  );
}

function renderColumn() {
  return render(
    <TooltipProvider>
      <div className="flex">
        <EpicSidebarColumn epicId={EPIC_ID} tabId={TAB_ID} side="left" />
      </div>
    </TooltipProvider>,
    { wrapper: QueryWrapper },
  );
}

function renderColumnWithSession(handle: OpenedStoreForTest) {
  return render(
    <TooltipProvider>
      <EpicSessionContext.Provider value={handle}>
        <div className="flex">
          <EpicSidebarColumn epicId={EPIC_ID} tabId={TAB_ID} side="left" />
        </div>
      </EpicSessionContext.Provider>
    </TooltipProvider>,
    { wrapper: QueryWrapper },
  );
}

describe("<EpicSidebarColumn />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    sidebarRenderCounts.liveHost = 0;
    sidebarRenderCounts.loadingHost = 0;
    useLeftPanelStore.setState({
      mainCollapsedByTabId: {},
      sidebarWidthPx: DEFAULT_SIDEBAR_WIDTH_PX,
    });
    useSidebarRailWidthStore.setState({ naturalWidthPxByTabId: {} });
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the loading host and static rail while no session is registered", () => {
    renderColumn();

    const column = screen.getByTestId("epic-sidebar-column");
    expect(column.dataset.sessionReady).toBe("false");
    expect(column.dataset.collapsed).toBe("false");
    expect(screen.getByTestId("epic-sidebar-loading-stub").dataset.epicId).toBe(
      EPIC_ID,
    );
    expect(
      screen.getByTestId("epic-rail-static-stub").dataset.orientation,
    ).toBe("horizontal");
    expect(screen.queryByTestId("epic-sidebar-host-stub")).toBeNull();
  });

  it("uses the live host from its enclosing pane session provider", () => {
    renderColumnWithSession(buildSessionHandle(EPIC_ID));

    const column = screen.getByTestId("epic-sidebar-column");
    expect(column.dataset.sessionReady).toBe("true");
    const host = screen.getByTestId("epic-sidebar-host-stub");
    expect(host.dataset.epicId).toBe(EPIC_ID);
    expect(host.dataset.tabId).toBe(TAB_ID);
    expect(screen.getByTestId("epic-rail-live-stub").dataset.orientation).toBe(
      "horizontal",
    );
    expect(screen.queryByTestId("epic-sidebar-loading-stub")).toBeNull();
  });

  it("does not rerender its subtree when its parent rerenders with the same surface identity", () => {
    const view = renderColumn();
    expect(sidebarRenderCounts.loadingHost).toBe(1);

    view.rerender(
      <TooltipProvider>
        <div className="flex">
          <EpicSidebarColumn epicId={EPIC_ID} tabId={TAB_ID} side="left" />
        </div>
      </TooltipProvider>,
    );

    expect(sidebarRenderCounts.loadingHost).toBe(1);
  });

  it("still rerenders for sidebar-owned store updates", () => {
    renderColumn();
    expect(sidebarRenderCounts.loadingHost).toBe(1);

    act(() => {
      useLeftPanelStore.getState().setSidebarWidthPx(480);
    });

    expect(screen.getByTestId("epic-sidebar-column").style.width).toBe("480px");
    expect(sidebarRenderCounts.loadingHost).toBe(2);
  });

  it("still rerenders when its enclosing session context becomes ready", () => {
    const handle = buildSessionHandle(EPIC_ID);
    const view = render(
      <TooltipProvider>
        <EpicSessionContext.Provider value={null}>
          <div className="flex">
            <EpicSidebarColumn epicId={EPIC_ID} tabId={TAB_ID} side="left" />
          </div>
        </EpicSessionContext.Provider>
      </TooltipProvider>,
    );
    expect(sidebarRenderCounts.loadingHost).toBe(1);
    expect(screen.getByTestId("epic-sidebar-column").dataset.sessionReady).toBe(
      "false",
    );

    view.rerender(
      <TooltipProvider>
        <EpicSessionContext.Provider value={handle}>
          <div className="flex">
            <EpicSidebarColumn epicId={EPIC_ID} tabId={TAB_ID} side="left" />
          </div>
        </EpicSessionContext.Provider>
      </TooltipProvider>,
    );

    expect(screen.getByTestId("epic-sidebar-column").dataset.sessionReady).toBe(
      "true",
    );
    expect(sidebarRenderCounts.liveHost).toBe(1);
  });

  it("collapses via CSS only: the panel column stays mounted and the rail goes vertical", () => {
    renderColumnWithSession(buildSessionHandle(EPIC_ID));

    act(() => {
      useLeftPanelStore.getState().setMainCollapsed(TAB_ID, true);
    });

    const column = screen.getByTestId("epic-sidebar-column");
    expect(column.dataset.collapsed).toBe("true");
    expect(column.classList.contains("hidden")).toBe(true);
    // Keep-alive: the panel host is hidden, NOT unmounted.
    expect(screen.getByTestId("epic-sidebar-host-stub")).not.toBeNull();
    expect(screen.getByTestId("epic-rail-live-stub").dataset.orientation).toBe(
      "vertical",
    );
    expect(
      screen
        .getByTestId("epic-sidebar-resize-handle")
        .classList.contains("hidden"),
    ).toBe(true);

    act(() => {
      useLeftPanelStore.getState().setMainCollapsed(TAB_ID, false);
    });
    expect(column.classList.contains("hidden")).toBe(false);
    expect(screen.getByTestId("epic-rail-live-stub").dataset.orientation).toBe(
      "horizontal",
    );
  });

  it("toggles the left panel collapse state through the configurable shortcut action", () => {
    renderColumn();

    const column = screen.getByTestId("epic-sidebar-column");
    expect(column.dataset.collapsed).toBe("false");

    act(() => {
      expect(dispatchAction("app.sidebar.toggle", KEYBINDING_ROUTER)).toBe(
        true,
      );
    });

    expect(useLeftPanelStore.getState().isMainCollapsed(TAB_ID)).toBe(true);
    expect(column.dataset.collapsed).toBe("true");
    expect(column.classList.contains("hidden")).toBe(true);

    act(() => {
      expect(dispatchAction("app.sidebar.toggle", KEYBINDING_ROUTER)).toBe(
        true,
      );
    });

    expect(useLeftPanelStore.getState().isMainCollapsed(TAB_ID)).toBe(false);
    expect(column.dataset.collapsed).toBe("false");
    expect(column.classList.contains("hidden")).toBe(false);
  });

  it("applies the persisted width and resets it on handle double-click", () => {
    act(() => {
      useLeftPanelStore.getState().setSidebarWidthPx(480);
    });
    renderColumn();

    const column = screen.getByTestId("epic-sidebar-column");
    expect(column.style.width).toBe("480px");

    fireEvent.doubleClick(screen.getByTestId("epic-sidebar-resize-handle"));
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(
      DEFAULT_SIDEBAR_WIDTH_PX,
    );
    expect(column.style.width).toBe(`${DEFAULT_SIDEBAR_WIDTH_PX}px`);
  });

  // Bug #1: the rail is mocked out in this file, so the widest-mounted-rail
  // floor is exercised directly through its store rather than through a real
  // rail's own measurement (that measurement is covered in
  // `epic-sidebar-rail.test.tsx`).
  it("widens the panel past the persisted width for a wider mounted rail, and settles back once it unmounts", () => {
    act(() => {
      useSidebarRailWidthStore
        .getState()
        .setRailNaturalWidthPx("other-tab", 400);
    });
    renderColumn();
    expect(screen.getByTestId("epic-sidebar-column").style.width).toBe("400px");

    act(() => {
      useSidebarRailWidthStore.getState().clearRailNaturalWidthPx("other-tab");
    });

    expect(screen.getByTestId("epic-sidebar-column").style.width).toBe(
      `${DEFAULT_SIDEBAR_WIDTH_PX}px`,
    );
  });

  it("nudges the committed width with arrow keys from the handle", () => {
    renderColumn();
    const handle = screen.getByTestId("epic-sidebar-resize-handle");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(
      DEFAULT_SIDEBAR_WIDTH_PX + 24,
    );

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(
      DEFAULT_SIDEBAR_WIDTH_PX,
    );
  });

  // jsdom has no layout, so the handle's two measurements are stubbed: the
  // flex row (drag-time half-row cap) and the panel column (start width).
  function setUpDragSurface(): {
    readonly handle: HTMLElement;
    readonly column: HTMLElement;
  } {
    renderColumn();
    const handle = screen.getByTestId("epic-sidebar-resize-handle");
    const column = screen.getByTestId("epic-sidebar-column");
    const flexRow = handle.parentElement;
    if (flexRow === null) throw new Error("resize handle must have a parent");
    vi.spyOn(flexRow, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 1000, 800),
    );
    vi.spyOn(column, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, DEFAULT_SIDEBAR_WIDTH_PX, 800),
    );
    return { handle, column };
  }

  it("drags with per-frame style.width mutation and commits once on release", () => {
    const { handle, column } = setUpDragSurface();

    fireEvent(
      handle,
      pointerEvent("pointerdown", {
        pointerId: 7,
        clientX: DEFAULT_SIDEBAR_WIDTH_PX,
        clientY: 10,
        button: 0,
      }),
    );
    fireEvent(
      handle,
      pointerEvent("pointermove", {
        pointerId: 7,
        clientX: DEFAULT_SIDEBAR_WIDTH_PX + 100,
        clientY: 10,
        button: 0,
      }),
    );

    // Per-frame DOM mutation only; the store still holds the old width.
    expect(column.style.width).toBe(`${DEFAULT_SIDEBAR_WIDTH_PX + 100}px`);
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(
      DEFAULT_SIDEBAR_WIDTH_PX,
    );

    fireEvent(
      handle,
      pointerEvent("pointerup", {
        pointerId: 7,
        clientX: DEFAULT_SIDEBAR_WIDTH_PX + 100,
        clientY: 10,
        button: 0,
      }),
    );
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(
      DEFAULT_SIDEBAR_WIDTH_PX + 100,
    );
  });

  it("clamps the drag between the px floor and half the layout row", () => {
    const { handle, column } = setUpDragSurface();

    fireEvent(
      handle,
      pointerEvent("pointerdown", {
        pointerId: 7,
        clientX: DEFAULT_SIDEBAR_WIDTH_PX,
        clientY: 10,
        button: 0,
      }),
    );
    // Far right: capped at min(MAX_SIDEBAR_WIDTH_PX, 1000 * 0.5) = 500.
    fireEvent(
      handle,
      pointerEvent("pointermove", {
        pointerId: 7,
        clientX: 5000,
        clientY: 10,
        button: 0,
      }),
    );
    expect(MAX_SIDEBAR_WIDTH_PX).toBeGreaterThan(500);
    expect(column.style.width).toBe("500px");

    // Far left: floored at MIN_SIDEBAR_WIDTH_PX.
    fireEvent(
      handle,
      pointerEvent("pointermove", {
        pointerId: 7,
        clientX: -5000,
        clientY: 10,
        button: 0,
      }),
    );
    expect(column.style.width).toBe(`${MIN_SIDEBAR_WIDTH_PX}px`);

    fireEvent(
      handle,
      pointerEvent("pointerup", {
        pointerId: 7,
        clientX: -5000,
        clientY: 10,
        button: 0,
      }),
    );
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(
      MIN_SIDEBAR_WIDTH_PX,
    );
  });

  it("keeps a live drag from going narrower than the widest mounted rail's reported floor", () => {
    act(() => {
      useSidebarRailWidthStore
        .getState()
        .setRailNaturalWidthPx("other-tab", 260);
    });
    const { handle, column } = setUpDragSurface();

    fireEvent(
      handle,
      pointerEvent("pointerdown", {
        pointerId: 7,
        clientX: DEFAULT_SIDEBAR_WIDTH_PX,
        clientY: 10,
        button: 0,
      }),
    );
    // Far left: would floor at the static MIN_SIDEBAR_WIDTH_PX (200) without
    // the fix; the mounted rail's own 260px floor wins instead.
    fireEvent(
      handle,
      pointerEvent("pointermove", {
        pointerId: 7,
        clientX: -5000,
        clientY: 10,
        button: 0,
      }),
    );
    expect(column.style.width).toBe("260px");

    fireEvent(
      handle,
      pointerEvent("pointerup", {
        pointerId: 7,
        clientX: -5000,
        clientY: 10,
        button: 0,
      }),
    );
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(260);
  });

  it("restores the pre-drag inline width on pointer-cancel without committing", () => {
    const { handle, column } = setUpDragSurface();

    fireEvent(
      handle,
      pointerEvent("pointerdown", {
        pointerId: 9,
        clientX: DEFAULT_SIDEBAR_WIDTH_PX,
        clientY: 10,
        button: 0,
      }),
    );
    fireEvent(
      handle,
      pointerEvent("pointermove", {
        pointerId: 9,
        clientX: DEFAULT_SIDEBAR_WIDTH_PX + 80,
        clientY: 10,
        button: 0,
      }),
    );
    expect(column.style.width).toBe(`${DEFAULT_SIDEBAR_WIDTH_PX + 80}px`);

    fireEvent(
      handle,
      pointerEvent("pointercancel", {
        pointerId: 9,
        clientX: DEFAULT_SIDEBAR_WIDTH_PX + 80,
        clientY: 10,
        button: 0,
      }),
    );
    expect(column.style.width).toBe(`${DEFAULT_SIDEBAR_WIDTH_PX}px`);
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(
      DEFAULT_SIDEBAR_WIDTH_PX,
    );
  });
});

describe("<EpicSidebarColumn /> panel task header", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useLeftPanelStore.setState({
      mainCollapsedByTabId: {},
      sidebarWidthPx: DEFAULT_SIDEBAR_WIDTH_PX,
    });
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
  });

  it("tints the chip with the tab's own colour when it has one", () => {
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId(TAB_ID, EPIC_ID, "Header Task");
    // `setTabCustomization` writes onto the strip's own layout item, so the
    // ref has to be present in it first - unlike the epic-canvas tab record,
    // this store has no seed for a ref that was never opened through it.
    useTabsStore.getState().ensurePresent({ kind: "epic", id: TAB_ID });
    useTabsStore
      .getState()
      .setTabCustomization({ kind: "epic", id: TAB_ID }, { color: "#3355ee" });

    renderColumn();

    expect(screen.getByTestId("epic-sidebar-task-header")).not.toBeNull();
    expect(screen.getByText("Header Task")).not.toBeNull();
    const chip = screen.getByTestId("side-tab-monogram-chip");
    expect(chip.style.getPropertyValue("--side-tab-tint")).toBe("#3355ee");
  });

  it("falls back to the epic's auto tint when the tab has no colour", () => {
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId(TAB_ID, EPIC_ID, "Header Task");

    renderColumn();

    const chip = screen.getByTestId("side-tab-monogram-chip");
    expect(chip.style.getPropertyValue("--side-tab-tint")).toBe(
      tabAutoTint(EPIC_ID),
    );
  });

  it("shows no header while the panel is collapsed", () => {
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId(TAB_ID, EPIC_ID, "Header Task");

    renderColumn();
    expect(screen.getByTestId("epic-sidebar-task-header")).not.toBeNull();

    act(() => {
      useLeftPanelStore.getState().setMainCollapsed(TAB_ID, true);
    });

    expect(screen.queryByTestId("epic-sidebar-task-header")).toBeNull();
  });

  it("renders no header when the tab cannot be resolved", () => {
    renderColumn();

    expect(screen.queryByTestId("epic-sidebar-task-header")).toBeNull();
  });
});
