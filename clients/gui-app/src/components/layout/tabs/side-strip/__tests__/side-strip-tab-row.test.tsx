/**
 * `useSideTabJoin` (D3): the edge and PANE a row/tile/pair joins its task
 * sheet on, gated on the row being WHOLLY inside its row list. A row scrolled
 * partly out is clipped by the scroller, so the join has to fall back to a
 * plain active row rather than draw a bridge the list would cut in half.
 *
 * The pane is "panel" when the active tab is an epic tab on the strip's own
 * side and its sidebar is expanded, "rail" when that sidebar is collapsed,
 * and "canvas" for every other case - a non-epic tab, or an epic tab whose
 * sidebar sits on the OTHER edge, where the strip meets the content pane
 * instead.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { ColumnEdgeContext } from "@/components/layout/column-edge-context";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import type { EdgeSide } from "@/lib/layout/layout-arrangement";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import {
  DEFAULT_SIDEBAR_WIDTH_PX,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";
import type { HeaderTab } from "@/stores/tabs/types";
import { SheetJoinBridge, SheetJoinScope } from "../../sheet-join";
import { joinedAttribute, useSideTabJoin } from "../side-tab-join";

/** A controllable stand-in for the real `IntersectionObserver` (jsdom has none). */
type ObserverEntryLike = { readonly intersectionRatio: number };
type ObserverCallback = (entries: ReadonlyArray<ObserverEntryLike>) => void;
let activeObserverCallbacks: Array<ObserverCallback> = [];

class ControllableIntersectionObserver {
  private readonly callback: ObserverCallback;
  constructor(callback: ObserverCallback) {
    this.callback = callback;
    activeObserverCallbacks.push(callback);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    activeObserverCallbacks = activeObserverCallbacks.filter(
      (registered) => registered !== this.callback,
    );
  }
  takeRecords(): ReadonlyArray<ObserverEntryLike> {
    return [];
  }
}

function reportRatio(ratio: number): void {
  act(() => {
    for (const callback of activeObserverCallbacks) {
      callback([{ intersectionRatio: ratio }]);
    }
  });
}

const EDGES: ReadonlyArray<EdgeSide> = ["left", "right"];

const EPIC_TAB: Extract<HeaderTab, { kind: "epic" }> = {
  kind: "epic",
  id: "e-joined",
  epicId: "e-joined",
  hostId: null,
  route: "/epics/e-joined",
  name: "Joined epic",
  icon: null,
  canClose: true,
  canDuplicate: false,
  canOpenInNewWindow: false,
  appearance: null,
};

/** The layout editor's session tab: its own solid amber object, never joined (audit F2). */
const SAMPLE_WORKSPACE_TAB: Extract<HeaderTab, { kind: "sample-workspace" }> = {
  kind: "sample-workspace",
  id: "s-session",
  route: "/sample-workspace/s-session",
  name: "Sample workspace",
  icon: null,
  canDuplicate: false,
  canOpenInNewWindow: false,
};

const DRAFT_TAB: Extract<HeaderTab, { kind: "draft" }> = {
  kind: "draft",
  id: "d-joined",
  route: "/draft/d-joined",
  name: "Draft",
  icon: null,
  canDuplicate: false,
  canOpenInNewWindow: false,
  appearance: null,
};

/** The hook's own caller: a CHILD of the edge provider, as a real row is. */
function Row(props: {
  readonly tab: HeaderTab | null;
  readonly active: boolean;
}): ReactNode {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const join = useSideTabJoin(props.active, node, props.tab);
  return <div ref={setNode} data-testid="row" {...joinedAttribute(join)} />;
}

/** Mounts the hook under a real row list ancestor, at the given edge. */
function Harness(props: {
  readonly edge: EdgeSide;
  readonly tab?: HeaderTab | null;
  readonly active?: boolean;
}): ReactNode {
  return (
    <ColumnEdgeContext.Provider value={props.edge}>
      <SheetJoinScope>
        <div data-strip-axis="y">
          <Row tab={props.tab ?? null} active={props.active ?? true} />
        </div>
        <SheetJoinBridge edge={props.edge} />
      </SheetJoinScope>
    </ColumnEdgeContext.Provider>
  );
}

/** The strip's bridge: its published state must track the row's join. */
function bridge(): HTMLElement {
  const found = document.querySelector<HTMLElement>("[data-sheet-join-bridge]");
  if (found === null) throw new Error("Expected the join bridge");
  return found;
}

function joinedEdge(): string | undefined {
  return screen.getByTestId("row").dataset.sheetJoined;
}

function joinedPane(): string | undefined {
  return screen.getByTestId("row").dataset.joinPane;
}

function resetStores(): void {
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useEpicDndStore.setState(useEpicDndStore.getInitialState(), true);
  useLeftPanelStore.setState({
    mainCollapsedByTabId: {},
    sidebarWidthPx: DEFAULT_SIDEBAR_WIDTH_PX,
  });
  activeObserverCallbacks = [];
}

beforeEach(resetStores);

afterEach(() => {
  cleanup();
  resetStores();
});

describe("useSideTabJoin", () => {
  it("starts joined, un-joins once the observed row falls below full intersection, and re-joins at ratio 1", () => {
    const restore = Object.getOwnPropertyDescriptor(
      globalThis,
      "IntersectionObserver",
    );
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      writable: true,
      value: ControllableIntersectionObserver,
    });

    render(<Harness edge="left" />);

    // Starts true, so the row joins on its first frame before any report.
    expect(joinedEdge()).toBe("left");
    expect(bridge().hasAttribute("data-join-active")).toBe(true);

    // Clipped: the row falls back to a plain active row, and the bridge the
    // list cannot clip goes with it.
    reportRatio(0.4);
    expect(joinedEdge()).toBeUndefined();
    expect(bridge().hasAttribute("data-join-active")).toBe(false);
    expect(bridge().hasAttribute("data-join-pane")).toBe(false);

    reportRatio(1);
    expect(joinedEdge()).toBe("left");
    expect(bridge().hasAttribute("data-join-active")).toBe(true);

    if (restore === undefined) {
      Reflect.deleteProperty(globalThis, "IntersectionObserver");
    } else {
      Object.defineProperty(globalThis, "IntersectionObserver", restore);
    }
  });

  it("joins as before when IntersectionObserver is unavailable (never watches, never un-joins)", () => {
    const restore = Object.getOwnPropertyDescriptor(
      globalThis,
      "IntersectionObserver",
    );
    Reflect.deleteProperty(globalThis, "IntersectionObserver");

    render(<Harness edge="left" />);

    expect(joinedEdge()).toBe("left");

    if (restore !== undefined) {
      Object.defineProperty(globalThis, "IntersectionObserver", restore);
    }
  });

  it("joins on the strip's own edge, whichever edge that is", () => {
    render(<Harness edge="right" />);
    expect(joinedEdge()).toBe("right");
  });

  it("keeps its join while a different header tab is dragged elsewhere, exactly one joined row", () => {
    render(<Harness edge="left" />);
    expect(joinedEdge()).toBe("left");

    act(() => {
      useEpicDndStore.getState().headerTabDragStarted(
        {
          kind: "header-tab",
          stripItemId: "dragged-item",
          tabKind: "epic",
          tabId: "e-dragged",
          index: 0,
        },
        { width: 120, height: 36 },
        "x",
        null,
      );
    });

    // Settled behavior: the hook itself has no drag-state check of its own -
    // only the CALLER'S `active` param (in production, `isActive &&
    // !item.isDragging`, so only THIS row's own pickup ungates it) can turn
    // the join off. A drag started elsewhere, for an unrelated strip item,
    // must not touch an already-active row's join.
    expect(joinedEdge()).toBe("left");
    expect(document.querySelectorAll("[data-sheet-joined]")).toHaveLength(1);
  });

  describe("pane", () => {
    it("is canvas for a non-epic tab, even on the sidebar's own edge", () => {
      act(() => {
        useLayoutStore.setState({
          arrangement: { ...DEFAULT_ARRANGEMENT, sidebarSide: "left" },
        });
      });

      render(<Harness edge="left" tab={DRAFT_TAB} />);

      expect(joinedEdge()).toBe("left");
      expect(joinedPane()).toBe("canvas");
      expect(bridge().getAttribute("data-join-pane")).toBe("canvas");
    });

    it("is canvas for an epic tab when the strip sits on the OTHER edge from the sidebar", () => {
      act(() => {
        useLayoutStore.setState({
          arrangement: { ...DEFAULT_ARRANGEMENT, sidebarSide: "right" },
        });
      });

      render(<Harness edge="left" tab={EPIC_TAB} />);

      expect(joinedEdge()).toBe("left");
      expect(joinedPane()).toBe("canvas");
    });

    it("is panel for an epic tab on the sidebar's own edge, expanded", () => {
      act(() => {
        useLayoutStore.setState({
          arrangement: { ...DEFAULT_ARRANGEMENT, sidebarSide: "left" },
        });
      });

      render(<Harness edge="left" tab={EPIC_TAB} />);

      expect(joinedEdge()).toBe("left");
      expect(joinedPane()).toBe("panel");
      expect(bridge().getAttribute("data-join-pane")).toBe("panel");
    });

    it("is rail for an epic tab on the sidebar's own edge, collapsed", () => {
      act(() => {
        useLayoutStore.setState({
          arrangement: { ...DEFAULT_ARRANGEMENT, sidebarSide: "left" },
        });
        useLeftPanelStore.setState({
          mainCollapsedByTabId: { [EPIC_TAB.id]: true },
        });
      });

      render(<Harness edge="left" tab={EPIC_TAB} />);

      expect(joinedEdge()).toBe("left");
      expect(joinedPane()).toBe("rail");
      expect(bridge().getAttribute("data-join-pane")).toBe("rail");
    });

    // The whole rule, written out as a table rather than computed: the join
    // draws on the strip's own edge whatever side the sidebar is on, and takes
    // the pane's fill only when the sidebar is on that same edge. This is the
    // matrix the sheet-join browser driver used to walk one page load at a
    // time (side x strip x panel x split); which fill a join takes is decided
    // here, and the browser spec only measures where the arcs land.
    const EPIC_PANES: ReadonlyArray<{
      readonly edge: EdgeSide;
      readonly sidebar: EdgeSide;
      readonly collapsed: boolean;
      readonly pane: "panel" | "rail" | "canvas";
    }> = [
      { edge: "left", sidebar: "left", collapsed: false, pane: "panel" },
      { edge: "left", sidebar: "left", collapsed: true, pane: "rail" },
      { edge: "left", sidebar: "right", collapsed: false, pane: "canvas" },
      { edge: "left", sidebar: "right", collapsed: true, pane: "canvas" },
      { edge: "right", sidebar: "right", collapsed: false, pane: "panel" },
      { edge: "right", sidebar: "right", collapsed: true, pane: "rail" },
      { edge: "right", sidebar: "left", collapsed: false, pane: "canvas" },
      { edge: "right", sidebar: "left", collapsed: true, pane: "canvas" },
    ];

    it.each(EPIC_PANES)(
      "an epic tab on the $edge strip, sidebar $sidebar, panel collapsed=$collapsed: joins $edge on the $pane pane",
      ({ edge, sidebar, collapsed, pane }) => {
        act(() => {
          useLayoutStore.setState({
            arrangement: { ...DEFAULT_ARRANGEMENT, sidebarSide: sidebar },
          });
          useLeftPanelStore.setState({
            mainCollapsedByTabId: collapsed ? { [EPIC_TAB.id]: true } : {},
          });
        });

        render(<Harness edge={edge} tab={EPIC_TAB} />);

        expect(joinedEdge()).toBe(edge);
        expect(joinedPane()).toBe(pane);
      },
    );

    it.each(EDGES)(
      "a non-epic tab on the %s strip is on the canvas even beside a collapsed panel on its own edge",
      (edge) => {
        act(() => {
          useLayoutStore.setState({
            arrangement: { ...DEFAULT_ARRANGEMENT, sidebarSide: edge },
          });
          useLeftPanelStore.setState({
            mainCollapsedByTabId: { [DRAFT_TAB.id]: true },
          });
        });

        render(<Harness edge={edge} tab={DRAFT_TAB} />);

        expect(joinedEdge()).toBe(edge);
        expect(joinedPane()).toBe("canvas");
      },
    );
  });

  // Each case also reads the bridge: a row that draws no join must not
  // publish one either, or the bridge paints a join no row owns.
  describe("never joined", () => {
    it.each(EDGES)(
      "the layout editor's session tab on the %s strip draws a plain active row, and its bridge stays inactive: its solid amber fill must not be painted over",
      (edge) => {
        render(<Harness edge={edge} tab={SAMPLE_WORKSPACE_TAB} />);

        expect(joinedEdge()).toBeUndefined();
        expect(bridge().hasAttribute("data-join-active")).toBe(false);
      },
    );

    it.each(EDGES)(
      "an inactive row on the %s strip draws no join, an epic tab included, and its bridge stays inactive",
      (edge) => {
        render(<Harness edge={edge} tab={EPIC_TAB} active={false} />);

        expect(joinedEdge()).toBeUndefined();
        expect(bridge().hasAttribute("data-join-active")).toBe(false);
      },
    );

    it("a row outside any strip's column draws no join and publishes none: with no edge provider the edge is null", () => {
      // The same active epic row the matrix above joins, minus the edge
      // provider: `ColumnEdgeContext` answers its default, `null`, so there
      // is no edge to join on.
      render(
        <SheetJoinScope>
          <div data-strip-axis="y">
            <Row tab={EPIC_TAB} active />
          </div>
          <SheetJoinBridge edge="left" />
        </SheetJoinScope>,
      );

      expect(joinedEdge()).toBeUndefined();
      expect(bridge().hasAttribute("data-join-active")).toBe(false);
    });
  });
});
