import { describe, expect, it } from "vitest";
import { parseHtmlSource } from "@traycer/html-source";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";
import type { CanvasSelection } from "../canvas-selection-store";
import type { CanvasBoardDocument } from "../canvas-board-document";
import { canvasRangeTags, canvasToolbarPosition } from "../canvas-text-tools";

const BOX = { x: 40, y: 100, width: 60, height: 20 };

function documentOf(text: string): CanvasBoardDocument {
  return { sha256: "sha", text, parsed: parseHtmlSource(text) };
}

function element(overrides: Partial<CanvasElement>): CanvasElement {
  return {
    marker: null,
    tid: "t",
    tagName: "p",
    selector: "p",
    elementId: null,
    classNames: [],
    textPreview: "",
    inlineStyle: "",
    ariaRole: null,
    accessibleName: null,
    box: BOX,
    computedStyles: [],
    generated: false,
    ...overrides,
  };
}

function selectionOf(
  start: number,
  end: number,
  elementOverrides: Partial<CanvasElement>,
): CanvasSelection {
  const target = element(elementOverrides);
  return {
    artifactId: "canvas-1",
    boardPath: "boards/home.html",
    page: null,
    servedSha256: "sha",
    element: target,
    textRange: { element: target, start, end, quote: "q", rects: [BOX] },
  };
}

describe("canvasToolbarPosition", () => {
  it("floats above the first selected rectangle", () => {
    expect(
      canvasToolbarPosition(
        [
          { x: 40, y: 100, width: 5, height: 5 },
          { x: 0, y: 300, width: 5, height: 5 },
        ],
        BOX,
      ),
    ).toEqual({ x: 40, y: 64 });
  });

  it("falls back to the element's own box when the selection has no rectangles", () => {
    expect(
      canvasToolbarPosition([], { x: 10, y: 80, width: 5, height: 5 }),
    ).toEqual({
      x: 10,
      y: 44,
    });
  });

  it("never leaves the frame's top or left edge", () => {
    expect(
      canvasToolbarPosition([{ x: -30, y: 10, width: 5, height: 5 }], BOX),
    ).toEqual({ x: 0, y: 0 });
  });
});

describe("canvasRangeTags", () => {
  // Text offsets by node: "Hello " 0-6, "big " 6-10, "deep" 10-14,
  // " world " 14-21, "link" 21-25.
  const PAGE = `<p data-tid="t">Hello <b>big <i>deep</i></b> world <a href="x">link</a></p>`;
  const board = documentOf(PAGE);
  const tagsOf = (start: number, end: number): Set<string> =>
    canvasRangeTags(board, selectionOf(start, end, {}));

  it("reports a tag that wraps the whole range", () => {
    const tags = tagsOf(6, 10);
    expect(tags.has("b")).toBe(true);
    expect(tags.has("i")).toBe(false);
  });

  it("reports every tag around a range inside nested formatting", () => {
    const tags = tagsOf(10, 14);
    expect(tags.has("b")).toBe(true);
    expect(tags.has("i")).toBe(true);
  });

  it("reports only what the whole range shares when it spans differently formatted text", () => {
    expect(tagsOf(0, 10).has("b")).toBe(false);
    expect(tagsOf(6, 14).has("b")).toBe(true);
    expect(tagsOf(6, 14).has("i")).toBe(false);
  });

  it("reports a link around the range", () => {
    expect(tagsOf(21, 25).has("a")).toBe(true);
    expect(tagsOf(14, 25).has("a")).toBe(false);
  });

  it("measures offsets across element boundaries, not within one text node", () => {
    // 11 falls inside "deep", whose own text starts at 10.
    expect(tagsOf(11, 13).has("i")).toBe(true);
  });

  it("ignores comments when counting text offsets", () => {
    const withComment = documentOf(`<p data-tid="t">a<!--c--><b>b</b></p>`);
    expect(canvasRangeTags(withComment, selectionOf(1, 2, {})).has("b")).toBe(
      true,
    );
  });

  it("reports nothing for a range past the end of the text", () => {
    expect(tagsOf(100, 105).size).toBe(0);
  });

  it("reports nothing without a text range", () => {
    const withoutRange: CanvasSelection = {
      ...selectionOf(0, 1, {}),
      textRange: null,
    };
    expect(canvasRangeTags(board, withoutRange).size).toBe(0);
  });

  it.each([
    ["a generated element", { generated: true }],
    ["an element the source does not have", { tid: "missing" }],
  ])("reports nothing for %s", (_label, overrides) => {
    expect(canvasRangeTags(board, selectionOf(6, 10, overrides)).size).toBe(0);
  });
});
