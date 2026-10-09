import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelLayoutDrag,
  layoutDragActive,
} from "@/components/layout-editor/canvas/drag-engine";
import { useLayoutCanvas } from "@/components/layout-editor/canvas/layout-canvas";
import { LAYOUT_CLUSTER_ATTRIBUTE } from "@/components/layout-editor/canvas/region-drag";
import { LeftPanelRailDivider } from "@/components/epic-canvas/sidebar/left-panel-rail-divider";
import { useLayoutRegion } from "@/components/layout-editor/use-layout-region";
import {
  useLayoutSettingPart,
  useLayoutSurface,
} from "@/components/layout-editor/use-layout-surface";
import { SIDE_STRIP_VIEW_AT_TOP } from "@/components/layout-editor/regions/region-grammar";
import { railDividerId } from "@/lib/layout/rail";
import type { RegionId } from "@/lib/layout/region-id";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The canvas half of ticket 09 (D14): selecting the tab strip and the sample
 * sidebar as SURFACES rather than regions, and dragging the selected one to
 * an edge. Mirrors `layout-canvas.test.tsx`'s own harness shape - a bare
 * column handed to the hook, real region/rail-divider members inside it -
 * with the two placement surfaces added alongside.
 */

function Region(props: {
  readonly regionId: RegionId;
  readonly instanceId: string | null;
  readonly testId: string;
}): ReactElement {
  const { ref } = useLayoutRegion({
    regionId: props.regionId,
    instanceId: props.instanceId,
  });
  return (
    <div ref={ref} data-testid={props.testId}>
      <span data-testid={`${props.testId}-inner`}>inner</span>
    </div>
  );
}

function SurfaceCanvas(): ReactElement {
  const [column, setColumn] = useState<HTMLElement | null>(null);
  useLayoutCanvas(column);
  const topBarRef = useLayoutSurface("topBar");
  const sidebarRef = useLayoutSurface("sidebar");
  return (
    <div ref={setColumn} data-layout-column data-testid="column">
      <div ref={topBarRef} role="tablist" data-testid="tab-strip">
        <Region regionId="homeTab" instanceId={null} testId="home" />
        <div data-testid="tab-strip-empty">empty</div>
      </div>
      <div data-testid="content-wrap">
        <aside
          ref={sidebarRef}
          aria-label="Sample sidebar"
          data-testid="sidebar"
        >
          <div {...{ [LAYOUT_CLUSTER_ATTRIBUTE]: "" }}>
            <Region
              regionId="railAgents"
              instanceId={null}
              testId="rail-agents"
            />
            <LeftPanelRailDivider
              dividerId={railDividerId(1)}
              orientation="vertical"
              editing
            />
          </div>
          <div data-testid="sidebar-empty">empty</div>
        </aside>
      </div>
    </div>
  );
}

/**
 * The strip plus Side tab view's own canvas part (D9, item B): a
 * `[data-layout-setting]` element inside the strip's own space, registered
 * exactly as `StripAgentGroup` registers it via `useLayoutSettingPart`
 * - a separate component from `SurfaceCanvas` above, rather than a prop on it,
 * so none of that component's many existing call sites need to change.
 */
function SurfaceCanvasWithSetting(): ReactElement {
  const [column, setColumn] = useState<HTMLElement | null>(null);
  useLayoutCanvas(column);
  const topBarRef = useLayoutSurface("topBar");
  const settingRef = useLayoutSettingPart("sideStripView");
  return (
    <div ref={setColumn} data-layout-column data-testid="column">
      <div ref={topBarRef} role="tablist" data-testid="tab-strip">
        <Region regionId="homeTab" instanceId={null} testId="home" />
        <div ref={settingRef} data-testid="setting-part">
          agents
        </div>
      </div>
    </div>
  );
}

function chip(): HTMLElement | null {
  const element = document.querySelector("[data-layout-hover-chip]");
  return element instanceof HTMLElement ? element : null;
}

/** The pointer the canvas decorates for: a mouse, never a touch (C-09). */
const MOUSE = { pointerType: "mouse" } as const;

function openSession(): void {
  act(() => {
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });
  });
}

function ring(): HTMLElement | null {
  const element = document.querySelector("[data-layout-selection-ring]");
  return element instanceof HTMLElement ? element : null;
}

function movable(node: HTMLElement, rect: DOMRect): (next: DOMRect) => void {
  let current = rect;
  node.getBoundingClientRect = (): DOMRect => current;
  return (next) => {
    current = next;
  };
}

async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

async function flushFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await flushFrame();
}

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function historyDepth(): number {
  return useLayoutEditorStore.getState().history.past.length;
}

beforeEach(() => {
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
  useLayoutEditorStore.setState({
    instances: new Map(),
    surfaceNodes: new Map(),
  });
});

afterEach(() => {
  cancelLayoutDrag();
  cleanup();
  useLayoutEditorStore.getState().endSession();
  document.documentElement.removeAttribute("data-reduce-panel-motion");
});

describe("selecting a placement surface from its own space", () => {
  it("selects topBar from a pointerdown on the strip's own space", () => {
    openSession();
    const view = render(<SurfaceCanvas />);

    fireEvent.pointerDown(view.getByTestId("tab-strip-empty"), { button: 0 });

    expect(useLayoutEditorStore.getState().selectedSurface).toBe("topBar");
    expect(useLayoutEditorStore.getState().selected).toBeNull();
  });

  it("selects sidebar from a pointerdown on the sample aside's own space", () => {
    openSession();
    const view = render(<SurfaceCanvas />);

    fireEvent.pointerDown(view.getByTestId("sidebar-empty"), { button: 0 });

    expect(useLayoutEditorStore.getState().selectedSurface).toBe("sidebar");
    expect(useLayoutEditorStore.getState().selected).toBeNull();
  });

  it.each([
    {
      within: "the strip",
      space: "tab-strip-empty",
      surface: "topBar",
      pressed: "home-inner",
      region: "homeTab",
    },
    {
      within: "the sidebar",
      space: "sidebar-empty",
      surface: "sidebar",
      pressed: "rail-agents-inner",
      region: "railAgents",
    },
  ] as const)(
    "selects the region, not the surface, from a press on a region inside $within",
    ({ space, surface, pressed, region }) => {
      openSession();
      const view = render(<SurfaceCanvas />);
      // Select the surface first, so the region press's own-behaviour claim -
      // that it clears rather than ignores a standing surface - is exercised.
      fireEvent.pointerDown(view.getByTestId(space), { button: 0 });
      expect(useLayoutEditorStore.getState().selectedSurface).toBe(surface);

      fireEvent.pointerDown(view.getByTestId(pressed), { button: 0 });

      expect(useLayoutEditorStore.getState().selected).toBe(region);
      expect(useLayoutEditorStore.getState().selectedSurface).toBeNull();
    },
  );

  it("selects neither region nor surface from a press on a rail divider, which is a member", () => {
    openSession();
    const view = render(<SurfaceCanvas />);
    fireEvent.pointerDown(view.getByTestId("sidebar-empty"), { button: 0 });
    expect(useLayoutEditorStore.getState().selectedSurface).toBe("sidebar");

    fireEvent.pointerDown(view.getByTestId("epic-rail-divider"), { button: 0 });

    expect(useLayoutEditorStore.getState().selected).toBeNull();
    expect(useLayoutEditorStore.getState().selectedSurface).toBeNull();
    expect(layoutDragActive()).toBe(true);
  });
});

describe("select(region) and selectSurface are mutually exclusive", () => {
  it("selecting a region clears a selected surface, and back", () => {
    openSession();
    act(() => {
      useLayoutEditorStore.getState().selectSurface("topBar");
    });
    expect(useLayoutEditorStore.getState().selectedSurface).toBe("topBar");

    act(() => {
      useLayoutEditorStore.getState().select("homeTab");
    });
    expect(useLayoutEditorStore.getState().selected).toBe("homeTab");
    expect(useLayoutEditorStore.getState().selectedSurface).toBeNull();

    act(() => {
      useLayoutEditorStore.getState().selectSurface("sidebar");
    });
    expect(useLayoutEditorStore.getState().selectedSurface).toBe("sidebar");
    expect(useLayoutEditorStore.getState().selected).toBeNull();
  });
});

describe("the ring on a selected surface (L-90)", () => {
  it("tracks the surface's registered node", async () => {
    document.documentElement.setAttribute("data-reduce-panel-motion", "");
    openSession();
    const view = render(<SurfaceCanvas />);
    movable(view.getByTestId("tab-strip"), rect(10, 50, 400, 32));

    act(() => {
      useLayoutEditorStore.getState().selectSurface("topBar");
    });
    await flushFrames(2);

    expect(ring()?.hidden).toBe(false);
    expect(ring()?.style.transform).toBe("translate(7.00px, 47.00px)");
  });

  it("holds its place, rather than hiding, while the selected surface has no registered node", async () => {
    document.documentElement.setAttribute("data-reduce-panel-motion", "");
    openSession();
    const view = render(<SurfaceCanvas />);
    movable(view.getByTestId("tab-strip"), rect(10, 50, 400, 32));
    act(() => {
      useLayoutEditorStore.getState().selectSurface("topBar");
    });
    await flushFrames(2);
    const before = ring()?.style.transform;
    expect(ring()?.hidden).toBe(false);

    // The strip un-registers (a remount mid placement-write, L-90) while it
    // stays the selection.
    act(() => {
      useLayoutEditorStore.setState({ surfaceNodes: new Map() });
    });
    await flushFrame();

    expect(ring()?.style.transform).toBe(before);
    expect(ring()?.hidden).toBe(false);
  });
});

describe("dragging a selected surface to an edge writes the placement as one gesture", () => {
  it("drags the tab strip to the right edge, writing tabStripPlacement once, undoably", () => {
    openSession();
    const view = render(<SurfaceCanvas />);
    view.getByTestId("column").getBoundingClientRect = () =>
      rect(0, 0, 800, 600);

    fireEvent.pointerDown(view.getByTestId("tab-strip-empty"), {
      button: 0,
      pointerId: 1,
      clientX: 400,
      clientY: 16,
    });
    expect(useLayoutEditorStore.getState().selectedSurface).toBe("topBar");

    // Crosses the 6px activation threshold.
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        clientX: 400,
        clientY: 10,
      }),
    );
    // Solidly inside the right band of an 800x600 column.
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        clientX: 780,
        clientY: 300,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }),
    );

    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe(
      "right",
    );
    expect(historyDepth()).toBe(1);

    useLayoutEditorStore.getState().undo();
    expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe("top");
  });

  it("drags the sidebar to the right edge, writing sidebarSide once, undoably", () => {
    openSession();
    const view = render(<SurfaceCanvas />);
    view.getByTestId("content-wrap").getBoundingClientRect = () =>
      rect(0, 0, 400, 600);

    fireEvent.pointerDown(view.getByTestId("sidebar-empty"), {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 300,
    });
    expect(useLayoutEditorStore.getState().selectedSurface).toBe("sidebar");

    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        clientX: 16,
        clientY: 300,
      }),
    );
    // Solidly inside the right band of a 400-wide content wrap.
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        clientX: 390,
        clientY: 300,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }),
    );

    expect(useLayoutStore.getState().arrangement.sidebarSide).toBe("right");
    expect(historyDepth()).toBe(1);

    useLayoutEditorStore.getState().undo();
    expect(useLayoutStore.getState().arrangement.sidebarSide).toBe("left");
  });
});

describe("Side tab view's own part on the canvas (D9, item B)", () => {
  it("a pointerdown on a [data-layout-setting] element inside the strip selects the setting, not the topBar surface", () => {
    openSession();
    const view = render(<SurfaceCanvasWithSetting />);

    fireEvent.pointerDown(view.getByTestId("setting-part"), { button: 0 });

    expect(useLayoutEditorStore.getState().selectedSetting).toBe(
      "sideStripView",
    );
    expect(useLayoutEditorStore.getState().selectedSurface).toBeNull();
    expect(useLayoutEditorStore.getState().selected).toBeNull();
  });

  it("hovering the part shows the chip on its own node, naming the current option", () => {
    openSession();
    const view = render(<SurfaceCanvasWithSetting />);

    fireEvent.pointerMove(view.getByTestId("setting-part"), MOUSE);

    expect(useLayoutEditorStore.getState().hoveredSetting).toBe(
      "sideStripView",
    );
    expect(chip()?.textContent).toBe("Side tab view · Tabs only");
    expect(chip()?.hidden).toBe(false);
  });

  it("with no part registered (top placement), the chip goes on the topBar surface and names the reason", () => {
    openSession();
    render(<SurfaceCanvas />);

    act(() => {
      useLayoutEditorStore.getState().setHoveredSetting("sideStripView");
    });

    expect(chip()?.textContent).toBe(
      `Side tab view · ${SIDE_STRIP_VIEW_AT_TOP}`,
    );
    expect(chip()?.getAttribute("data-placement")).toBe("below");
  });
});
