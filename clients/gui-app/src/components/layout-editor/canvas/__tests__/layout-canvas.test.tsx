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
import { railDividerId } from "@/lib/layout/rail";
import type { RegionId } from "@/lib/layout/region-id";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The app column plus two regions, mounted the way ticket 07's shell will
 * mount them: the hook is handed the column element and nothing else.
 */
function Canvas(props: {
  readonly regions: ReadonlyArray<{
    readonly regionId: RegionId;
    readonly instanceId: string | null;
    readonly testId: string;
  }>;
}): ReactElement {
  const [column, setColumn] = useState<HTMLElement | null>(null);
  useLayoutCanvas(column);
  return (
    // `data-layout-column` exactly as `app-shell.tsx` writes it, on the node
    // the hook is handed: the editing outline is one CSS rule on
    // `[data-layout-column][data-layout-editing="1"]`, so the two attributes
    // have to land on ONE element for it to ever draw.
    <div ref={setColumn} data-layout-column data-testid="column">
      {props.regions.map((region) => (
        <Region key={region.testId} {...region} />
      ))}
    </div>
  );
}

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

/**
 * The sidebar's icon column, with the real boundary element in it: the one
 * member of a canvas order group that is NOT a region (L-115).
 */
function RailCanvas(): ReactElement {
  const [column, setColumn] = useState<HTMLElement | null>(null);
  useLayoutCanvas(column);
  return (
    <div ref={setColumn} data-layout-column data-testid="column">
      <div {...{ [LAYOUT_CLUSTER_ATTRIBUTE]: "" }}>
        <Region regionId="railAgents" instanceId={null} testId="rail-agents" />
        <LeftPanelRailDivider
          dividerId={railDividerId(1)}
          orientation="vertical"
          editing
        />
        <Region
          regionId="railTerminals"
          instanceId={null}
          testId="rail-terminals"
        />
      </div>
    </div>
  );
}

/**
 * A column with a region PART drawn BEFORE its registered node - the sample
 * picker's footer (`data-layout-region-part`), which hovers and selects the
 * region without being the node every lookup by name has to find.
 */
function PartCanvas(props: {
  readonly regionId: RegionId;
  readonly instanceId: string | null;
  readonly testId: string;
}): ReactElement {
  const [column, setColumn] = useState<HTMLElement | null>(null);
  useLayoutCanvas(column);
  return (
    <div ref={setColumn} data-layout-column data-testid="column">
      <div data-layout-region-part={props.regionId} data-testid="part">
        <span data-testid="part-inner">part</span>
      </div>
      <Region {...props} />
    </div>
  );
}

/**
 * A column with a fixed-chrome cue - the Message queue's own boundary
 * (`chat-lower-dock.tsx`) - and no region under it, the way the real dock
 * frame draws it.
 */
function CueCanvas(): ReactElement {
  const [column, setColumn] = useState<HTMLElement | null>(null);
  useLayoutCanvas(column);
  return (
    <div ref={setColumn} data-layout-column data-testid="column">
      <div data-layout-cue="Message queue · Always here" data-testid="queue">
        <span data-testid="queue-inner">queue</span>
      </div>
    </div>
  );
}

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

function chip(): HTMLElement | null {
  const element = document.querySelector("[data-layout-hover-chip]");
  return element instanceof HTMLElement ? element : null;
}

function ring(): HTMLElement | null {
  const element = document.querySelector("[data-layout-selection-ring]");
  return element instanceof HTMLElement ? element : null;
}

/** The pointer the canvas decorates for: a mouse, never a touch (C-09). */
const MOUSE = { pointerType: "mouse" } as const;

/**
 * A node whose viewport box is a mutable fact, which is what a reflow is.
 */
function movable(node: HTMLElement, rect: DOMRect): (next: DOMRect) => void {
  let current = rect;
  node.getBoundingClientRect = (): DOMRect => current;
  return (next) => {
    current = next;
  };
}

/**
 * The ring places itself on its first animation frame, so its box is a fact
 * about the frame after `track`, never about the call.
 */
async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

beforeEach(() => {
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
  useLayoutEditorStore.setState({ instances: new Map() });
});

afterEach(() => {
  cancelLayoutDrag();
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

describe("the session's canvas", () => {
  it("mounts nothing until a session opens, and leaves nothing behind", () => {
    const view = render(
      <Canvas
        regions={[{ regionId: "minimap", instanceId: "tile-a", testId: "map" }]}
      />,
    );
    expect(chip()).toBeNull();
    expect(ring()).toBeNull();
    expect(view.getByTestId("column").hasAttribute("data-layout-editing")).toBe(
      false,
    );

    openSession();

    expect(chip()).not.toBeNull();
    expect(ring()).not.toBeNull();
    expect(view.getByTestId("column").getAttribute("data-layout-editing")).toBe(
      "1",
    );
    // The editing outline (L-87) is ONE rule on
    // `[data-layout-column][data-layout-editing="1"]`, so the compound
    // selector has to resolve to the column itself - not the document
    // element, a wrapper or a descendant.
    expect([
      ...document.querySelectorAll(
        '[data-layout-column][data-layout-editing="1"]',
      ),
    ]).toEqual([view.getByTestId("column")]);

    act(() => {
      useLayoutEditorStore.getState().endSession();
    });

    expect(chip()).toBeNull();
    expect(ring()).toBeNull();
    expect(view.getByTestId("column").hasAttribute("data-layout-editing")).toBe(
      false,
    );
  });

  it("resolves a pointer inside a region to the region, not to the node under it", () => {
    openSession();
    const view = render(
      <Canvas
        regions={[{ regionId: "minimap", instanceId: "tile-a", testId: "map" }]}
      />,
    );

    fireEvent.pointerMove(view.getByTestId("map-inner"), MOUSE);

    expect(useLayoutEditorStore.getState().hovered).toBe("minimap");
    // The name AND the state the region is in, which is the question hovering
    // asks (C-05). The name alone labelled something already under the pointer.
    expect(chip()?.textContent).toBe("Minimap · Right");
    expect(chip()?.hidden).toBe(false);
  });

  // The chip names the state the region is in RIGHT NOW, so a write while the
  // pointer is resting on the region has to move it. This is the one thing
  // that can go wrong now that the label is remembered between paints instead
  // of rebuilding all 23 regions' values on each one (R1-11).
  it("moves the chip's state word when the layout is written under the pointer", () => {
    openSession();
    const view = render(
      <Canvas
        regions={[{ regionId: "minimap", instanceId: "tile-a", testId: "map" }]}
      />,
    );
    fireEvent.pointerMove(view.getByTestId("map-inner"), MOUSE);
    expect(chip()?.textContent).toBe("Minimap · Right");

    act(() => {
      const layout = useLayoutStore.getState();
      layout.setArrangement({ ...layout.arrangement, minimapSide: "left" });
    });

    expect(chip()?.textContent).toBe("Minimap · Left");
  });

  it("refuses hover for a pointer that cannot rest on a region (C-09)", () => {
    openSession();
    const view = render(
      <Canvas
        regions={[{ regionId: "minimap", instanceId: "tile-a", testId: "map" }]}
      />,
    );

    fireEvent.pointerMove(view.getByTestId("map-inner"), {
      pointerType: "touch",
    });

    expect(useLayoutEditorStore.getState().hovered).toBeNull();
    expect(chip()?.hidden).toBe(true);
    expect(view.getByTestId("map").hasAttribute("data-hover")).toBe(false);
  });

  it("drops the hover decoration off the region it just selected (C-08)", () => {
    openSession();
    const view = render(
      <Canvas
        regions={[{ regionId: "minimap", instanceId: "tile-a", testId: "map" }]}
      />,
    );
    fireEvent.pointerMove(view.getByTestId("map-inner"), MOUSE);
    expect(view.getByTestId("map").getAttribute("data-hover")).toBe("1");

    fireEvent.pointerDown(view.getByTestId("map-inner"));
    // The pointer has not left, so `pointermove` keeps setting the hover; what
    // changes is that a selected region no longer WEARS it. Otherwise it wears
    // the ring, the outline and the chip at once.
    fireEvent.pointerMove(view.getByTestId("map-inner"), MOUSE);

    expect(view.getByTestId("map").hasAttribute("data-hover")).toBe(false);
    expect(view.getByTestId("map").getAttribute("data-selected")).toBe("1");
    expect(chip()?.hidden).toBe(true);
  });

  it("drops the hover on a pointer over the column's own chrome", () => {
    openSession();
    const view = render(
      <Canvas
        regions={[{ regionId: "minimap", instanceId: "tile-a", testId: "map" }]}
      />,
    );
    fireEvent.pointerMove(view.getByTestId("map-inner"), MOUSE);
    expect(useLayoutEditorStore.getState().hovered).toBe("minimap");

    fireEvent.pointerMove(view.getByTestId("column"), MOUSE);

    expect(useLayoutEditorStore.getState().hovered).toBeNull();
    expect(chip()?.hidden).toBe(true);
  });

  it("leaves a hover the inspector set alone while the pointer is outside the column", () => {
    openSession();
    render(
      <Canvas
        regions={[{ regionId: "minimap", instanceId: "tile-a", testId: "map" }]}
      />,
    );
    act(() => {
      useLayoutEditorStore.getState().setHovered("minimap");
    });

    fireEvent.pointerMove(document.body, MOUSE);

    expect(useLayoutEditorStore.getState().hovered).toBe("minimap");
  });

  it("puts a top-bar region's chip underneath it", () => {
    openSession();
    const view = render(
      <Canvas
        regions={[{ regionId: "homeTab", instanceId: null, testId: "home" }]}
      />,
    );

    fireEvent.pointerMove(view.getByTestId("home-inner"), MOUSE);

    expect(chip()?.getAttribute("data-placement")).toBe("below");
  });

  it("selects the region under a pointer press and drops keyboard navigation", async () => {
    openSession();
    useLayoutEditorStore.setState({ keyboardNav: true });
    const view = render(
      <Canvas
        regions={[{ regionId: "minimap", instanceId: "tile-a", testId: "map" }]}
      />,
    );

    fireEvent.pointerDown(view.getByTestId("map-inner"));

    expect(useLayoutEditorStore.getState().selected).toBe("minimap");
    expect(useLayoutEditorStore.getState().keyboardNav).toBe(false);
    await flushFrame();
    expect(ring()?.hidden).toBe(false);
  });

  // The shell on screen during an exit is a snapshot of where the elements
  // WERE, so a drag armed against it would measure boxes that are about to
  // move. The press still selects - that is L-69 - it just carries nothing.
  it("selects but arms no drag on a press while the session is leaving", () => {
    openSession();
    const view = render(
      <Canvas
        regions={[
          { regionId: "attachImage", instanceId: "tile-a", testId: "attach" },
        ]}
      />,
    );

    fireEvent.pointerDown(view.getByTestId("attach-inner"), { button: 0 });
    expect(layoutDragActive()).toBe(true);
    cancelLayoutDrag();

    act(() => {
      useLayoutEditorStore.setState({ leaving: true });
    });
    fireEvent.pointerDown(view.getByTestId("attach-inner"), { button: 0 });

    expect(useLayoutEditorStore.getState().selected).toBe("attachImage");
    expect(layoutDragActive()).toBe(false);
  });

  // A rail boundary is a member of the rail's order and nothing else (L-115),
  // so the press that picks it up cannot be resolved from a region - which is
  // why "what was pressed" and "what can be dragged" are two questions here.
  it("arms a drag on a rail boundary, which is a member and not a region", () => {
    openSession();
    const view = render(<RailCanvas />);

    fireEvent.pointerDown(view.getByTestId("epic-rail-divider"), {
      button: 0,
    });

    expect(useLayoutEditorStore.getState().selected).toBeNull();
    expect(layoutDragActive()).toBe(true);
  });

  it("puts the ring on one instance, and hides it with no selection", async () => {
    openSession();
    const view = render(
      <Canvas
        regions={[
          { regionId: "minimap", instanceId: "tile-a", testId: "a" },
          { regionId: "minimap", instanceId: "tile-b", testId: "b" },
        ]}
      />,
    );

    act(() => {
      useLayoutEditorStore.getState().select("minimap");
    });

    // The ring is drawn around ONE instance - the first registered; every
    // other instance carries the static outline instead (L-23).
    expect(view.getByTestId("a").getAttribute("data-layout-anchor")).toBe(
      "selected",
    );
    expect(view.getByTestId("b").getAttribute("data-layout-anchor")).toBeNull();
    expect(view.getByTestId("b").getAttribute("data-selected")).toBe("1");
    await flushFrame();
    expect(ring()?.hidden).toBe(false);

    act(() => {
      useLayoutEditorStore.getState().select(null);
    });

    expect(ring()?.hidden).toBe(true);
  });
});

/**
 * A region PART (L-... the sample picker's footer): it hovers and selects the
 * region it names, but every lookup by `data-layout-region` - and the ring and
 * chip's own anchoring - still finds the REGISTERED node, not the part.
 */
describe("a region part (data-layout-region-part)", () => {
  it("hovers and selects the region through the part", () => {
    openSession();
    const view = render(
      <PartCanvas regionId="model" instanceId="tile-a" testId="model" />,
    );

    fireEvent.pointerMove(view.getByTestId("part-inner"), MOUSE);
    expect(useLayoutEditorStore.getState().hovered).toBe("model");

    fireEvent.pointerDown(view.getByTestId("part-inner"));
    expect(useLayoutEditorStore.getState().selected).toBe("model");
  });

  it("anchors the hover chip and the selection ring to the registered node, not the part", async () => {
    openSession();
    const view = render(
      <PartCanvas regionId="model" instanceId="tile-a" testId="model" />,
    );
    // The part sits at jsdom's default zero rect; only the registered node's
    // box moves, so a chip or ring placed off the part would stay at zero.
    movable(view.getByTestId("model"), new DOMRect(700, 120, 200, 30));

    fireEvent.pointerMove(view.getByTestId("part-inner"), MOUSE);
    // jsdom's column is 0x0, so the chip's `left` clamps to the same 6px
    // whichever node it measured; `top` is the half that tells them apart
    // (114px off the node, 6px off the part).
    expect(chip()?.style.top).toBe("114px");

    fireEvent.pointerDown(view.getByTestId("part-inner"));
    await flushFrame();
    expect(ring()?.style.transform).toBe("translate(697.00px, 117.00px)");
  });
});

/**
 * Fixed chrome the canvas names without it being a setting (C4): the Message
 * queue always sits above the composer and is never hidden, so it carries a
 * `data-layout-cue` label rather than being a region a session could select.
 */
describe("the fixed-chrome cue", () => {
  it("shows the hover chip with the cue's own label when no region is under the pointer", () => {
    openSession();
    const view = render(<CueCanvas />);

    fireEvent.pointerMove(view.getByTestId("queue-inner"), MOUSE);

    expect(useLayoutEditorStore.getState().hovered).toBeNull();
    expect(chip()?.textContent).toBe("Message queue · Always here");
    expect(chip()?.hidden).toBe(false);
  });

  it("selects nothing on a press over the cue", () => {
    openSession();
    const view = render(<CueCanvas />);

    fireEvent.pointerMove(view.getByTestId("queue-inner"), MOUSE);
    fireEvent.pointerDown(view.getByTestId("queue-inner"));

    expect(useLayoutEditorStore.getState().selected).toBeNull();
  });
});
