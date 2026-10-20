import { beforeEach, describe, expect, it } from "vitest";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";
import type {
  CanvasLayoutNode,
  CanvasSiblingLayout,
} from "@/lib/sandbox/canvas-layout-bridge";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "../canvas-selection-store";
import { CANVAS_SIBLING_NOTE } from "../canvas-structure-geometry";

const ARTIFACT = "art";
const BOARD = "boards/home.html";
const SHA = "sha-1";

function element(marker: number): CanvasElement {
  return {
    marker,
    tid: null,
    tagName: "div",
    selector: `div:nth-of-type(${marker})`,
    elementId: null,
    classNames: [],
    textPreview: "",
    inlineStyle: "",
    ariaRole: null,
    accessibleName: null,
    box: { x: 0, y: 0, width: 10, height: 10 },
    computedStyles: [],
    generated: false,
  };
}

function pickOf(
  marker: number,
  overrides: Partial<CanvasSelection>,
): CanvasSelection {
  return {
    artifactId: ARTIFACT,
    boardPath: BOARD,
    page: null,
    servedSha256: SHA,
    element: element(marker),
    textRange: null,
    ...overrides,
  };
}

const state = () => useCanvasSelectionStore.getState();

/** A plain pick, the way a click on the board completes one. */
function pick(owner: symbol, selection: CanvasSelection | null): void {
  const generation = state().beginPick(owner, ARTIFACT, BOARD);
  state().completePick(owner, generation, selection);
}

function layoutNodeOf(item: CanvasElement): CanvasLayoutNode {
  return {
    marker: item.marker,
    tid: item.tid,
    tagName: item.tagName,
    box: item.box,
    position: "static",
    left: null,
    top: null,
    cssWidth: null,
    cssHeight: null,
    transformed: false,
    order: 0,
    gridPlacement: false,
  };
}

/** A container that shows exactly the given elements, once each. */
function layoutHolding(
  elements: readonly CanvasElement[],
  overrides: Partial<CanvasSiblingLayout>,
): CanvasSiblingLayout {
  return {
    parent: layoutNodeOf(element(0)),
    siblings: elements.map(layoutNodeOf),
    axis: "x",
    reverse: false,
    truncated: false,
    ...overrides,
  };
}

/** A shift-click that the page answers with `layout`, the container it reports. */
function addPickIn(
  owner: symbol,
  selection: CanvasSelection | null,
  layout: CanvasSiblingLayout | null,
): void {
  const generation = state().beginPick(owner, ARTIFACT, BOARD);
  state().completeAdditivePick(owner, generation, selection, layout);
}

/** A shift-click on a page that shows the whole set plus the new pick. */
function addPick(owner: symbol, selection: CanvasSelection | null): void {
  const shown = new Map<number | null, CanvasElement>();
  const primary = state().selection;
  for (const item of [
    ...(primary === null ? [] : [primary.element]),
    ...state().additionalElements,
    ...(selection === null ? [] : [selection.element]),
  ])
    shown.set(item.marker, item);
  addPickIn(owner, selection, layoutHolding([...shown.values()], {}));
}

const markers = () => state().additionalElements.map((item) => item.marker);

beforeEach(() => {
  useCanvasSelectionStore.setState({
    selection: null,
    additionalElements: [],
    selectionMessage: null,
    selectionOwner: null,
    generation: 0,
    pendingPick: null,
  });
});

describe("completeAdditivePick", () => {
  it("makes the first pick the primary selection when nothing is selected", () => {
    const owner = Symbol("tile");
    addPick(owner, pickOf(1, {}));
    expect(state().selection?.element.marker).toBe(1);
    expect(state().additionalElements).toEqual([]);
    expect(state().selectionOwner).toBe(owner);
    expect(state().pendingPick).toBeNull();
  });

  it("adds later picks to the primary in the order they were made", () => {
    const owner = Symbol("tile");
    pick(owner, pickOf(1, {}));
    addPick(owner, pickOf(2, {}));
    addPick(owner, pickOf(3, {}));
    expect(state().selection?.element.marker).toBe(1);
    expect(markers()).toEqual([2, 3]);
  });

  it("keeps the primary's board and revision for every addition", () => {
    const owner = Symbol("tile");
    pick(owner, pickOf(1, { page: "page-1" }));
    addPick(owner, pickOf(2, { page: "page-1" }));
    expect(state().selection).toMatchObject({
      artifactId: ARTIFACT,
      boardPath: BOARD,
      servedSha256: SHA,
      page: "page-1",
    });
  });

  it("drops the primary's text range, since the selection is now a set", () => {
    const owner = Symbol("tile");
    const primary = pickOf(1, {});
    pick(owner, primary);
    state().setTextRange(ARTIFACT, BOARD, {
      element: primary.element,
      start: 0,
      end: 3,
      quote: "abc",
      rects: [],
    });
    expect(state().selection?.textRange).not.toBeNull();

    addPick(owner, pickOf(2, {}));
    expect(state().selection?.textRange).toBeNull();
    expect(markers()).toEqual([2]);
  });

  it("ignores the primary and anything already added", () => {
    const owner = Symbol("tile");
    pick(owner, pickOf(1, {}));
    addPick(owner, pickOf(2, {}));
    addPick(owner, pickOf(1, {}));
    addPick(owner, pickOf(2, {}));
    expect(state().selection?.element.marker).toBe(1);
    expect(markers()).toEqual([2]);
    expect(state().pendingPick).toBeNull();
  });

  it("recognises a repeat by tid even when the marker moved", () => {
    const owner = Symbol("tile");
    pick(owner, pickOf(1, { element: { ...element(1), tid: "hero" } }));
    addPick(owner, pickOf(2, { element: { ...element(2), tid: "card" } }));
    addPick(owner, pickOf(9, { element: { ...element(9), tid: "card" } }));
    expect(markers()).toEqual([2]);
  });

  describe("caps the set at 256 elements", () => {
    it("holds the primary plus 255 additions", () => {
      const owner = Symbol("tile");
      pick(owner, pickOf(0, {}));
      for (let marker = 1; marker <= 300; marker += 1)
        addPick(owner, pickOf(marker, {}));
      expect(state().additionalElements).toHaveLength(255);
      expect(state().selection?.element.marker).toBe(0);
      expect(markers().at(0)).toBe(1);
      expect(markers().at(-1)).toBe(255);
      expect(state().pendingPick).toBeNull();
    });

    it("still accepts the 256th element and refuses the 257th", () => {
      const owner = Symbol("tile");
      pick(owner, pickOf(0, {}));
      for (let marker = 1; marker <= 254; marker += 1)
        addPick(owner, pickOf(marker, {}));
      expect(state().additionalElements).toHaveLength(254);
      addPick(owner, pickOf(254 + 1, {}));
      expect(state().additionalElements).toHaveLength(255);
      addPick(owner, pickOf(1000, {}));
      expect(state().additionalElements).toHaveLength(255);
    });
  });

  describe("starts over with the new pick as primary", () => {
    function withSet(owner: symbol): void {
      pick(owner, pickOf(1, {}));
      addPick(owner, pickOf(2, {}));
      expect(markers()).toEqual([2]);
    }

    it("when it comes from another board", () => {
      const owner = Symbol("tile");
      withSet(owner);
      addPick(owner, pickOf(5, { boardPath: "boards/other.html" }));
      expect(state().selection).toMatchObject({
        boardPath: "boards/other.html",
      });
      expect(state().selection?.element.marker).toBe(5);
      expect(state().additionalElements).toEqual([]);
      expect(state().selectionOwner).toBe(owner);
    });

    it("when it comes from another artifact", () => {
      const owner = Symbol("tile");
      withSet(owner);
      addPick(owner, pickOf(5, { artifactId: "other-art" }));
      expect(state().selection).toMatchObject({ artifactId: "other-art" });
      expect(state().additionalElements).toEqual([]);
    });

    it("when the board was rewritten since the set began", () => {
      const owner = Symbol("tile");
      withSet(owner);
      addPick(owner, pickOf(5, { servedSha256: "sha-2" }));
      expect(state().selection).toMatchObject({ servedSha256: "sha-2" });
      expect(state().selection?.element.marker).toBe(5);
      expect(state().additionalElements).toEqual([]);
    });

    it("when another tile owned the earlier selection", () => {
      const first = Symbol("first tile");
      const second = Symbol("second tile");
      withSet(first);
      addPick(second, pickOf(5, {}));
      expect(state().selection?.element.marker).toBe(5);
      expect(state().additionalElements).toEqual([]);
      expect(state().selectionOwner).toBe(second);
    });
  });

  describe("does nothing for a pick that is no longer current", () => {
    it("when a newer pick began first", () => {
      const owner = Symbol("tile");
      pick(owner, pickOf(1, {}));
      const stale = state().beginPick(owner, ARTIFACT, BOARD);
      state().beginPick(owner, ARTIFACT, BOARD);
      state().completeAdditivePick(owner, stale, pickOf(2, {}), null);
      expect(markers()).toEqual([]);
      expect(state().pendingPick).not.toBeNull();
    });

    it("when another tile began the pick", () => {
      const owner = Symbol("tile");
      const intruder = Symbol("other tile");
      pick(owner, pickOf(1, {}));
      const generation = state().beginPick(owner, ARTIFACT, BOARD);
      state().completeAdditivePick(intruder, generation, pickOf(2, {}), null);
      expect(markers()).toEqual([]);
      expect(state().selectionOwner).toBe(owner);
    });

    it("when the tile retired while the frame was answering", () => {
      const owner = Symbol("tile");
      pick(owner, pickOf(1, {}));
      const generation = state().beginPick(owner, ARTIFACT, BOARD);
      state().retire(owner, BOARD);
      state().completeAdditivePick(owner, generation, pickOf(2, {}), null);
      expect(state().selection).toBeNull();
      expect(markers()).toEqual([]);
    });

    it("when it was answered once already", () => {
      const owner = Symbol("tile");
      pick(owner, pickOf(1, {}));
      const generation = state().beginPick(owner, ARTIFACT, BOARD);
      const shown = layoutHolding([element(1), element(2), element(3)], {});
      state().completeAdditivePick(owner, generation, pickOf(2, {}), shown);
      state().completeAdditivePick(owner, generation, pickOf(3, {}), shown);
      expect(markers()).toEqual([2]);
    });
  });

  it("keeps the selection when the frame found nothing, and ends the pick", () => {
    const owner = Symbol("tile");
    pick(owner, pickOf(1, {}));
    addPick(owner, pickOf(2, {}));
    addPick(owner, null);
    expect(state().selection?.element.marker).toBe(1);
    expect(markers()).toEqual([2]);
    expect(state().pendingPick).toBeNull();
  });
});

describe("completeAdditivePick checks the set against the live container", () => {
  function withPrimary(owner: symbol): void {
    pick(owner, pickOf(1, {}));
  }

  it("adds a pick the page shows as a sibling of the whole set", () => {
    const owner = Symbol("tile");
    withPrimary(owner);
    addPick(owner, pickOf(2, {}));
    expect(markers()).toEqual([2]);
    expect(state().selectionMessage).toBeNull();
  });

  it("refuses with the sibling note when the page has no layout", () => {
    const owner = Symbol("tile");
    withPrimary(owner);
    addPickIn(owner, pickOf(2, {}), null);
    expect(markers()).toEqual([]);
    expect(state().selectionMessage).toBe(CANVAS_SIBLING_NOTE);
    expect(state().pendingPick).toBeNull();
  });

  it("refuses a pick that is in another container", () => {
    const owner = Symbol("tile");
    withPrimary(owner);
    addPickIn(owner, pickOf(2, {}), layoutHolding([element(1)], {}));
    expect(markers()).toEqual([]);
    expect(state().selectionMessage).toBe(CANVAS_SIBLING_NOTE);
  });

  it("refuses when the primary is not in the container the page reported", () => {
    const owner = Symbol("tile");
    withPrimary(owner);
    addPickIn(owner, pickOf(2, {}), layoutHolding([element(2)], {}));
    expect(markers()).toEqual([]);
    expect(state().selectionMessage).toBe(CANVAS_SIBLING_NOTE);
  });

  it("refuses when an earlier addition is no longer in the container", () => {
    const owner = Symbol("tile");
    withPrimary(owner);
    addPick(owner, pickOf(2, {}));
    addPickIn(
      owner,
      pickOf(3, {}),
      layoutHolding([element(1), element(3)], {}),
    );
    expect(markers()).toEqual([2]);
    expect(state().selectionMessage).toBe(CANVAS_SIBLING_NOTE);
  });

  it("refuses a container that was cut short", () => {
    const owner = Symbol("tile");
    withPrimary(owner);
    addPickIn(
      owner,
      pickOf(2, {}),
      layoutHolding([element(1), element(2)], { truncated: true }),
    );
    expect(markers()).toEqual([]);
    expect(state().selectionMessage).toBe(CANVAS_SIBLING_NOTE);
  });

  it("refuses an element the page generated", () => {
    const owner = Symbol("tile");
    withPrimary(owner);
    const generated = { ...element(2), generated: true };
    addPick(owner, pickOf(2, { element: generated }));
    expect(markers()).toEqual([]);
    expect(state().selectionMessage).toBe(CANVAS_SIBLING_NOTE);
  });

  it("refuses a pick the container shows twice", () => {
    const owner = Symbol("tile");
    withPrimary(owner);
    addPickIn(
      owner,
      pickOf(2, {}),
      layoutHolding([element(1), element(2), element(2)], {}),
    );
    expect(markers()).toEqual([]);
    expect(state().selectionMessage).toBe(CANVAS_SIBLING_NOTE);
  });

  it("refuses a replaced element that keeps the picked tid at another position", () => {
    const owner = Symbol("tile");
    pick(owner, pickOf(1, { element: { ...element(1), tid: "hero" } }));
    const replaced = { ...element(7), tid: "hero" };
    addPickIn(owner, pickOf(2, {}), layoutHolding([replaced, element(2)], {}));
    expect(markers()).toEqual([]);
    expect(state().selectionMessage).toBe(CANVAS_SIBLING_NOTE);
  });

  it("starts the next pick without the old note", () => {
    const owner = Symbol("tile");
    withPrimary(owner);
    addPickIn(owner, pickOf(2, {}), null);
    expect(state().selectionMessage).toBe(CANVAS_SIBLING_NOTE);
    state().beginPick(owner, ARTIFACT, BOARD);
    expect(state().selectionMessage).toBeNull();
  });

  it("does not check a pick that starts a new set", () => {
    const owner = Symbol("tile");
    withPrimary(owner);
    addPickIn(owner, pickOf(5, { boardPath: "boards/other.html" }), null);
    expect(state().selection?.element.marker).toBe(5);
    expect(state().selectionMessage).toBeNull();
  });
});

describe("a plain selection replaces the set", () => {
  it("when a plain pick completes", () => {
    const owner = Symbol("tile");
    pick(owner, pickOf(1, {}));
    addPick(owner, pickOf(2, {}));
    pick(owner, pickOf(7, {}));
    expect(state().selection?.element.marker).toBe(7);
    expect(state().additionalElements).toEqual([]);
  });

  it("when a plain pick finds nothing", () => {
    const owner = Symbol("tile");
    pick(owner, pickOf(1, {}));
    addPick(owner, pickOf(2, {}));
    pick(owner, null);
    expect(state().selection).toBeNull();
    expect(state().additionalElements).toEqual([]);
    expect(state().selectionOwner).toBeNull();
  });

  it("when a selection is made directly", () => {
    const owner = Symbol("tile");
    pick(owner, pickOf(1, {}));
    addPick(owner, pickOf(2, {}));
    state().select(pickOf(8, {}));
    expect(state().selection?.element.marker).toBe(8);
    expect(state().additionalElements).toEqual([]);
  });
});

describe("clearing and retiring", () => {
  function withSet(owner: symbol): void {
    pick(owner, pickOf(1, {}));
    addPick(owner, pickOf(2, {}));
    addPick(owner, pickOf(3, {}));
  }

  it("clear drops the whole set and the owner", () => {
    withSet(Symbol("tile"));
    state().clear();
    expect(state().selection).toBeNull();
    expect(state().additionalElements).toEqual([]);
    expect(state().selectionOwner).toBeNull();
  });

  it("retire drops the owner's set for that board", () => {
    const owner = Symbol("tile");
    withSet(owner);
    state().retire(owner, BOARD);
    expect(state().selection).toBeNull();
    expect(state().additionalElements).toEqual([]);
    expect(state().selectionOwner).toBeNull();
  });

  it("retire with no board drops it whichever board it was on", () => {
    const owner = Symbol("tile");
    withSet(owner);
    state().retire(owner, null);
    expect(state().selection).toBeNull();
    expect(state().additionalElements).toEqual([]);
  });

  it("retire leaves another board's set alone", () => {
    const owner = Symbol("tile");
    withSet(owner);
    state().retire(owner, "boards/other.html");
    expect(state().selection?.element.marker).toBe(1);
    expect(markers()).toEqual([2, 3]);
  });

  it("retire leaves another tile's set alone", () => {
    const owner = Symbol("tile");
    withSet(owner);
    state().retire(Symbol("other tile"), BOARD);
    expect(state().selection?.element.marker).toBe(1);
    expect(markers()).toEqual([2, 3]);
  });

  it("a replacement pick after retiring starts a fresh set", () => {
    const owner = Symbol("tile");
    withSet(owner);
    state().retire(owner, BOARD);
    addPick(owner, pickOf(9, {}));
    expect(state().selection?.element.marker).toBe(9);
    expect(state().additionalElements).toEqual([]);
    addPick(owner, pickOf(10, {}));
    expect(markers()).toEqual([10]);
  });
});
