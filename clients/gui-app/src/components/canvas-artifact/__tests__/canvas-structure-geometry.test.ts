import { parseHtmlSource, type HtmlElement } from "@traycer/html-source";
import { describe, expect, it } from "vitest";
import type { CanvasBox, CanvasElement } from "@/lib/sandbox/canvas-bridge";
import type {
  CanvasLayoutNode,
  CanvasSiblingLayout,
} from "@/lib/sandbox/canvas-layout-bridge";
import type { CanvasBoardDocument } from "../canvas-board-document";
import {
  CANVAS_LAYOUT_CHANGED_NOTE,
  CANVAS_SIBLING_NOTE,
  alignElements,
  arrangementRefusal,
  distributeElements,
  frameLocator,
  reorderTarget,
  resizeElement,
  sameLayoutElement,
  sourceLocator,
  structureFacts,
  type CanvasAlignMode,
} from "../canvas-structure-geometry";

const BOX_ZERO: CanvasBox = { x: 0, y: 0, width: 0, height: 0 };

/** A positioned element; every case below breaks exactly the fields it names. */
function layoutNode(overrides: Partial<CanvasLayoutNode>): CanvasLayoutNode {
  return {
    marker: null,
    tid: "n",
    tagName: "div",
    box: BOX_ZERO,
    position: "absolute",
    left: 0,
    top: 0,
    cssWidth: 0,
    cssHeight: 0,
    transformed: false,
    ...overrides,
  };
}

/**
 * The container sits at (100, 100) on the page, so a child's page box and its
 * own `left` / `top` differ by that offset. An edit that confused the two
 * would be wrong by exactly 100.
 */
function placed(
  tid: string,
  left: number,
  top: number,
  width: number,
  height: number,
): CanvasLayoutNode {
  return layoutNode({
    tid,
    left,
    top,
    cssWidth: width,
    cssHeight: height,
    box: { x: left + 100, y: top + 100, width, height },
  });
}

function declarationOf(
  edit: ReturnType<typeof alignElements>,
  tid: string,
): readonly { readonly property: string; readonly value: string }[] {
  const found = edit?.elements.find(
    (item) => item.locator.kind === "tid" && item.locator.tid === tid,
  );
  if (found === undefined) throw new Error(`no placement for ${tid}`);
  return found.declarations;
}

describe("identity helpers", () => {
  it("compares layout elements by tid, else by marker and tag", () => {
    expect(
      sameLayoutElement(
        { marker: 1, tid: "t", tagName: "div" },
        { marker: 9, tid: "t", tagName: "p" },
      ),
    ).toBe(true);
    expect(
      sameLayoutElement(
        { marker: 1, tid: null, tagName: "div" },
        { marker: 1, tid: null, tagName: "div" },
      ),
    ).toBe(true);
    expect(
      sameLayoutElement(
        { marker: 1, tid: null, tagName: "div" },
        { marker: 1, tid: null, tagName: "p" },
      ),
    ).toBe(false);
    expect(
      sameLayoutElement(
        { marker: null, tid: null, tagName: "div" },
        { marker: null, tid: null, tagName: "div" },
      ),
    ).toBe(false);
  });

  it("names an element by tid first, then by position, else not at all", () => {
    expect(frameLocator({ marker: 4, tid: "t", tagName: "p" })).toEqual({ tid: "t" });
    expect(frameLocator({ marker: 4, tid: null, tagName: "p" })).toEqual({ marker: 4 });
    expect(frameLocator({ marker: null, tid: null, tagName: "p" })).toBeNull();
    expect(sourceLocator({ marker: 4, tid: "t", tagName: "p" })).toEqual({
      kind: "tid",
      tid: "t",
    });
    expect(sourceLocator({ marker: 4, tid: null, tagName: "p" })).toEqual({
      kind: "position",
      startTagOffset: 4,
      tagName: "p",
    });
    expect(sourceLocator({ marker: null, tid: null, tagName: "p" })).toBeNull();
  });
});

describe("arrangementRefusal", () => {
  it("accepts absolute and relative elements in the minimum number", () => {
    const nodes = [placed("a", 0, 0, 10, 10), layoutNode({ ...placed("b", 5, 5, 10, 10), position: "relative" })];
    expect(arrangementRefusal(nodes, 2)).toBeNull();
  });

  it("asks for more elements when too few are chosen", () => {
    expect(arrangementRefusal([placed("a", 0, 0, 1, 1)], 2)).toBe("Select at least 2 elements.");
    expect(arrangementRefusal([placed("a", 0, 0, 1, 1), placed("b", 0, 0, 1, 1)], 3)).toBe(
      "Select at least 3 elements.",
    );
  });

  it.each(["static", "fixed", "sticky"])("refuses a %s element", (position) => {
    const nodes = [placed("a", 0, 0, 1, 1), layoutNode({ ...placed("b", 0, 0, 1, 1), position })];
    expect(arrangementRefusal(nodes, 2)).toBe(
      "Alignment needs elements positioned absolute or relative.",
    );
  });

  it.each([
    ["a transformed element", { transformed: true }],
    ["an element with no left to edit", { left: null }],
    ["an element with no top to edit", { top: null }],
  ])("refuses %s", (_label, overrides) => {
    const nodes = [placed("a", 0, 0, 1, 1), layoutNode({ ...placed("b", 0, 0, 1, 1), ...overrides })];
    expect(arrangementRefusal(nodes, 2)).toBe(
      "This layout cannot be aligned here. Ask the agent to change it.",
    );
  });
});

describe("alignElements", () => {
  // Page boxes: a x110..130 y200..210, b x140..200 y230..270, c x125..135 y215..235.
  const a = placed("a", 10, 100, 20, 10);
  const b = placed("b", 40, 130, 60, 40);
  const c = placed("c", 25, 115, 10, 20);
  const nodes = [a, b, c];

  // The numbers are each element's own new `left` / `top`: its current value
  // plus how far its page box has to move.
  it.each<[CanvasAlignMode, "left" | "top", Record<string, string>]>([
    ["left", "left", { a: "10px", b: "10px", c: "10px" }],
    ["center", "left", { a: "45px", b: "25px", c: "50px" }],
    ["right", "left", { a: "80px", b: "40px", c: "90px" }],
    ["top", "top", { a: "100px", b: "100px", c: "100px" }],
    ["middle", "top", { a: "130px", b: "115px", c: "125px" }],
    ["bottom", "top", { a: "160px", b: "130px", c: "150px" }],
  ])("%s moves every element along its own %s", (mode, property, expected) => {
    const edit = alignElements(nodes, mode);
    expect(edit).toMatchObject({ kind: "align-elements", mode });
    for (const [tid, value] of Object.entries(expected))
      expect(declarationOf(edit, tid)).toEqual([{ property, value }]);
  });

  it("keeps the order it was given and names each element by tid", () => {
    const edit = alignElements([c, a, b], "left");
    expect(edit?.elements.map((item) => item.locator)).toEqual([
      { kind: "tid", tid: "c" },
      { kind: "tid", tid: "a" },
      { kind: "tid", tid: "b" },
    ]);
  });

  it("writes only left or top, never position", () => {
    for (const mode of ["left", "center", "right", "top", "middle", "bottom"] as const) {
      const edit = alignElements(nodes, mode);
      const properties = edit?.elements.flatMap((item) =>
        item.declarations.map((declaration) => declaration.property),
      );
      expect(properties).toBeDefined();
      for (const property of properties ?? []) expect(["left", "top"]).toContain(property);
    }
  });

  it("rounds to three decimals instead of writing float noise", () => {
    const edit = alignElements(
      [
        layoutNode({ tid: "x", left: 0.1, top: 0, box: { x: 0, y: 0, width: 5, height: 5 }, cssWidth: 5, cssHeight: 5 }),
        layoutNode({ tid: "y", left: 5, top: 0, box: { x: 0.2, y: 0, width: 5, height: 5 }, cssWidth: 5, cssHeight: 5 }),
      ],
      "left",
    );
    expect(declarationOf(edit, "x")).toEqual([{ property: "left", value: "0.1px" }]);
    expect(declarationOf(edit, "y")).toEqual([{ property: "left", value: "4.8px" }]);
  });

  it("aligns relative elements the same way", () => {
    const edit = alignElements(
      [layoutNode({ ...a, position: "relative" }), layoutNode({ ...b, position: "relative" })],
      "left",
    );
    expect(declarationOf(edit, "b")).toEqual([{ property: "left", value: "10px" }]);
  });

  it.each([
    ["one element", [a]],
    ["a static element", [a, layoutNode({ ...b, position: "static" })]],
    ["a transformed element", [a, layoutNode({ ...b, transformed: true })]],
    ["an element with no left", [a, layoutNode({ ...b, left: null })]],
    ["an element that cannot be named", [a, layoutNode({ ...b, tid: null, marker: null })]],
  ])("refuses %s", (_label, refused) => {
    expect(alignElements(refused, "left")).toBeNull();
  });

  it("refuses a result outside the sane range", () => {
    const far = layoutNode({
      tid: "far",
      left: 0,
      top: 0,
      box: { x: 9_000_000, y: 0, width: 10, height: 10 },
      cssWidth: 10,
      cssHeight: 10,
    });
    const near = layoutNode({
      tid: "near",
      left: 0,
      top: 0,
      box: { x: -9_000_000, y: 0, width: 10, height: 10 },
      cssWidth: 10,
      cssHeight: 10,
    });
    expect(alignElements([far, near], "left")).toBeNull();
  });
});

describe("distributeElements", () => {
  // Unequal widths 20, 60 and 10 over x 0..210 leave 120 to share: a gap of 60.
  const a = placed("a", -100, 0, 20, 10);
  const b = placed("b", -70, 0, 60, 10);
  const c = placed("c", 100, 0, 10, 10);

  it("gives unequal widths equal gaps, keeping the outer two where they are", () => {
    const edit = distributeElements([a, b, c], "x");
    expect(edit).toMatchObject({ kind: "distribute-elements", axis: "x" });
    expect(declarationOf(edit, "a")).toEqual([{ property: "left", value: "-100px" }]);
    expect(declarationOf(edit, "b")).toEqual([{ property: "left", value: "-20px" }]);
    expect(declarationOf(edit, "c")).toEqual([{ property: "left", value: "100px" }]);
  });

  it("orders by position on the page, not by the order selected", () => {
    const edit = distributeElements([c, a, b], "x");
    expect(edit?.elements.map((item) => item.locator)).toEqual([
      { kind: "tid", tid: "a" },
      { kind: "tid", tid: "b" },
      { kind: "tid", tid: "c" },
    ]);
    expect(declarationOf(edit, "b")).toEqual([{ property: "left", value: "-20px" }]);
  });

  it("distributes vertically along top", () => {
    const rows = [
      placed("a", 0, -100, 10, 20),
      placed("b", 0, -70, 10, 60),
      placed("c", 0, 100, 10, 10),
    ];
    const edit = distributeElements(rows, "y");
    expect(edit).toMatchObject({ axis: "y" });
    expect(declarationOf(edit, "b")).toEqual([{ property: "top", value: "-20px" }]);
  });

  it("leaves already even gaps alone", () => {
    const even = [placed("a", 0, 0, 10, 10), placed("b", 20, 0, 10, 10), placed("c", 40, 0, 10, 10)];
    const edit = distributeElements(even, "x");
    expect(declarationOf(edit, "b")).toEqual([{ property: "left", value: "20px" }]);
  });

  it.each([
    ["two elements", [a, b]],
    ["a static element", [a, b, layoutNode({ ...c, position: "static" })]],
    ["a transformed element", [a, b, layoutNode({ ...c, transformed: true })]],
    ["an element with no top", [a, b, layoutNode({ ...c, top: null })]],
  ])("refuses %s", (_label, refused) => {
    expect(distributeElements(refused, "x")).toBeNull();
  });
});

describe("resizeElement", () => {
  /** Content box: a 100 x 50 box inside 10px of padding and border on every side. */
  const contentBox = layoutNode({
    box: { x: 50, y: 60, width: 120, height: 70 },
    cssWidth: 100,
    cssHeight: 50,
  });
  /** Border box: the CSS size is the page box. */
  const borderBox = layoutNode({
    box: { x: 50, y: 60, width: 100, height: 50 },
    cssWidth: 100,
    cssHeight: 50,
  });

  it("writes content-box sizes, keeping the padding and border out of them", () => {
    const result = resizeElement(contentBox, "se", { x: 30, y: 10 }, false);
    expect(result).toEqual({
      width: 130,
      height: 60,
      box: { x: 50, y: 60, width: 150, height: 80 },
    });
  });

  it("writes border-box sizes straight through", () => {
    const result = resizeElement(borderBox, "se", { x: 30, y: 10 }, false);
    expect(result).toEqual({
      width: 130,
      height: 60,
      box: { x: 50, y: 60, width: 130, height: 60 },
    });
  });

  it.each<["nw" | "ne" | "sw" | "se", { x: number; y: number }, number, number]>([
    ["se", { x: 20, y: 10 }, 120, 60],
    ["sw", { x: -20, y: 10 }, 120, 60],
    ["ne", { x: 20, y: -10 }, 120, 60],
    ["nw", { x: -20, y: -10 }, 120, 60],
  ])("grows from %s when dragged outward", (corner, delta, width, height) => {
    const result = resizeElement(borderBox, corner, delta, false);
    expect(result).toMatchObject({ width, height });
  });

  it("shrinks when the corner is dragged inward", () => {
    const result = resizeElement(borderBox, "se", { x: -40, y: -20 }, false);
    expect(result).toMatchObject({ width: 60, height: 30 });
  });

  it("never goes below the padding and border, or below zero", () => {
    const result = resizeElement(contentBox, "se", { x: -500, y: -500 }, false);
    expect(result).toEqual({
      width: 0,
      height: 0,
      box: { x: 50, y: 60, width: 20, height: 20 },
    });
    expect(resizeElement(borderBox, "se", { x: -500, y: -500 }, false)).toMatchObject({
      width: 0,
      height: 0,
    });
  });

  describe("with the ratio held", () => {
    // The page box scales by the axis the drag changed most, in proportion to
    // its own size. A tie goes to the horizontal axis.
    it.each<[string, { x: number; y: number }, number, number]>([
      ["a horizontal growth", { x: 50, y: 0 }, 150, 75],
      ["a vertical growth", { x: 0, y: 25 }, 150, 75],
      ["a horizontal shrink, which now shrinks the box", { x: -50, y: 0 }, 50, 25],
      ["a vertical shrink", { x: 0, y: -25 }, 50, 25],
      ["a shrink on both axes led by width", { x: -60, y: -10 }, 40, 20],
      ["a shrink in width against growth in height", { x: -60, y: 10 }, 40, 20],
      ["a growth in height that outweighs a small width shrink", { x: -10, y: 30 }, 160, 80],
      ["an even shrink on both axes", { x: -50, y: -25 }, 50, 25],
      ["a tie between shrinking width and growing height", { x: -50, y: 25 }, 50, 25],
    ])("follows %s", (_label, delta, width, height) => {
      expect(resizeElement(borderBox, "se", delta, true)).toMatchObject({ width, height });
    });

    it("grows by the same amount from every corner when dragged outward", () => {
      // West corners grow when dragged left, east corners when dragged right.
      for (const [corner, delta] of [
        ["se", { x: 50, y: 0 }],
        ["ne", { x: 50, y: 0 }],
        ["sw", { x: -50, y: 0 }],
        ["nw", { x: -50, y: 0 }],
      ] as const)
        expect(resizeElement(borderBox, corner, delta, true)).toMatchObject({
          width: 150,
          height: 75,
        });
    });

    it.each([
      { x: 37, y: 5 },
      { x: -13, y: 40 },
      { x: -70, y: -3 },
      { x: 0, y: 0 },
    ])("keeps the page box's proportions for a drag of %j", (delta) => {
      for (const node of [borderBox, contentBox]) {
        const result = resizeElement(node, "nw", delta, true);
        if (result === null) throw new Error("expected a size");
        expect(result.box.width / result.box.height).toBeCloseTo(
          node.box.width / node.box.height,
          6,
        );
        expect(result.width).toBeGreaterThanOrEqual(0);
        expect(result.height).toBeGreaterThanOrEqual(0);
      }
    });

    it("stops at the padding and border without bending the proportions", () => {
      const result = resizeElement(contentBox, "se", { x: -500, y: -500 }, true);
      if (result === null) throw new Error("expected a size");
      expect(result.box.width).toBeGreaterThanOrEqual(20);
      expect(result.box.height).toBeGreaterThanOrEqual(20);
      expect(result.box.width / result.box.height).toBeCloseTo(120 / 70, 6);
    });
  });

  it.each([
    ["a transformed element", { transformed: true }],
    ["no CSS width", { cssWidth: null }],
    ["no CSS height", { cssHeight: null }],
    ["an empty box", { box: { x: 0, y: 0, width: 0, height: 10 } }],
    ["a flat box", { box: { x: 0, y: 0, width: 10, height: 0 } }],
  ])("refuses %s", (_label, overrides) => {
    expect(resizeElement(layoutNode({ ...borderBox, ...overrides }), "se", { x: 1, y: 1 }, false)).toBeNull();
  });
});

describe("reorderTarget", () => {
  function tile(tid: string, x: number, y: number, width: number, height: number): CanvasLayoutNode {
    return layoutNode({ tid, position: "static", box: { x, y, width, height } });
  }
  function layout(overrides: Partial<CanvasSiblingLayout>): CanvasSiblingLayout {
    return {
      parent: layoutNode({ tid: "parent", box: { x: 0, y: 0, width: 300, height: 300 } }),
      siblings: [],
      axis: "x",
      reverse: false,
      truncated: false,
      ...overrides,
    };
  }
  const selectedB = { marker: null, tid: "b", tagName: "div" };

  describe("in a row", () => {
    const row = layout({
      axis: "x",
      siblings: [tile("a", 0, 0, 100, 50), tile("b", 100, 0, 100, 50), tile("c", 200, 0, 100, 50)],
    });

    it("drops before the first element whose middle is still ahead", () => {
      expect(reorderTarget(row, selectedB, { x: 20, y: 10 })).toEqual({
        before: { kind: "tid", tid: "a" },
        marker: { x: 0, y: 0, width: 2, height: 50 },
      });
      expect(reorderTarget(row, selectedB, { x: 150, y: 10 })).toEqual({
        before: { kind: "tid", tid: "c" },
        marker: { x: 200, y: 0, width: 2, height: 50 },
      });
    });

    it("drops at the end past the last element's middle", () => {
      expect(reorderTarget(row, selectedB, { x: 290, y: 10 })).toEqual({
        before: null,
        marker: { x: 300, y: 0, width: 2, height: 50 },
      });
    });

    it("ignores the selected element when choosing neighbours", () => {
      const result = reorderTarget(row, selectedB, { x: 120, y: 10 });
      expect(result?.before).toEqual({ kind: "tid", tid: "c" });
    });
  });

  describe("in a column", () => {
    const column = layout({
      axis: "y",
      siblings: [tile("a", 0, 0, 80, 100), tile("b", 0, 100, 80, 100), tile("c", 0, 200, 80, 100)],
    });

    it("measures along y and marks a horizontal bar", () => {
      expect(reorderTarget(column, selectedB, { x: 10, y: 20 })).toEqual({
        before: { kind: "tid", tid: "a" },
        marker: { x: 0, y: 0, width: 80, height: 2 },
      });
      expect(reorderTarget(column, selectedB, { x: 10, y: 290 })).toEqual({
        before: null,
        marker: { x: 0, y: 300, width: 80, height: 2 },
      });
    });
  });

  describe("reversed", () => {
    // DOM order a, b, c laid out right to left.
    const reversed = layout({
      axis: "x",
      reverse: true,
      siblings: [tile("a", 200, 0, 100, 50), tile("b", 100, 0, 100, 50), tile("c", 0, 0, 100, 50)],
    });

    it("walks the visual order backwards, marking the edge nearest the pointer", () => {
      expect(reorderTarget(reversed, selectedB, { x: 290, y: 10 })).toEqual({
        before: { kind: "tid", tid: "a" },
        marker: { x: 300, y: 0, width: 2, height: 50 },
      });
      expect(reorderTarget(reversed, selectedB, { x: 150, y: 10 })).toEqual({
        before: { kind: "tid", tid: "c" },
        marker: { x: 100, y: 0, width: 2, height: 50 },
      });
    });

    it("drops last at the far visual end", () => {
      expect(reorderTarget(reversed, selectedB, { x: 10, y: 10 })).toEqual({
        before: null,
        marker: { x: 0, y: 0, width: 2, height: 50 },
      });
    });
  });

  describe("across containers", () => {
    it("places an element that is not in this container before the right neighbour", () => {
      const target = layout({
        axis: "x",
        siblings: [tile("a", 0, 0, 100, 50), tile("c", 100, 0, 100, 50)],
      });
      const foreign = { marker: null, tid: "elsewhere", tagName: "div" };
      expect(reorderTarget(target, foreign, { x: 90, y: 10 })).toEqual({
        before: { kind: "tid", tid: "c" },
        marker: { x: 100, y: 0, width: 2, height: 50 },
      });
    });
  });

  it("names a neighbour by position when it has no tid", () => {
    const positional = layout({
      siblings: [
        layoutNode({ tid: null, marker: 12, tagName: "li", box: { x: 0, y: 0, width: 100, height: 50 } }),
        layoutNode({ tid: null, marker: 40, tagName: "li", box: { x: 100, y: 0, width: 100, height: 50 } }),
      ],
    });
    const selected = { marker: 40, tid: null, tagName: "li" };
    expect(reorderTarget(positional, selected, { x: 10, y: 10 })?.before).toEqual({
      kind: "position",
      startTagOffset: 12,
      tagName: "li",
    });
  });

  it.each([
    ["the pointer left of the container", { x: -1, y: 10 }],
    ["the pointer right of the container", { x: 301, y: 10 }],
    ["the pointer above the container", { x: 10, y: -1 }],
    ["the pointer below the container", { x: 10, y: 301 }],
  ])("has no target for %s", (_label, point) => {
    const row = layout({ siblings: [tile("a", 0, 0, 100, 50), tile("b", 100, 0, 100, 50)] });
    expect(reorderTarget(row, selectedB, point)).toBeNull();
  });

  it("has no target for a truncated container, an only child, or a neighbour it cannot name", () => {
    const siblings = [tile("a", 0, 0, 100, 50), tile("b", 100, 0, 100, 50)];
    expect(reorderTarget(layout({ siblings, truncated: true }), selectedB, { x: 10, y: 10 })).toBeNull();
    expect(reorderTarget(layout({ siblings: [tile("b", 0, 0, 100, 50)] }), selectedB, { x: 10, y: 10 })).toBeNull();
    const unnamed = [tile("a", 0, 0, 100, 50), layoutNode({ tid: null, marker: null, box: { x: 100, y: 0, width: 100, height: 50 } })];
    expect(reorderTarget(layout({ siblings: unnamed }), selectedB, { x: 10, y: 10 })).toBeNull();
  });
});

describe("structureFacts", () => {
  function boardDocument(text: string): CanvasBoardDocument {
    return { sha256: "sha", text, parsed: parseHtmlSource(text) };
  }
  function elementsOf(document: CanvasBoardDocument, tagName: string): readonly HtmlElement[] {
    return document.parsed.elements.filter(
      (element) => element.tagName === tagName && element.startTag !== null,
    );
  }
  function canvasElement(source: HtmlElement, overrides: Partial<CanvasElement>): CanvasElement {
    return {
      marker: source.startTag?.start ?? null,
      tid: null,
      tagName: source.tagName,
      selector: source.tagName,
      elementId: null,
      classNames: [],
      textPreview: "",
      inlineStyle: "",
      ariaRole: null,
      accessibleName: null,
      box: BOX_ZERO,
      computedStyles: [],
      generated: false,
      ...overrides,
    };
  }
  function nodeOf(source: HtmlElement, index: number): CanvasLayoutNode {
    return layoutNode({
      marker: source.startTag?.start ?? null,
      tid: null,
      tagName: source.tagName,
      position: "static",
      box: { x: index * 100, y: 0, width: 100, height: 50 },
    });
  }
  /** The container's live layout, one node per element child, in document order. */
  function layoutOf(parent: HtmlElement): CanvasSiblingLayout {
    return {
      parent: nodeOf(parent, 0),
      siblings: parent.children.flatMap((child, index) =>
        child.kind === "element" ? [nodeOf(child, index)] : [],
      ),
      axis: "x",
      reverse: false,
      truncated: false,
    };
  }
  function childrenOf(parent: HtmlElement): readonly HtmlElement[] {
    return parent.children.flatMap((child) => (child.kind === "element" ? [child] : []));
  }

  const ROW = `<div><p>one</p><span>two</span><b>three</b></div>`;

  function facts(document: CanvasBoardDocument, picks: readonly HtmlElement[], parent: HtmlElement) {
    return structureFacts(
      document,
      picks.map((source) => canvasElement(source, {})),
      layoutOf(parent),
    );
  }

  it("accepts siblings of one container with their live nodes in the order picked", () => {
    const document = boardDocument(ROW);
    const [container] = elementsOf(document, "div");
    const [p, span] = childrenOf(container);
    const result = facts(document, [span, p], container);
    expect(result.refusal).toBeNull();
    expect(result.nodes.map((node) => node.tagName)).toEqual(["span", "p"]);
    expect(result.wrapRefusal).toBeNull();
  });

  it("waits while the document or the live layout is still loading", () => {
    const document = boardDocument(ROW);
    const [container] = elementsOf(document, "div");
    const [p] = childrenOf(container);
    const element = canvasElement(p, {});
    expect(structureFacts(null, [element], layoutOf(container)).refusal).toBe("Opening element layout…");
    expect(structureFacts(document, [element], null).refusal).toBe("Opening element layout…");
  });

  it("refuses a container with too many elements to arrange", () => {
    const document = boardDocument(ROW);
    const [container] = elementsOf(document, "div");
    const [p] = childrenOf(container);
    const truncated = { ...layoutOf(container), truncated: true };
    const result = structureFacts(document, [canvasElement(p, {})], truncated);
    expect(result.refusal).toBe("This container has too many elements to arrange here.");
    expect(result.nodes).toEqual([]);
  });

  it("refuses an element the page generated", () => {
    const document = boardDocument(ROW);
    const [container] = elementsOf(document, "div");
    const [p] = childrenOf(container);
    const result = structureFacts(
      document,
      [canvasElement(p, { generated: true, marker: null })],
      layoutOf(container),
    );
    expect(result.refusal).toBe("Ask the agent to change this element.");
  });

  it("refuses an element the file no longer has, saying the page changed", () => {
    const document = boardDocument(ROW);
    const [container] = elementsOf(document, "div");
    const [p] = childrenOf(container);
    const stale = canvasElement(p, { marker: 9999 });
    expect(structureFacts(document, [stale], layoutOf(container)).refusal).toBe(
      CANVAS_LAYOUT_CHANGED_NOTE,
    );
  });

  it("refuses elements from different containers", () => {
    const document = boardDocument(`<div id="x"><p>one</p></div><div id="y"><p>two</p></div>`);
    const [first, second] = elementsOf(document, "div");
    const [one] = childrenOf(first);
    const [two] = childrenOf(second);
    const result = structureFacts(
      document,
      [canvasElement(one, {}), canvasElement(two, {})],
      layoutOf(first),
    );
    expect(result.refusal).toBe(CANVAS_SIBLING_NOTE);
  });

  it("refuses when the live container is not the one in the file", () => {
    const document = boardDocument(ROW);
    const [container] = elementsOf(document, "div");
    const [p] = childrenOf(container);
    const layout = layoutOf(container);
    const wrongTag = { ...layout, parent: { ...layout.parent, tagName: "section" } };
    const wrongMarker = { ...layout, parent: { ...layout.parent, marker: 12345 } };
    expect(structureFacts(document, [canvasElement(p, {})], wrongTag).refusal).toBe(CANVAS_LAYOUT_CHANGED_NOTE);
    expect(structureFacts(document, [canvasElement(p, {})], wrongMarker).refusal).toBe(CANVAS_LAYOUT_CHANGED_NOTE);
  });

  it("refuses an element the live layout does not show exactly once", () => {
    const document = boardDocument(ROW);
    const [container] = elementsOf(document, "div");
    const [p, span] = childrenOf(container);
    const layout = layoutOf(container);
    const withoutSpan = { ...layout, siblings: layout.siblings.filter((node) => node.tagName !== "span") };
    const twice = { ...layout, siblings: [...layout.siblings, layout.siblings[0]] };
    expect(structureFacts(document, [canvasElement(span, {})], withoutSpan).refusal).toBe(CANVAS_SIBLING_NOTE);
    expect(structureFacts(document, [canvasElement(p, {})], twice).refusal).toBe(CANVAS_SIBLING_NOTE);
  });

  describe("grouping needs consecutive siblings", () => {
    it("accepts neighbours and a single element", () => {
      const document = boardDocument(ROW);
      const [container] = elementsOf(document, "div");
      const [p, span, b] = childrenOf(container);
      expect(facts(document, [p, span], container).wrapRefusal).toBeNull();
      expect(facts(document, [span, b], container).wrapRefusal).toBeNull();
      expect(facts(document, [span], container).wrapRefusal).toBeNull();
    });

    it("refuses a gap, but still lets the elements be arranged", () => {
      const document = boardDocument(ROW);
      const [container] = elementsOf(document, "div");
      const [p, , b] = childrenOf(container);
      const result = facts(document, [p, b], container);
      expect(result.refusal).toBeNull();
      expect(result.wrapRefusal).toBe("Select consecutive elements to group or wrap.");
    });

    it("refuses a gap in the live layout even when the file shows none", () => {
      const document = boardDocument(ROW);
      const [container] = elementsOf(document, "div");
      const [p, span] = childrenOf(container);
      const layout = layoutOf(container);
      const interloper = layoutNode({ marker: 77777, tid: null, tagName: "i", position: "static" });
      const reshuffled = { ...layout, siblings: [layout.siblings[0], interloper, ...layout.siblings.slice(1)] };
      const result = structureFacts(document, [canvasElement(p, {}), canvasElement(span, {})], reshuffled);
      expect(result.wrapRefusal).toBe("Select consecutive elements to group or wrap.");
    });
  });

  describe("containers that cannot hold a group", () => {
    // Each sample is parsed as written, so tables are given their body and rows.
    it.each<[string, string]>([
      ["ul", "<ul><li>a</li><li>b</li></ul>"],
      ["ol", "<ol><li>a</li><li>b</li></ol>"],
      ["dl", "<dl><dt>a</dt><dd>b</dd></dl>"],
      ["select", "<select><option>a</option><option>b</option></select>"],
      ["table", "<table><tbody><tr><td>a</td></tr></tbody></table>"],
      ["p", "<p><span>a</span><span>b</span></p>"],
    ])("refuses to wrap the children of a %s", (tagName, html) => {
      const document = boardDocument(html);
      const [container] = elementsOf(document, tagName);
      const [first] = childrenOf(container);
      const result = facts(document, [first], container);
      expect(result.wrapRefusal).toBe("This container cannot hold a group. Ask the agent to change it.");
      expect(result.refusal).toBeNull();
    });
  });

  describe("ungrouping needs one wrapper", () => {
    const WRAPPED = `<div id="root"><div><span>x</span></div><span>y</span><br><ul><li>z</li></ul></div>`;

    it("accepts one element with an end tag", () => {
      const document = boardDocument(WRAPPED);
      const [root] = elementsOf(document, "div");
      const [wrapper] = childrenOf(root);
      expect(facts(document, [wrapper], root).unwrapRefusal).toBeNull();
    });

    it("refuses several elements, a void element, and a list", () => {
      const document = boardDocument(WRAPPED);
      const [root] = elementsOf(document, "div");
      const [wrapper, span, br, ul] = childrenOf(root);
      const message = "Select a wrapper that can be ungrouped.";
      expect(facts(document, [wrapper, span], root).unwrapRefusal).toBe(message);
      expect(facts(document, [br], root).unwrapRefusal).toBe(message);
      expect(facts(document, [ul], root).unwrapRefusal).toBe(message);
    });
  });
});
