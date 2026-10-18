import { beforeEach, describe, expect, it } from "vitest";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "../canvas-selection-store";

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

/** A shift-click: begins a pick and completes it as an addition. */
function addPick(owner: symbol, selection: CanvasSelection | null): void {
  const generation = state().beginPick(owner, ARTIFACT, BOARD);
  state().completeAdditivePick(owner, generation, selection);
}

const markers = () => state().additionalElements.map((item) => item.marker);

beforeEach(() => {
  useCanvasSelectionStore.setState({
    selection: null,
    additionalElements: [],
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
      for (let marker = 1; marker <= 300; marker += 1) addPick(owner, pickOf(marker, {}));
      expect(state().additionalElements).toHaveLength(255);
      expect(state().selection?.element.marker).toBe(0);
      expect(markers().at(0)).toBe(1);
      expect(markers().at(-1)).toBe(255);
      expect(state().pendingPick).toBeNull();
    });

    it("still accepts the 256th element and refuses the 257th", () => {
      const owner = Symbol("tile");
      pick(owner, pickOf(0, {}));
      for (let marker = 1; marker <= 254; marker += 1) addPick(owner, pickOf(marker, {}));
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
      expect(state().selection).toMatchObject({ boardPath: "boards/other.html" });
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
      state().completeAdditivePick(owner, stale, pickOf(2, {}));
      expect(markers()).toEqual([]);
      expect(state().pendingPick).not.toBeNull();
    });

    it("when another tile began the pick", () => {
      const owner = Symbol("tile");
      const intruder = Symbol("other tile");
      pick(owner, pickOf(1, {}));
      const generation = state().beginPick(owner, ARTIFACT, BOARD);
      state().completeAdditivePick(intruder, generation, pickOf(2, {}));
      expect(markers()).toEqual([]);
      expect(state().selectionOwner).toBe(owner);
    });

    it("when the tile retired while the frame was answering", () => {
      const owner = Symbol("tile");
      pick(owner, pickOf(1, {}));
      const generation = state().beginPick(owner, ARTIFACT, BOARD);
      state().retire(owner, BOARD);
      state().completeAdditivePick(owner, generation, pickOf(2, {}));
      expect(state().selection).toBeNull();
      expect(markers()).toEqual([]);
    });

    it("when it was answered once already", () => {
      const owner = Symbol("tile");
      pick(owner, pickOf(1, {}));
      const generation = state().beginPick(owner, ARTIFACT, BOARD);
      state().completeAdditivePick(owner, generation, pickOf(2, {}));
      state().completeAdditivePick(owner, generation, pickOf(3, {}));
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
