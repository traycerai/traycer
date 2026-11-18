import { describe, expect, it } from "vitest";
import type {
  CanvasElement,
  CanvasTextSelection,
} from "@/lib/sandbox/canvas-bridge";
import { canvasAnnotationElement } from "../canvas-annotation-attach";
import type { CanvasSelection } from "../canvas-selection-store";

// Non-ASCII text and CRLF line breaks before the target: offsets are string
// indices into this exact text, and the CRLF pair must count as one line break.
const SOURCE =
  '<p>héllo ✓</p>\r\n<p>second</p>\r\n<div class="a">naïve</div>\r\n';
const TARGET_START = SOURCE.indexOf("<div");
const TARGET_END = SOURCE.indexOf("</div>") + "</div>".length;

function element(overrides: Partial<CanvasElement>): CanvasElement {
  return {
    marker: TARGET_START,
    tid: "tid-1",
    tagName: "div",
    selector: "div.a",
    elementId: null,
    classNames: ["a"],
    textPreview: "naïve",
    inlineStyle: "",
    ariaRole: null,
    accessibleName: null,
    box: { x: 10, y: 20, width: 30, height: 40 },
    computedStyles: [{ property: "display", value: "block" }],
    generated: false,
    ...overrides,
  };
}

function selection(
  target: CanvasElement,
  textRange: CanvasTextSelection | null,
): CanvasSelection {
  return {
    artifactId: "art",
    boardPath: "board.html",
    page: null,
    servedSha256: "sha",
    element: target,
    textRange,
  };
}

describe("canvasAnnotationElement", () => {
  it("locates the element's literal source range, counting a CRLF pair as one line break", () => {
    const capture = canvasAnnotationElement(
      selection(element({}), null),
      SOURCE,
    );

    expect(capture.sourceRange).toEqual({
      start: TARGET_START,
      end: TARGET_END,
      line: 3,
    });
    expect(
      SOURCE.slice(capture.sourceRange?.start, capture.sourceRange?.end),
    ).toBe('<div class="a">naïve</div>');
    expect(capture.tid).toBe("tid-1");
  });

  it("derives the bounding box edges from the element box", () => {
    const capture = canvasAnnotationElement(
      selection(element({}), null),
      SOURCE,
    );

    expect(capture.boundingBox).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      top: 20,
      left: 10,
      right: 40,
      bottom: 60,
    });
  });

  it("omits source range and tid for a generated element", () => {
    const generated = element({
      marker: null,
      tid: "synthetic",
      generated: true,
    });

    const capture = canvasAnnotationElement(selection(generated, null), SOURCE);

    expect(capture.sourceRange).toBeNull();
    expect(capture.tid).toBeNull();
  });

  it("has no source range without the served source text", () => {
    expect(
      canvasAnnotationElement(selection(element({}), null), null).sourceRange,
    ).toBeNull();
  });

  it("preserves the selected text's range and quote verbatim", () => {
    const target = element({});
    const quote = 'naïve ✓\r\n"quoted" <b>';
    const range: CanvasTextSelection = {
      element: target,
      start: 2,
      end: 2 + quote.length,
      quote,
      rects: [],
    };

    const capture = canvasAnnotationElement(selection(target, range), SOURCE);

    expect(capture.textRange).toEqual({
      start: 2,
      end: 2 + quote.length,
      quote,
    });
  });

  it("has no text range when none is selected", () => {
    expect(
      canvasAnnotationElement(selection(element({}), null), SOURCE).textRange,
    ).toBeNull();
  });
});
