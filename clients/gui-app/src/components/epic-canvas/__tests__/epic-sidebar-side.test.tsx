import { appColumnChrome } from "@/components/layout/header/app-title-band-kind";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabSurfaceActivityProvider } from "@/components/layout/tab-surface-activity";
import { EpicSidebarColumn } from "@/components/epic-canvas/sidebar/epic-sidebar-column";
import { EpicSurface } from "@/components/epic-tabs/epic-surface";
import { ChatFilterMenu } from "@/components/epic-canvas/sidebar/epic-sidebar-filter-menu";
import { browserGuestCssSheetAnchorName } from "@/lib/browser-view/guest/persistent-browser-guest-host";
import { AppColumnFrame } from "@/components/layout/app-column-frame";
import {
  ColumnEdgeContext,
  useColumnOverlayPlacement,
} from "@/components/layout/column-edge-context";
import { pointerEvent } from "@/components/epic-canvas/canvas/__tests__/test-pointer-events";
import { GROUND_RESIZE_HANDLE_LINE_CLASS } from "@/components/epic-canvas/canvas/use-pointer-drag-commit";
import {
  DEFAULT_SIDEBAR_WIDTH_PX,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { useLayoutStore } from "@/stores/layout/layout-store";

const EPIC_ID = "sidebar-side-epic";
const TAB_ID = "sidebar-side-tab";
const HOST_ID = "sidebar-side-host";
const KEYBOARD_RESIZE_STEP_PX = 24;

// The column and surface tests below exercise `EpicSidebarColumn`'s own
// fragment ordering and `EpicSurface`'s row ordering - not the panel bodies
// or the rail's icon set, which the existing sidebar suites already cover.
// Stubbing both keeps the render light and keeps this suite from drifting
// when their internals change for unrelated reasons.
vi.mock("@/components/epic-canvas/sidebar/epic-sidebar", () => ({
  EpicLeftPanelHost: () => <div data-testid="epic-sidebar-host-stub" />,
  EpicLeftPanelLoadingHost: () => (
    <div data-testid="epic-sidebar-loading-stub" />
  ),
}));

vi.mock("@/components/epic-canvas/sidebar/epic-sidebar-rail", () => ({
  EpicLeftPanelRail: (props: { readonly orientation: string }) => (
    <div
      data-testid="epic-rail-live-stub"
      data-orientation={props.orientation}
    />
  ),
  EpicLeftPanelStaticRail: (props: { readonly orientation: string }) => (
    <div
      data-testid="epic-rail-static-stub"
      data-orientation={props.orientation}
    />
  ),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicSnapshotLoaded: () => true,
  useEpicSnapshotFetchError: () => null,
}));

// EpicSurface's own dependencies, stubbed the same minimal way
// `epic-surface.test.tsx` does: this suite is about which side the column
// renders on, not about session bootstrap or browser-session plumbing.
vi.mock("@tanstack/react-router", () => ({
  useMatch: () => undefined,
}));

vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => false,
}));

vi.mock("@/providers/epic-session-provider", () => ({
  EpicSessionProvider: (props: { readonly children: ReactNode }) => (
    <>{props.children}</>
  ),
}));

vi.mock("@/components/epic-canvas/renderers/browser-sessions-provider", () => ({
  BrowserSessionsProvider: (props: { readonly children: ReactNode }) => (
    <>{props.children}</>
  ),
}));

vi.mock("@/components/epic-canvas/epic-route-session-body", () => ({
  EpicRouteSessionBody: (props: { readonly tabId: string }) => (
    <div data-testid={`epic-canvas-body-${props.tabId}`} />
  ),
}));

vi.mock("@/components/epic-canvas/pip/agent-browser-pip", () => ({
  AgentBrowserPip: () => null,
}));

// Only reached by the direct rail render in the last describe block below,
// which imports the REAL rail module (bypassing the stub above) to check the
// indicator and tooltip mirror. Mirrors the same two mocks
// `epic-sidebar.test.tsx` uses to render the rail standalone.
vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => HOST_ID,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostDirectoryEntryForHostId: () => null,
  useHostClientForHostId: () => null,
}));

function resetStores() {
  window.localStorage.clear();
  useLeftPanelStore.setState({
    mainCollapsedByTabId: {},
    sidebarWidthPx: DEFAULT_SIDEBAR_WIDTH_PX,
  });
  useLayoutStore.setState({ arrangement: DEFAULT_ARRANGEMENT });
}

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  resetStores();
});

function renderColumn(side: "left" | "right") {
  return render(
    <TooltipProvider>
      <div className="flex" data-testid="column-wrapper">
        <EpicSidebarColumn epicId={EPIC_ID} tabId={TAB_ID} side={side} />
      </div>
    </TooltipProvider>,
  );
}

function wrapperChildTestIds(): ReadonlyArray<string | undefined> {
  return [...screen.getByTestId("column-wrapper").children].map(
    (child) => (child as HTMLElement).dataset.testid,
  );
}

/** Every token of the shared ground hover/drag line, and no RESTING
 * `before:bg-*` - only the `hover:`/`active:` variants the class carries. */
function expectGroundResizeHandleLine(handle: HTMLElement): void {
  for (const token of GROUND_RESIZE_HANDLE_LINE_CLASS.split(" ")) {
    expect(handle.className).toContain(token);
  }
  const tokens = handle.className.split(/\s+/);
  expect(tokens.some((token) => /^before:bg-/.test(token))).toBe(false);
}

describe("<EpicSidebarColumn /> side (S-06)", () => {
  // DOM order is focus order, and the handle finds its panel by sibling
  // lookup, so a right sidebar mirrors the fragment. The handle is the same
  // shared ground line on both sides: no resting `before:bg-*`.
  it.each([
    {
      side: "left",
      order: ["epic-sidebar-column", "epic-sidebar-resize-handle"],
      paneBorder: "md:border-e",
    },
    {
      side: "right",
      order: ["epic-sidebar-resize-handle", "epic-sidebar-column"],
      paneBorder: "md:border-s",
    },
  ] as const)(
    "orders the fragment for a $side sidebar, with the same ground resize line",
    ({ side, order, paneBorder }) => {
      renderColumn(side);

      expect(wrapperChildTestIds()).toEqual(order);
      const panel = screen.getByTestId("epic-sidebar-column");
      // One-sheet design: no `data-shell-sheet` marker on the panel any more.
      expect(panel.dataset.shellSheet).toBeUndefined();
      // Flush surface: the panel no longer draws a pane divider against the
      // content pane - only the epic canvas frame draws a border now.
      expect(panel.className).not.toContain(paneBorder);
      expect(panel.className).not.toContain("md:border-canvas-border");
      const handle = screen.getByTestId("epic-sidebar-resize-handle");
      // One-sheet design: the handle lost its centred `--shell-gap` hit
      // target margin - there is no ground gap to centre in any more.
      expect(handle.className).not.toContain(
        "md:mx-[calc(var(--shell-gap)/-2)]",
      );
      expect(handle.className).toContain("md:w-0");
      expectGroundResizeHandleLine(handle);
    },
  );

  it("puts the collapsed rail at the pane's outer edge on both sides, itself a sheet", () => {
    act(() => {
      useLeftPanelStore.getState().setMainCollapsed(TAB_ID, true);
    });

    renderColumn("left");
    const leftChildren = [
      ...screen
        .getByTestId("column-wrapper")
        .querySelectorAll<HTMLElement>(":scope > *"),
    ];
    expect(leftChildren.map((child) => child.dataset.testid)).toEqual([
      undefined,
      "epic-sidebar-column",
      "epic-sidebar-resize-handle",
    ]);
    const [leftCollapsedRail, leftPanel] = leftChildren;
    expect(leftCollapsedRail.dataset.shellSheet).toBeUndefined();
    // Flush surface: no pane divider on the collapsed rail either.
    expect(leftCollapsedRail.className).not.toContain("md:border-e");
    expect(leftCollapsedRail.className).not.toContain(
      "md:border-canvas-border",
    );
    expect(
      leftCollapsedRail.querySelector('[data-testid="epic-rail-static-stub"]'),
    ).not.toBeNull();
    expect(leftPanel.dataset.shellSheet).toBeUndefined();
    expect(leftPanel.className).not.toContain("md:border-e");
    expect(leftPanel.className).not.toContain("md:border-canvas-border");
    cleanup();

    renderColumn("right");
    const rightChildren = [
      ...screen
        .getByTestId("column-wrapper")
        .querySelectorAll<HTMLElement>(":scope > *"),
    ];
    expect(rightChildren.map((child) => child.dataset.testid)).toEqual([
      "epic-sidebar-resize-handle",
      "epic-sidebar-column",
      undefined,
    ]);
    const rightCollapsedRail = rightChildren[2];
    expect(rightCollapsedRail.dataset.shellSheet).toBeUndefined();
    expect(rightCollapsedRail.className).not.toContain("md:border-s");
    expect(rightCollapsedRail.className).not.toContain(
      "md:border-canvas-border",
    );
    expect(
      rightCollapsedRail.querySelector('[data-testid="epic-rail-static-stub"]'),
    ).not.toBeNull();
  });

  function setUpRightDragSurface(): {
    readonly handle: HTMLElement;
    readonly panel: HTMLElement;
  } {
    renderColumn("right");
    const handle = screen.getByTestId("epic-sidebar-resize-handle");
    const panel = screen.getByTestId("epic-sidebar-column");
    const flexRow = handle.parentElement;
    if (flexRow === null) throw new Error("resize handle must have a parent");
    vi.spyOn(flexRow, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 1000, 800),
    );
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, DEFAULT_SIDEBAR_WIDTH_PX, 800),
    );
    return { handle, panel };
  }

  it("negates the drag delta for a right sidebar: dragging toward the canvas (leftward) widens the panel", () => {
    const { handle, panel } = setUpRightDragSurface();

    fireEvent(
      handle,
      pointerEvent("pointerdown", {
        pointerId: 7,
        clientX: 500,
        clientY: 10,
        button: 0,
      }),
    );
    fireEvent(
      handle,
      pointerEvent("pointermove", {
        pointerId: 7,
        clientX: 400,
        clientY: 10,
        button: 0,
      }),
    );

    expect(panel.style.width).toBe(`${DEFAULT_SIDEBAR_WIDTH_PX + 100}px`);

    fireEvent(
      handle,
      pointerEvent("pointerup", {
        pointerId: 7,
        clientX: 400,
        clientY: 10,
        button: 0,
      }),
    );
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(
      DEFAULT_SIDEBAR_WIDTH_PX + 100,
    );
  });

  it("negates the arrow nudge for a right sidebar: ArrowLeft grows it, ArrowRight shrinks it", () => {
    const { handle } = setUpRightDragSurface();

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(
      DEFAULT_SIDEBAR_WIDTH_PX + KEYBOARD_RESIZE_STEP_PX,
    );

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(
      DEFAULT_SIDEBAR_WIDTH_PX,
    );
  });
});

describe("<EpicSurface /> sidebar side (S-06)", () => {
  function renderSurface(tabId: string, epicId: string) {
    return render(
      <TabSurfaceActivityProvider activity={{ visible: true, focused: true }}>
        <EpicSurface epicId={epicId} tabId={tabId} />
      </TabSurfaceActivityProvider>,
    );
  }

  function surfaceChildTestIds(tabId: string): ReadonlyArray<string> {
    const container = document.querySelector(`[data-epic-surface="${tabId}"]`);
    if (container === null) throw new Error("epic surface row not found");
    // The body slot is a plain wrapper div around `EpicRouteSessionBody`
    // (unchanged by this ticket), so its own testid is one level down.
    return [...container.children].map((child) => {
      const element = child as HTMLElement;
      return (
        element.dataset.testid ??
        element.querySelector("[data-testid]")?.getAttribute("data-testid") ??
        ""
      );
    });
  }

  it("puts the sidebar column before the body with the default (left) side", () => {
    renderSurface(TAB_ID, EPIC_ID);

    expect(surfaceChildTestIds(TAB_ID)).toEqual([
      "epic-sidebar-column",
      "epic-sidebar-resize-handle",
      `epic-canvas-body-${TAB_ID}`,
    ]);
  });

  it("puts the sidebar column after the body when sidebarSide is right", () => {
    act(() => {
      useLayoutStore.setState({
        arrangement: { ...DEFAULT_ARRANGEMENT, sidebarSide: "right" },
      });
    });

    renderSurface(TAB_ID, EPIC_ID);

    expect(surfaceChildTestIds(TAB_ID)).toEqual([
      `epic-canvas-body-${TAB_ID}`,
      "epic-sidebar-resize-handle",
      "epic-sidebar-column",
    ]);
  });

  it("is the one task sheet: data-shell-sheet=task on the outer box, no nested per-pane markers (D1/D2)", () => {
    renderSurface(TAB_ID, EPIC_ID);

    const container = document.querySelector<HTMLElement>(
      `[data-epic-surface="${TAB_ID}"]`,
    );
    if (container === null) throw new Error("epic surface row not found");
    // One-sheet design: the marker sits on the OUTER box itself, which
    // holds the panel and content panes directly - no nested "panel" /
    // "content" markers any more.
    expect(container.dataset.shellSheet).toBe("task");
    expect(container.querySelectorAll("[data-shell-sheet]")).toHaveLength(0);

    // The browser guest's outer sheet clipper anchors to this element by the
    // same per-tab name (`browserGuestCssSheetAnchorName`), so a guest
    // presented on this tab clips to this sheet's own rounded corners.
    expect(container.style.getPropertyValue("anchor-name")).toBe(
      browserGuestCssSheetAnchorName(TAB_ID),
    );
  });

  it.each(["top", "left", "right"] as const)(
    "holds the one-sheet epic composition inside the placement's own surface frame, placement=%s",
    (placement) => {
      render(
        <AppColumnFrame
          {...appColumnChrome({ placement, platform: null, frameless: false })}
          columnRef={() => undefined}
          header={<header />}
          strip={<nav />}
          banners={<div />}
          surface={
            <TabSurfaceActivityProvider
              activity={{ visible: true, focused: true }}
            >
              <EpicSurface epicId={EPIC_ID} tabId={TAB_ID} />
            </TabSurfaceActivityProvider>
          }
          mainTail={null}
          tail={null}
        />,
      );

      // One-sheet design: no tray wrapper, so the frame is `<main>`'s own
      // direct child.
      const frame = document.querySelector<HTMLElement>(
        "[data-layout-column] main > div",
      );
      if (frame === null) throw new Error("surface frame not rendered");
      // The beside-left/beside-right utilities are gone: every placement
      // gets the same plain `task-surface-frame`.
      expect(frame.classList.contains("md:task-surface-frame")).toBe(true);
      const sheets = [
        ...frame.querySelectorAll<HTMLElement>("[data-shell-sheet]"),
      ];
      expect(sheets.map((sheet) => sheet.dataset.shellSheet)).toEqual(["task"]);
    },
  );

  it("agrees across two split panes, since the side is global", () => {
    act(() => {
      useLayoutStore.setState({
        arrangement: { ...DEFAULT_ARRANGEMENT, sidebarSide: "right" },
      });
    });

    render(
      <>
        <TabSurfaceActivityProvider activity={{ visible: true, focused: true }}>
          <EpicSurface epicId="epic-a" tabId="tab-a" />
        </TabSurfaceActivityProvider>
        <TabSurfaceActivityProvider
          activity={{ visible: true, focused: false }}
        >
          <EpicSurface epicId="epic-b" tabId="tab-b" />
        </TabSurfaceActivityProvider>
      </>,
    );

    expect(surfaceChildTestIds("tab-a")[0]).toBe("epic-canvas-body-tab-a");
    expect(surfaceChildTestIds("tab-b")[0]).toBe("epic-canvas-body-tab-b");
  });
});

describe("useColumnOverlayPlacement() (D7)", () => {
  function Probe(props: { readonly anchor: "top" | "row" | "foot" }) {
    const placement = useColumnOverlayPlacement(props.anchor);
    return (
      <div
        data-testid="overlay-placement-probe"
        data-side={placement?.side ?? "null"}
        data-align={placement?.align ?? "null"}
      />
    );
  }

  it.each(["top", "row", "foot"] as const)(
    "pins null outside a column, anchor=%s",
    (anchor) => {
      render(<Probe anchor={anchor} />);
      const probe = screen.getByTestId("overlay-placement-probe");
      expect(probe.dataset.side).toBe("null");
      expect(probe.dataset.align).toBe("null");
    },
  );

  it.each([
    ["top", "start"],
    ["row", "start"],
    ["foot", "end"],
  ] as const)(
    "opens toward the content for a left column, anchor=%s",
    (anchor, align) => {
      render(
        <ColumnEdgeContext.Provider value="left">
          <Probe anchor={anchor} />
        </ColumnEdgeContext.Provider>,
      );
      const probe = screen.getByTestId("overlay-placement-probe");
      expect(probe.dataset.side).toBe("right");
      expect(probe.dataset.align).toBe(align);
    },
  );

  it.each([
    ["top", "start"],
    ["row", "start"],
    ["foot", "end"],
  ] as const)("mirrors for a right column, anchor=%s", (anchor, align) => {
    render(
      <ColumnEdgeContext.Provider value="right">
        <Probe anchor={anchor} />
      </ColumnEdgeContext.Provider>,
    );
    const probe = screen.getByTestId("overlay-placement-probe");
    expect(probe.dataset.side).toBe("left");
    expect(probe.dataset.align).toBe(align);
  });
});

describe("<EpicLeftPanelStaticRail /> indicator mirror (S-06)", () => {
  it("mirrors the active indicator's edge for a right-docked sidebar", async () => {
    // Bypasses the module-level stub above to render the REAL rail: this is
    // the one place in this suite that checks the rail's own DOM, not the
    // column's fragment order.
    const { EpicLeftPanelStaticRail } = await vi.importActual<
      typeof import("@/components/epic-canvas/sidebar/epic-sidebar-rail")
    >("@/components/epic-canvas/sidebar/epic-sidebar-rail");

    render(
      <TooltipProvider>
        <ColumnEdgeContext.Provider value="right">
          <EpicLeftPanelStaticRail
            epicId={EPIC_ID}
            tabId={TAB_ID}
            orientation="vertical"
          />
        </ColumnEdgeContext.Provider>
      </TooltipProvider>,
    );

    // "chats" is the default active panel (DEFAULT_LEFT_PANEL_ID).
    const activeButton = screen.getByTestId("epic-rail-chats");
    const indicator = activeButton.querySelector(
      ".pointer-events-none.rounded-full.bg-primary",
    );
    if (indicator === null) throw new Error("active indicator not found");
    expect(indicator.className).toContain("right-0");
    expect(indicator.className).toContain("rounded-r-none");
    expect(indicator.className).not.toContain("left-0");

    // The rail's tiles are `HoverCard appearance="tooltip"` (ui/hover-card.tsx,
    // on Floating UI): `useFocus` opens with no hover delay, the one open path
    // this suite can trigger synchronously in jsdom (see hover-card.test.tsx's
    // note on `visibleOnly` and jsdom's `:focus-visible`). `role="tooltip"`
    // lands on the outer floating wrapper `useRole` attaches to; the `data-*`
    // attributes this test reads are on the inner content node.
    fireEvent.focus(activeButton);
    const tooltip = screen.getByRole("tooltip");
    const content = tooltip.querySelector('[data-slot="hover-card-content"]');
    if (content === null) throw new Error("expected hover card content");
    expect(content.getAttribute("data-side")).toBe("left");
    expect(content.getAttribute("data-align")).toBe("start");
  });
});

describe("a real sidebar popover under a right sidebar (D7)", () => {
  it("opens ChatFilterMenu's content on data-side=left, not the hard-coded right", async () => {
    render(
      <ColumnEdgeContext.Provider value="right">
        <ChatFilterMenu epicId={EPIC_ID} tabId={TAB_ID} canArchive={false} />
      </ColumnEdgeContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Filter agents" }));

    const menu = await screen.findByTestId("epic-sidebar-agent-view-menu");
    expect(menu.getAttribute("data-side")).toBe("left");
    expect(menu.getAttribute("data-align")).toBe("start");
  });
});
