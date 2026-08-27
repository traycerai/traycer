import { afterEach, describe, expect, it } from "vitest";
import {
  readTileStripSlots,
  tileStripGroupAtPoint,
} from "@/components/epic-canvas/dnd/tile-strip-geometry";

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function addStrip(input: {
  readonly viewTabId: string;
  readonly groupId: string;
  readonly left: number;
}): HTMLElement {
  const strip = document.createElement("div");
  strip.dataset.testid = "tab-strip";
  strip.dataset.groupId = input.groupId;
  strip.dataset.viewTabId = input.viewTabId;
  const scroller = document.createElement("div");
  scroller.dataset.testid = "tab-strip-end";
  scroller.getBoundingClientRect = () => rect(input.left, 10, 100, 30);
  strip.append(scroller);
  document.body.append(strip);
  return scroller;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("tile strip geometry", () => {
  it("hit-tests only strips owned by the source view", () => {
    addStrip({ viewTabId: "view-other", groupId: "group-other", left: 0 });
    addStrip({ viewTabId: "view-source", groupId: "group-source", left: 200 });

    expect(tileStripGroupAtPoint({ x: 50, y: 20 }, "view-source")).toBeNull();
    expect(tileStripGroupAtPoint({ x: 250, y: 20 }, "view-source")).toBe(
      "group-source",
    );
  });

  it("removes the rendered transform from live slot measurements", () => {
    const scroller = addStrip({
      viewTabId: "view-source",
      groupId: "group-source",
      left: 100,
    });
    const item = document.createElement("div");
    item.dataset.tileItemId = "tile-1";
    item.style.transform = "matrix(1, 0, 0, 1, 30, 0)";
    item.getBoundingClientRect = () => rect(180, 10, 60, 30);
    scroller.append(item);

    expect(readTileStripSlots("group-source")[0].contentLeft).toBe(50);
  });
});
