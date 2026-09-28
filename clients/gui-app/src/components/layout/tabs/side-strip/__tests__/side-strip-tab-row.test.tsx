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
function Row(props: { readonly tab: HeaderTab | null }): ReactNode {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const join = useSideTabJoin(true, node, props.tab);
  return <div ref={setNode} data-testid="row" {...joinedAttribute(join)} />;
}

/** Mounts the hook under a real row list ancestor, at the given edge. */
function Harness(props: {
  readonly edge: EdgeSide;
  readonly tab?: HeaderTab | null;
}): ReactNode {
  return (
    <ColumnEdgeContext.Provider value={props.edge}>
      <div data-strip-axis="y">
        <Row tab={props.tab ?? null} />
      </div>
    </ColumnEdgeContext.Provider>
  );
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

    reportRatio(0.4);
    expect(joinedEdge()).toBeUndefined();

    reportRatio(1);
    expect(joinedEdge()).toBe("left");

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
    });
  });
});
