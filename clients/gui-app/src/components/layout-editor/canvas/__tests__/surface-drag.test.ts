import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelLayoutDrag,
  layoutDragActive,
} from "@/components/layout-editor/canvas/drag-engine";
import {
  armSurfaceDrag,
  dropEdgeAt,
  dropZonesOf,
} from "@/components/layout-editor/canvas/surface-drag";
import type { PlacementEdge } from "@/components/layout-editor/canvas/surface-placement";

/**
 * `dropZonesOf` / `dropEdgeAt` are pure arithmetic on a measured box (D14,
 * ticket 09), and `armSurfaceDrag` is the DOM wiring around them: the arm
 * phase it shares with a reorder, the zones it paints onto `<body>` while the
 * surface is in hand, and the single `onDrop` at release.
 */

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

afterEach(() => {
  cancelLayoutDrag();
  document.body.replaceChildren();
});

describe("dropZonesOf", () => {
  it.each([
    {
      surface: "the tab strip's three edges",
      edges: ["top", "left", "right"] as const,
      zones: [
        { edge: "top", rect: { left: 100, top: 50, width: 200, height: 30 } },
        { edge: "left", rect: { left: 100, top: 50, width: 50, height: 120 } },
        {
          edge: "right",
          rect: { left: 250, top: 50, width: 50, height: 120 },
        },
      ],
    },
    {
      // The sidebar cannot go on top, so it must not be offered a top band.
      surface: "only the sidebar's two side edges, no top",
      edges: ["left", "right"] as const,
      zones: [
        { edge: "left", rect: { left: 100, top: 50, width: 50, height: 120 } },
        {
          edge: "right",
          rect: { left: 250, top: 50, width: 50, height: 120 },
        },
      ],
    },
  ])("bands $surface at a quarter of the container", ({ edges, zones }) => {
    expect(dropZonesOf(rect(100, 50, 200, 120), edges)).toEqual(zones);
  });
});

describe("dropEdgeAt", () => {
  const container = rect(0, 0, 200, 100);
  const zones = dropZonesOf(container, ["top", "left", "right"]);

  it("picks the edge a point sits well inside", () => {
    expect(dropEdgeAt(container, zones, { x: 100, y: 5 })).toBe("top");
    expect(dropEdgeAt(container, zones, { x: 5, y: 60 })).toBe("left");
    expect(dropEdgeAt(container, zones, { x: 195, y: 60 })).toBe("right");
  });

  it("gives a corner to whichever band the point is shallower in", () => {
    // 5px into the 25px-tall top band is a 0.2 share; 5px into the 50px-wide
    // left band is a 0.1 share - the left band is shallower there and wins.
    expect(dropEdgeAt(container, zones, { x: 5, y: 5 })).toBe("left");
    expect(dropEdgeAt(container, zones, { x: 195, y: 5 })).toBe("right");
  });

  it("returns null for a point between the bands", () => {
    expect(dropEdgeAt(container, zones, { x: 100, y: 50 })).toBeNull();
  });

  it("clamps a point outside the container to its nearest edge", () => {
    expect(dropEdgeAt(container, zones, { x: 500, y: 50 })).toBe("right");
    expect(dropEdgeAt(container, zones, { x: -500, y: 50 })).toBe("left");
  });
});

describe("armSurfaceDrag", () => {
  interface Fixture {
    readonly node: HTMLElement;
    readonly container: HTMLElement;
  }

  function mount(): Fixture {
    const container = document.createElement("div");
    container.getBoundingClientRect = () => rect(0, 0, 200, 100);
    const node = document.createElement("div");
    container.append(node);
    document.body.append(container);
    return { node, container };
  }

  function press(
    fixture: Fixture,
    input: {
      readonly edges: ReadonlyArray<PlacementEdge>;
      readonly current: PlacementEdge;
      readonly onDrop: (edge: PlacementEdge) => void;
      readonly origin: { readonly x: number; readonly y: number };
    },
  ): void {
    const { edges, current, onDrop, origin } = input;
    const arm = (event: Event): void => {
      if (!(event instanceof PointerEvent)) return;
      armSurfaceDrag({
        event,
        node: fixture.node,
        container: fixture.container,
        edges,
        current,
        onDrop,
      });
    };
    fixture.node.addEventListener("pointerdown", arm);
    fixture.node.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 1,
        button: 0,
        clientX: origin.x,
        clientY: origin.y,
      }),
    );
    fixture.node.removeEventListener("pointerdown", arm);
  }

  function moveTo(x: number, y: number): void {
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        clientX: x,
        clientY: y,
      }),
    );
  }

  function release(): void {
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }),
    );
  }

  function zoneElements(): ReadonlyArray<HTMLElement> {
    return Array.from(
      document.querySelectorAll<HTMLElement>("[data-layout-drop-zone]"),
    );
  }

  it("paints one zone per edge - three for the tab strip", () => {
    const fixture = mount();

    press(fixture, {
      edges: ["top", "left", "right"],
      current: "top",
      onDrop: vi.fn(),
      origin: { x: 100, y: 50 },
    });
    moveTo(100, 44); // crosses the 6px threshold

    expect(
      zoneElements().map((el) => el.getAttribute("data-layout-drop-zone")),
    ).toEqual(["top", "left", "right"]);

    release();
    expect(zoneElements()).toEqual([]);
    expect(layoutDragActive()).toBe(false);
  });

  it("marks the current edge, and lights the one under the pointer", () => {
    const fixture = mount();

    press(fixture, {
      edges: ["left", "right"],
      current: "left",
      onDrop: vi.fn(),
      origin: { x: 10, y: 50 },
    });
    moveTo(10, 56); // crosses the threshold, landing inside the left band

    const zones = zoneElements();
    // Two edges offered, two zones painted: no top band for the sidebar.
    expect(zones.map((el) => el.getAttribute("data-layout-drop-zone"))).toEqual(
      ["left", "right"],
    );
    const leftZone = zones.find(
      (el) => el.getAttribute("data-layout-drop-zone") === "left",
    );
    const rightZone = zones.find(
      (el) => el.getAttribute("data-layout-drop-zone") === "right",
    );
    expect(leftZone?.getAttribute("data-current")).toBe("1");
    expect(rightZone?.hasAttribute("data-current")).toBe(false);
    expect(leftZone?.getAttribute("data-over")).toBe("1");
    expect(rightZone?.hasAttribute("data-over")).toBe(false);
    expect(fixture.node.getAttribute("data-layout-surface-dragging")).toBe("1");

    moveTo(190, 56); // moves into the right band

    expect(leftZone?.hasAttribute("data-over")).toBe(false);
    expect(rightZone?.getAttribute("data-over")).toBe("1");
    // `current` never moves off the edge the drag started at.
    expect(leftZone?.getAttribute("data-current")).toBe("1");

    release();
    expect(fixture.node.hasAttribute("data-layout-surface-dragging")).toBe(
      false,
    );
  });

  it("drops on a different edge and calls onDrop once", () => {
    const fixture = mount();
    const onDrop = vi.fn();

    press(fixture, {
      edges: ["top", "left", "right"],
      current: "top",
      onDrop: onDrop,
      origin: { x: 100, y: 50 },
    });
    moveTo(100, 44);
    moveTo(190, 60); // solidly inside the right band

    release();

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith("right");
  });

  it("writes nothing when the drop lands back on the current edge", () => {
    const fixture = mount();
    const onDrop = vi.fn();

    press(fixture, {
      edges: ["top", "left", "right"],
      current: "top",
      onDrop: onDrop,
      origin: { x: 100, y: 50 },
    });
    moveTo(100, 44);
    moveTo(100, 10); // solidly inside the current edge's own band

    release();

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("writes nothing when the drop lands between the zones", () => {
    const fixture = mount();
    const onDrop = vi.fn();

    press(fixture, {
      edges: ["top", "left", "right"],
      current: "top",
      onDrop: onDrop,
      origin: { x: 100, y: 50 },
    });
    moveTo(100, 44);
    moveTo(100, 50); // dead centre, outside every band

    release();

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("leaves a press that never travelled alone", () => {
    const fixture = mount();
    const onDrop = vi.fn();

    press(fixture, {
      edges: ["top", "left", "right"],
      current: "top",
      onDrop: onDrop,
      origin: { x: 100, y: 50 },
    });
    moveTo(102, 51); // under the 6px threshold: armed, but no drag started

    expect(zoneElements()).toEqual([]);

    release();

    expect(layoutDragActive()).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
  });
});
