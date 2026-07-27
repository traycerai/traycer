import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
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
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";

vi.mock("@/components/epic-canvas/sidebar/epic-sidebar", () => ({
  EpicLeftPanelHost: (props: { epicId: string; tabId: string }) => (
    <div
      data-testid="epic-sidebar-host-stub"
      data-epic-id={props.epicId}
      data-tab-id={props.tabId}
    />
  ),
  EpicLeftPanelLoadingHost: (props: { epicId: string; tabId: string }) => (
    <div
      data-testid="epic-sidebar-loading-stub"
      data-epic-id={props.epicId}
      data-tab-id={props.tabId}
    />
  ),
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
vi.mock("@/lib/epic-selectors", () => ({
  useEpicSnapshotLoaded: () => true,
  useEpicSnapshotFetchError: () => null,
}));

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

function buildSessionHandle(epicId: string): OpenEpicStoreHandle {
  return createOpenEpicStore({
    epicId,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
}

function renderColumn() {
  return render(
    <TooltipProvider>
      <div className="flex">
        <EpicSidebarColumn epicId={EPIC_ID} tabId={TAB_ID} />
      </div>
    </TooltipProvider>,
  );
}

describe("<EpicSidebarColumn />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __getOpenEpicRegistryForTests().disposeAll();
    useLeftPanelStore.setState({
      mainCollapsedByTabId: {},
      sidebarWidthPx: DEFAULT_SIDEBAR_WIDTH_PX,
    });
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
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

  it("flips to the live host when the pane provider registers the session", () => {
    renderColumn();
    expect(screen.queryByTestId("epic-sidebar-host-stub")).toBeNull();

    act(() => {
      __getOpenEpicRegistryForTests().acquireMounted(
        EPIC_ID,
        buildSessionHandle,
      );
    });

    const column = screen.getByTestId("epic-sidebar-column");
    expect(column.dataset.sessionReady).toBe("true");
    const host = screen.getByTestId("epic-sidebar-host-stub");
    expect(host.dataset.epicId).toBe(EPIC_ID);
    expect(host.dataset.tabId).toBe(TAB_ID);
    expect(screen.getByTestId("epic-rail-live-stub").dataset.orientation).toBe(
      "horizontal",
    );
    expect(screen.queryByTestId("epic-sidebar-loading-stub")).toBeNull();

    act(() => {
      __getOpenEpicRegistryForTests().release(EPIC_ID);
    });
    expect(screen.queryByTestId("epic-sidebar-host-stub")).toBeNull();
    expect(screen.getByTestId("epic-sidebar-loading-stub")).not.toBeNull();
  });

  it("collapses via CSS only: the panel column stays mounted and the rail goes vertical", () => {
    renderColumn();
    act(() => {
      __getOpenEpicRegistryForTests().acquireMounted(
        EPIC_ID,
        buildSessionHandle,
      );
    });

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
