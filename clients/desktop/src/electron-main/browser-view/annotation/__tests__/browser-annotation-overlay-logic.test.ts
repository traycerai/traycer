import { describe, expect, it } from "vitest";
import type {
  BrowserAnnotationCssRect,
  BrowserAnnotationMarkKind,
} from "../../../../ipc-contracts/browser-annotation-types";
import { ANNOTATION_OVERLAY_GUEST_SOURCE } from "../browser-annotation-overlay-guest.generated";
import {
  ANNOTATION_BUNDLE_BYTE_BUDGET,
  ANNOTATION_BUNDLE_ELEMENT_CAP,
  applyByteBudget,
  eraseNewestAtPoint,
  isElementVisuallyPresent,
  isTinyDrag,
  normalizeDragRect,
  placeCommentBox,
  resolveRegionSelection,
  serializedCaptureBytes,
  strokeBoundsFromPoints,
  svgPathFromPolygon,
  toMarkSnapshot,
  unionRects,
  validateElementMark,
  type OverlayMarkModel,
  type RegionCandidate,
} from "../browser-annotation-overlay-logic";

function rect(
  x: number,
  y: number,
  width: number,
  height: number,
): BrowserAnnotationCssRect {
  return { x, y, width, height };
}

function candidate(input: {
  readonly id: string;
  readonly ancestorIds: readonly string[];
  readonly bounds: BrowserAnnotationCssRect;
  readonly visible: boolean;
}): RegionCandidate {
  return {
    id: input.id,
    ancestorIds: input.ancestorIds,
    bounds: input.bounds,
    visible: input.visible,
    alreadyMarked: false,
  };
}

function marked(input: {
  readonly id: string;
  readonly ancestorIds: readonly string[];
  readonly bounds: BrowserAnnotationCssRect;
  readonly visible: boolean;
}): RegionCandidate {
  return { ...candidate(input), alreadyMarked: true };
}

function mark(input: {
  readonly id: string;
  readonly kind: BrowserAnnotationMarkKind;
  readonly bounds: BrowserAnnotationCssRect;
  readonly selector: string | null;
  readonly elementKey: string | null;
}): OverlayMarkModel {
  return {
    id: input.id,
    kind: input.kind,
    bounds: input.bounds,
    selector: input.selector,
    elementKey: input.elementKey,
  };
}

describe("annotation overlay pointer and keyboard boundaries", () => {
  it("changes annotation tools only through explicit button clicks", () => {
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).not.toContain(
      'setAttribute("aria-keyshortcuts"',
    );
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).not.toContain(
      "shouldHandleModeHotkey",
    );
  });

  it("clears the select hover when the pointer leaves the browser tile", () => {
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).toContain(
      'addEventListener("pointerleave"',
    );
  });

  it("labels hovered elements and transitions between their bounds", () => {
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).toContain("hover-label");
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).toContain("describeHoverTarget");
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).toContain(
      "transition-property:left,top,width,height,opacity",
    );
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).toContain(
      "prefers-reduced-motion:no-preference",
    );
  });

  it("uses one custom send menu instead of a native select and attach button", () => {
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).not.toContain(
      'D.createElement("select")',
    );
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).not.toContain(
      'textContent = "Attach"',
    );
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).toContain(
      'setAttribute("aria-haspopup", "menu")',
    );
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).toContain(
      "requestAttach(targetChatId)",
    );
  });

  it("keeps annotation chrome independent from guest root sizing", () => {
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).toContain("font-size:16px");
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).toContain("min-height:44px");
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).not.toMatch(
      /[0-9]+(?:\.[0-9]+)?rem/,
    );
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).toContain(
      'setAttribute("aria-label", "Annotation destination")',
    );
    expect(ANNOTATION_OVERLAY_GUEST_SOURCE).toContain(
      'setAttribute("role", "alert")',
    );
  });
});

describe("region drag geometry", () => {
  it("normalizes a drag rect independently of pointer order", () => {
    const forward = normalizeDragRect(10, 20, 4, 6);
    const reverse = normalizeDragRect(4, 6, 10, 20);
    const mixed = normalizeDragRect(10, 6, 4, 20);
    expect(forward).toEqual(rect(4, 6, 6, 14));
    expect(reverse).toEqual(forward);
    expect(mixed).toEqual(forward);
  });

  it("treats a drag as tiny when either edge is under 4 CSS pixels", () => {
    expect(isTinyDrag(rect(0, 0, 3, 20))).toBe(true);
    expect(isTinyDrag(rect(0, 0, 20, 3))).toBe(true);
    expect(isTinyDrag(rect(0, 0, 3, 3))).toBe(true);
    expect(isTinyDrag(rect(0, 0, 4, 4))).toBe(false);
    expect(isTinyDrag(rect(0, 0, 8, 8))).toBe(false);
  });
});

describe("resolveRegionSelection", () => {
  const covering = rect(0, 0, 400, 400);

  it("exports the bundle element cap of 30", () => {
    expect(ANNOTATION_BUNDLE_ELEMENT_CAP).toBe(30);
  });

  it("rejects center-outside, majority-outside, and exact half-overlap as empty", () => {
    const box = candidate({
      id: "box",
      ancestorIds: [],
      bounds: rect(0, 0, 100, 100),
      visible: true,
    });
    expect(
      resolveRegionSelection({
        candidates: [box],
        region: rect(0, 0, 40, 40),
        existingElementCount: 0,
        elementCap: ANNOTATION_BUNDLE_ELEMENT_CAP,
      }).reason,
    ).toBe("empty");
    expect(
      resolveRegionSelection({
        candidates: [box],
        region: rect(20, 30, 80, 40),
        existingElementCount: 0,
        elementCap: ANNOTATION_BUNDLE_ELEMENT_CAP,
      }).reason,
    ).toBe("empty");
    expect(
      resolveRegionSelection({
        candidates: [box],
        region: rect(0, 0, 100, 50),
        existingElementCount: 0,
        elementCap: ANNOTATION_BUNDLE_ELEMENT_CAP,
      }).reason,
    ).toBe("empty");
  });

  it("returns reason empty when nothing visible is contained", () => {
    const result = resolveRegionSelection({
      candidates: [
        candidate({
          id: "hidden",
          ancestorIds: [],
          bounds: rect(10, 10, 40, 40),
          visible: false,
        }),
        candidate({
          id: "tiny",
          ancestorIds: [],
          bounds: rect(10, 10, 1, 8),
          visible: true,
        }),
        candidate({
          id: "outside",
          ancestorIds: [],
          bounds: rect(500, 500, 40, 40),
          visible: true,
        }),
      ],
      region: rect(0, 0, 80, 80),
      existingElementCount: 0,
      elementCap: ANNOTATION_BUNDLE_ELEMENT_CAP,
    });
    expect(result).toEqual({ selected: [], refusedCount: 0, reason: "empty" });
  });

  it("collapses a fully selected card to the parent through the pipeline", () => {
    const card = candidate({
      id: "card",
      ancestorIds: [],
      bounds: rect(0, 0, 200, 200),
      visible: true,
    });
    const fragments = Array.from({ length: 15 }, (_unused, index) =>
      candidate({
        id: `frag-${String(index).padStart(2, "0")}`,
        ancestorIds: ["card"],
        bounds: rect(8 + index * 10, 8, 8, 8),
        visible: true,
      }),
    );
    const result = resolveRegionSelection({
      candidates: [card, ...fragments],
      region: covering,
      existingElementCount: 0,
      elementCap: ANNOTATION_BUNDLE_ELEMENT_CAP,
    });
    expect(result.reason).toBe("ok");
    expect(result.refusedCount).toBe(0);
    expect(result.selected.map((entry) => entry.id)).toEqual(["card"]);
  });

  it("keeps an incomplete child subset when the parent is outside the region", () => {
    const card = candidate({
      id: "card",
      ancestorIds: [],
      bounds: rect(0, 0, 200, 200),
      visible: true,
    });
    const c1 = candidate({
      id: "c1",
      ancestorIds: ["card"],
      bounds: rect(4, 4, 24, 24),
      visible: true,
    });
    const c2 = candidate({
      id: "c2",
      ancestorIds: ["card"],
      bounds: rect(36, 4, 24, 24),
      visible: true,
    });
    const result = resolveRegionSelection({
      candidates: [card, c1, c2],
      region: rect(0, 0, 80, 40),
      existingElementCount: 0,
      elementCap: ANNOTATION_BUNDLE_ELEMENT_CAP,
    });
    expect(result.reason).toBe("ok");
    expect(result.selected.map((entry) => entry.id)).toEqual(["c1", "c2"]);
  });

  it("drops a grandchild when the grandparent is selected and the middle parent is not contained", () => {
    const grandparent = candidate({
      id: "gp",
      ancestorIds: [],
      bounds: rect(0, 0, 200, 200),
      visible: true,
    });
    const parent = candidate({
      id: "p",
      ancestorIds: ["gp"],
      bounds: rect(180, 0, 100, 20),
      visible: true,
    });
    const grandchild = candidate({
      id: "gc",
      ancestorIds: ["p", "gp"],
      bounds: rect(20, 20, 30, 30),
      visible: true,
    });
    const result = resolveRegionSelection({
      candidates: [grandparent, parent, grandchild],
      region: rect(0, 0, 200, 200),
      existingElementCount: 0,
      elementCap: ANNOTATION_BUNDLE_ELEMENT_CAP,
    });
    expect(result.selected.map((entry) => entry.id)).toEqual(["gp"]);
  });

  it("sorts the surviving set smallest-first with id tie-break", () => {
    const result = resolveRegionSelection({
      candidates: [
        candidate({
          id: "big",
          ancestorIds: [],
          bounds: rect(0, 0, 80, 80),
          visible: true,
        }),
        candidate({
          id: "tie-b",
          ancestorIds: [],
          bounds: rect(0, 0, 20, 20),
          visible: true,
        }),
        candidate({
          id: "tie-a",
          ancestorIds: [],
          bounds: rect(10, 10, 20, 20),
          visible: true,
        }),
      ],
      region: covering,
      existingElementCount: 0,
      elementCap: ANNOTATION_BUNDLE_ELEMENT_CAP,
    });
    expect(result.selected.map((entry) => entry.id)).toEqual([
      "tie-a",
      "tie-b",
      "big",
    ]);
  });

  it("caps at ANNOTATION_BUNDLE_ELEMENT_CAP and reports refusedCount with reason capped", () => {
    const candidates = Array.from({ length: 35 }, (_unused, index) =>
      candidate({
        id: `el-${String(index).padStart(2, "0")}`,
        ancestorIds: [],
        bounds: rect(index * 4, 0, 8, 8),
        visible: true,
      }),
    );
    const result = resolveRegionSelection({
      candidates,
      region: covering,
      existingElementCount: 0,
      elementCap: ANNOTATION_BUNDLE_ELEMENT_CAP,
    });
    expect(result.reason).toBe("capped");
    expect(result.selected).toHaveLength(ANNOTATION_BUNDLE_ELEMENT_CAP);
    expect(result.refusedCount).toBe(5);
    expect(result.selected[0]?.id).toBe("el-00");
    expect(result.selected[29]?.id).toBe("el-29");
  });

  it("counts existingElementCount toward the cap on a second drag", () => {
    const candidates = Array.from({ length: 25 }, (_unused, index) =>
      candidate({
        id: `next-${String(index).padStart(2, "0")}`,
        ancestorIds: [],
        bounds: rect(index * 4, 20, 8, 8),
        visible: true,
      }),
    );
    const result = resolveRegionSelection({
      candidates,
      region: covering,
      existingElementCount: 15,
      elementCap: ANNOTATION_BUNDLE_ELEMENT_CAP,
    });
    expect(result.reason).toBe("capped");
    expect(result.selected).toHaveLength(15);
    expect(result.refusedCount).toBe(10);
  });

  it("returns capped with an empty selected set when the existing count already fills the cap", () => {
    const result = resolveRegionSelection({
      candidates: [
        candidate({
          id: "extra",
          ancestorIds: [],
          bounds: rect(0, 0, 20, 20),
          visible: true,
        }),
      ],
      region: covering,
      existingElementCount: ANNOTATION_BUNDLE_ELEMENT_CAP,
      elementCap: ANNOTATION_BUNDLE_ELEMENT_CAP,
    });
    expect(result).toEqual({
      selected: [],
      refusedCount: 1,
      reason: "capped",
    });
  });

  it("does not let already-marked elements eat the last cap slot on an overlapping second drag", () => {
    const already: RegionCandidate[] = [];
    for (let index = 0; index < 29; index += 1) {
      already.push(
        marked({
          id: `have-${String(index).padStart(2, "0")}`,
          ancestorIds: [],
          bounds: rect(index * 4, 0, 8, 8),
          visible: true,
        }),
      );
    }
    const freshA = candidate({
      id: "fresh-a",
      ancestorIds: [],
      bounds: rect(0, 40, 8, 8),
      visible: true,
    });
    const freshB = candidate({
      id: "fresh-b",
      ancestorIds: [],
      bounds: rect(20, 40, 8, 8),
      visible: true,
    });
    const result = resolveRegionSelection({
      candidates: [...already, freshA, freshB],
      region: covering,
      existingElementCount: 29,
      elementCap: ANNOTATION_BUNDLE_ELEMENT_CAP,
    });
    expect(result.reason).toBe("capped");
    expect(result.selected.map((entry) => entry.id)).toEqual(["fresh-a"]);
    expect(result.refusedCount).toBe(1);
  });

  it("reports empty, not capped, when a second drag only hits already-marked elements", () => {
    const already = marked({
      id: "have",
      ancestorIds: [],
      bounds: rect(0, 0, 40, 40),
      visible: true,
    });
    const result = resolveRegionSelection({
      candidates: [already],
      region: covering,
      existingElementCount: 29,
      elementCap: ANNOTATION_BUNDLE_ELEMENT_CAP,
    });
    expect(result).toEqual({ selected: [], refusedCount: 0, reason: "empty" });
  });

  it("collapses a new child into an already-marked parent before applying the cap", () => {
    const parent = marked({
      id: "card",
      ancestorIds: [],
      bounds: rect(0, 0, 200, 200),
      visible: true,
    });
    const child = candidate({
      id: "frag",
      ancestorIds: ["card"],
      bounds: rect(8, 8, 16, 16),
      visible: true,
    });
    const result = resolveRegionSelection({
      candidates: [parent, child],
      region: covering,
      existingElementCount: 29,
      elementCap: ANNOTATION_BUNDLE_ELEMENT_CAP,
    });
    expect(result).toEqual({ selected: [], refusedCount: 0, reason: "empty" });
  });
});

describe("marks stack", () => {
  const elementA = mark({
    id: "el-a",
    kind: "element",
    bounds: rect(0, 0, 100, 100),
    selector: "h1",
    elementKey: "key-a",
  });
  const regionB = mark({
    id: "rg-b",
    kind: "region",
    bounds: rect(50, 50, 80, 80),
    selector: null,
    elementKey: null,
  });
  const strokeC = mark({
    id: "st-c",
    kind: "stroke",
    bounds: rect(80, 80, 30, 30),
    selector: null,
    elementKey: null,
  });

  it("erases newest-first across mixed element, region, and stroke marks", () => {
    const stacked = [elementA, regionB, strokeC];
    const first = eraseNewestAtPoint(stacked, 90, 90);
    expect(first.removed?.id).toBe("st-c");
    expect(first.marks.map((entry) => entry.id)).toEqual(["el-a", "rg-b"]);
    const second = eraseNewestAtPoint(first.marks, 90, 90);
    expect(second.removed?.id).toBe("rg-b");
    expect(second.marks.map((entry) => entry.id)).toEqual(["el-a"]);
    const third = eraseNewestAtPoint(second.marks, 10, 10);
    expect(third.removed?.id).toBe("el-a");
    expect(third.marks).toEqual([]);
  });

  it("lets the newer mark win when two bounds overlap the same point", () => {
    const older = mark({
      id: "older",
      kind: "region",
      bounds: rect(0, 0, 100, 100),
      selector: null,
      elementKey: null,
    });
    const newer = mark({
      id: "newer",
      kind: "element",
      bounds: rect(0, 0, 100, 100),
      selector: "div",
      elementKey: "key-newer",
    });
    const hit = eraseNewestAtPoint([older, newer], 40, 40);
    expect(hit.removed?.id).toBe("newer");
    expect(hit.marks.map((entry) => entry.id)).toEqual(["older"]);
  });

  it("leaves the stack unchanged on a miss", () => {
    const stacked = [elementA, regionB, strokeC];
    const miss = eraseNewestAtPoint(stacked, 400, 400);
    expect(miss.removed).toBeNull();
    expect(miss.marks).toEqual(stacked);
    expect(miss.marks).not.toBe(stacked);
  });

  it("disarms the stack when the last mark is erased and leaves it on a miss", () => {
    const one = [elementA];
    expect(eraseNewestAtPoint(one, 500, 500).marks).toEqual(one);
    expect(eraseNewestAtPoint(one, 10, 10).marks).toEqual([]);
  });
});

describe("element mark validation", () => {
  const box = rect(10, 20, 40, 30);

  it("flags a disconnected element", () => {
    expect(
      validateElementMark({
        connected: false,
        visible: true,
        currentBox: box,
        markBox: box,
      }),
    ).toBe("disconnected");
  });

  it("flags display none, visibility hidden/collapse, opacity 0, and zero size as hidden", () => {
    const present = {
      connected: true,
      width: 12,
      height: 12,
      display: "block",
      visibility: "visible",
      opacity: 1,
    };
    expect(isElementVisuallyPresent(present)).toBe(true);
    expect(isElementVisuallyPresent({ ...present, display: "none" })).toBe(
      false,
    );
    expect(isElementVisuallyPresent({ ...present, visibility: "hidden" })).toBe(
      false,
    );
    expect(
      isElementVisuallyPresent({ ...present, visibility: "collapse" }),
    ).toBe(false);
    expect(isElementVisuallyPresent({ ...present, opacity: 0 })).toBe(false);
    expect(isElementVisuallyPresent({ ...present, width: 0 })).toBe(false);
    expect(isElementVisuallyPresent({ ...present, height: 0 })).toBe(false);

    expect(
      validateElementMark({
        connected: true,
        visible: isElementVisuallyPresent({ ...present, display: "none" }),
        currentBox: box,
        markBox: box,
      }),
    ).toBe("hidden");
  });

  it("flags a moved element that no longer overlaps its mark", () => {
    expect(
      validateElementMark({
        connected: true,
        visible: true,
        currentBox: rect(200, 200, 20, 20),
        markBox: box,
      }),
    ).toBe("moved");
  });

  it("keeps a still-overlapping element as ok", () => {
    expect(
      validateElementMark({
        connected: true,
        visible: true,
        currentBox: rect(40, 40, 20, 20),
        markBox: box,
      }),
    ).toBe("ok");
  });
});

describe("toMarkSnapshot", () => {
  it("forces stroke and region selectors to null and never emits points", () => {
    const stroke = toMarkSnapshot(
      mark({
        id: "st",
        kind: "stroke",
        bounds: rect(1, 2, 3, 4),
        selector: "canvas",
        elementKey: "ignored",
      }),
    );
    const region = toMarkSnapshot(
      mark({
        id: "rg",
        kind: "region",
        bounds: rect(5, 6, 7, 8),
        selector: "section",
        elementKey: null,
      }),
    );
    const element = toMarkSnapshot(
      mark({
        id: "el",
        kind: "element",
        bounds: rect(9, 10, 11, 12),
        selector: "main > h1",
        elementKey: "key-el",
      }),
    );
    expect(stroke).toEqual({
      id: "st",
      kind: "stroke",
      bounds: rect(1, 2, 3, 4),
      selector: null,
    });
    expect(region).toEqual({
      id: "rg",
      kind: "region",
      bounds: rect(5, 6, 7, 8),
      selector: null,
    });
    expect(element.selector).toBe("main > h1");
    expect(Object.keys(stroke)).toEqual(["id", "kind", "bounds", "selector"]);
    expect(stroke).not.toHaveProperty("points");
    expect(element).not.toHaveProperty("elementKey");
    expect(element).not.toHaveProperty("points");
  });
});

describe("applyByteBudget", () => {
  it("exports the 256_000 byte budget", () => {
    expect(ANNOTATION_BUNDLE_BYTE_BUDGET).toBe(256_000);
  });

  it("keeps earlier items and refuses those that would exceed the bundle budget", () => {
    const item = { blob: "a".repeat(100_000) };
    const size = serializedCaptureBytes(item);
    expect(size * 2).toBeLessThan(ANNOTATION_BUNDLE_BYTE_BUDGET);
    expect(size * 3).toBeGreaterThan(ANNOTATION_BUNDLE_BYTE_BUDGET);
    const result = applyByteBudget({
      items: [item, item, item],
      existingBytes: 0,
      budget: ANNOTATION_BUNDLE_BYTE_BUDGET,
    });
    expect(result.kept).toHaveLength(2);
    expect(result.refusedCount).toBe(1);
  });

  it("counts existingBytes toward the budget", () => {
    const item = { blob: "b".repeat(1_000) };
    const result = applyByteBudget({
      items: [item],
      existingBytes: ANNOTATION_BUNDLE_BYTE_BUDGET - 10,
      budget: ANNOTATION_BUNDLE_BYTE_BUDGET,
    });
    expect(result.kept).toEqual([]);
    expect(result.refusedCount).toBe(1);
  });

  it("counts UTF-8 bytes, not UTF-16 code units, at the budget boundary", () => {
    const euro = "€";
    expect(euro.length).toBe(1);
    expect(new TextEncoder().encode(euro).byteLength).toBe(3);
    const payload = { text: euro.repeat(100) };
    const units = JSON.stringify(payload).length;
    const bytes = serializedCaptureBytes(payload);
    expect(bytes).toBeGreaterThan(units);
    const result = applyByteBudget({
      items: [payload],
      existingBytes: ANNOTATION_BUNDLE_BYTE_BUDGET - units - 1,
      budget: ANNOTATION_BUNDLE_BYTE_BUDGET,
    });
    expect(result.kept).toEqual([]);
    expect(result.refusedCount).toBe(1);
  });
});

describe("guest attach freeze", () => {
  it("sets attachPending before emit and guards mutate paths until reset or captureFailed", () => {
    const source = ANNOTATION_OVERLAY_GUEST_SOURCE;
    expect(source).toContain("attachPending = true");
    expect(source).toContain("if (attachPending) return");
    expect(source).toContain("attachPending = false");
    expect(source).toContain("captureFailed");
    expect(source).toContain("resetAfterAttach");
    expect(source).toContain("persistRefuseCount");
    expect(source).toContain("refuse-banner");
    expect(source).toMatch(/let persistRefuseCount = 0/);
    const resetAt = source.indexOf("function resetAfterAttach");
    const captureFailedAt = source.indexOf("function captureFailed", resetAt);
    expect(resetAt).toBeGreaterThan(-1);
    expect(captureFailedAt).toBeGreaterThan(resetAt);
    const resetBody = source.slice(resetAt, captureFailedAt);
    expect(resetBody).toContain("refusedCount = 0");
    expect(resetBody).not.toContain("persistRefuseCount = 0");
    expect(source).not.toContain("droppedElementCount");
    expect(source).toContain("return boot()");
    expect(source).not.toMatch(/return true;\s*\}\)\(\)\s*$/);
    expect(source).toContain("leftover.remove()");
    expect(source).toContain("CSS.escape");
    expect(source).toContain("AbortController");
    expect(source).toContain(".toJSON()");
    const emitAt = source.indexOf('type: "attachRequested"');
    const pendingAt = source.lastIndexOf("attachPending = true", emitAt);
    expect(pendingAt).toBeGreaterThan(-1);
    expect(pendingAt).toBeLessThan(emitAt);
  });
});

describe("unionRects", () => {
  it("returns null for an empty list and unions mixed mark bounds", () => {
    expect(unionRects([])).toBeNull();
    expect(
      unionRects([rect(0, 0, 10, 10), rect(20, 5, 10, 10), rect(5, 20, 10, 5)]),
    ).toEqual(rect(0, 0, 30, 25));
  });
});

describe("placeCommentBox", () => {
  const viewport = { width: 800, height: 600 };
  const box = { width: 200, height: 80 };

  it("prefers placing the box below the union and clamps x into the viewport", () => {
    const placed = placeCommentBox({
      union: rect(-40, 100, 50, 40),
      viewport,
      box,
      pillBottom: 40,
    });
    expect(placed.y).toBe(148);
    expect(placed.x).toBe(12);
  });

  it("falls back to a corner when the union cannot host the box above or below", () => {
    const placed = placeCommentBox({
      union: rect(10, 10, 380, 280),
      viewport: { width: 400, height: 300 },
      box,
      pillBottom: 40,
    });
    expect(placed.x).toBe(400 - 200 - 12);
    expect(placed.y).toBe(300 - 80 - 12);
  });

  it("uses the corner fallback when there is no union yet", () => {
    const placed = placeCommentBox({
      union: null,
      viewport,
      box,
      pillBottom: 40,
    });
    expect(placed).toEqual({
      x: 800 - 200 - 12,
      y: 600 - 80 - 12,
    });
  });
});

describe("stroke geometry helpers", () => {
  it("builds a closed SVG path from a polygon and an empty string from none", () => {
    expect(svgPathFromPolygon([])).toBe("");
    const path = svgPathFromPolygon([
      [1, 2],
      [5, 2],
      [5, 6],
    ]);
    expect(path.startsWith("M 1 2 Q")).toBe(true);
    expect(path.endsWith(" Z")).toBe(true);
  });

  it("pads stroke bounds from raw points and returns null for an empty stroke", () => {
    expect(strokeBoundsFromPoints([], 8)).toBeNull();
    expect(
      strokeBoundsFromPoints(
        [
          { x: 10, y: 20 },
          { x: 11, y: 21 },
        ],
        8,
      ),
    ).toBeNull();
    expect(
      strokeBoundsFromPoints(
        [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
        8,
      ),
    ).toEqual(rect(2, 12, 36, 36));
  });
});
