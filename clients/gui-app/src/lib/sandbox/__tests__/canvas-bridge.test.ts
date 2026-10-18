import { describe, expect, it } from "vitest";
import {
  CANVAS_STYLE_PROPERTIES,
  parseCanvasBox,
  parseCanvasElement,
  parseCanvasPageError,
  parseCanvasRelativeLink,
  parseCanvasTextSelection,
} from "../canvas-bridge";

const BOX = { x: 1, y: 2, width: 30, height: 40 };

/** A well-formed element answer; each case below breaks exactly one field. */
function element(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    marker: 12,
    tid: "t-1",
    tagName: "DIV",
    selector: "main > div.card",
    elementId: "card",
    classNames: ["card", "wide"],
    textPreview: "hello",
    inlineStyle: "color: red",
    ariaRole: "region",
    accessibleName: "Card",
    box: BOX,
    computedStyles: [{ property: "display", value: "block" }],
    generated: false,
    ...overrides,
  };
}

describe("parseCanvasBox", () => {
  it("keeps only the four numeric fields", () => {
    expect(parseCanvasBox({ ...BOX, extra: "dropped" })).toEqual(BOX);
  });

  it("accepts negative offsets and an empty box", () => {
    expect(parseCanvasBox({ x: -5, y: -6, width: 0, height: 0 })).toEqual({
      x: -5,
      y: -6,
      width: 0,
      height: 0,
    });
  });

  it.each([
    ["null", null],
    ["an array", [1, 2, 3, 4]],
    ["a missing field", { x: 1, y: 2, width: 3 }],
    ["a string coordinate", { ...BOX, x: "1" }],
    ["NaN", { ...BOX, y: Number.NaN }],
    ["Infinity", { ...BOX, width: Number.POSITIVE_INFINITY }],
    ["a negative width", { ...BOX, width: -1 }],
    ["a negative height", { ...BOX, height: -0.5 }],
    ["a coordinate past the sanity bound", { ...BOX, x: 10_000_001 }],
    ["a coordinate past the negative bound", { ...BOX, y: -10_000_001 }],
  ])("rejects %s", (_label, value) => {
    expect(parseCanvasBox(value)).toBeNull();
  });

  it("accepts a coordinate exactly at the bound", () => {
    expect(parseCanvasBox({ ...BOX, x: 10_000_000 })).not.toBeNull();
  });
});

describe("parseCanvasElement", () => {
  it("round-trips a well-formed element", () => {
    expect(parseCanvasElement(element({}))).toEqual(element({}));
  });

  it("drops fields outside the contract", () => {
    const parsed = parseCanvasElement(element({ innerHTML: "<b>x</b>" }));
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("innerHTML");
  });

  it("accepts a generated element, which has no marker", () => {
    expect(
      parseCanvasElement(element({ marker: null, generated: true })),
    ).not.toBeNull();
  });

  it.each([
    ["a marked element claiming to be generated", { generated: true }],
    ["an unmarked element claiming to be authored", { marker: null }],
    ["a negative marker", { marker: -1 }],
    ["a fractional marker", { marker: 1.5 }],
    ["an unsafe-integer marker", { marker: Number.MAX_SAFE_INTEGER + 1 }],
    ["a string marker", { marker: "12" }],
    ["an overlong tid", { tid: "t".repeat(301) }],
    ["an overlong tag name", { tagName: "X".repeat(41) }],
    ["an overlong selector", { selector: "a".repeat(1001) }],
    ["an overlong element id", { elementId: "i".repeat(301) }],
    [
      "more than 30 class names",
      { classNames: Array.from({ length: 31 }, () => "c") },
    ],
    ["an overlong class name", { classNames: ["c".repeat(121)] }],
    ["a non-string class name", { classNames: ["ok", 7] }],
    ["an overlong text preview", { textPreview: "p".repeat(201) }],
    ["an overlong inline style", { inlineStyle: "s".repeat(16_001) }],
    ["a missing inline style", { inlineStyle: undefined }],
    ["a null inline style", { inlineStyle: null }],
    ["an overlong aria role", { ariaRole: "r".repeat(65) }],
    ["an overlong accessible name", { accessibleName: "n".repeat(301) }],
    ["a malformed box", { box: { ...BOX, width: -1 } }],
    ["a missing box", { box: undefined }],
    ["computed styles that are not an array", { computedStyles: {} }],
  ])("rejects %s", (_label, overrides) => {
    expect(parseCanvasElement(element(overrides))).toBeNull();
  });

  it("accepts the limit values exactly", () => {
    expect(
      parseCanvasElement(
        element({
          tid: "t".repeat(300),
          tagName: "X".repeat(40),
          selector: "a".repeat(1000),
          elementId: "i".repeat(300),
          classNames: Array.from({ length: 30 }, () => "c".repeat(120)),
          textPreview: "p".repeat(200),
          inlineStyle: "s".repeat(16_000),
          ariaRole: "r".repeat(64),
          accessibleName: "n".repeat(300),
        }),
      ),
    ).not.toBeNull();
  });

  it("accepts null for every nullable text field", () => {
    expect(
      parseCanvasElement(
        element({
          tid: null,
          elementId: null,
          ariaRole: null,
          accessibleName: null,
        }),
      ),
    ).not.toBeNull();
  });

  it("curates 46 properties, leaving room under the 48-entry cap", () => {
    expect(CANVAS_STYLE_PROPERTIES).toHaveLength(46);
    expect(new Set(CANVAS_STYLE_PROPERTIES).size).toBe(46);
    for (const shorthand of [
      "padding",
      "margin",
      "border-width",
      "border-color",
    ]) {
      expect(CANVAS_STYLE_PROPERTIES).toContain(shorthand);
    }
  });

  it("accepts every curated style property and no more than 48 entries", () => {
    const styles = CANVAS_STYLE_PROPERTIES.map((property) => ({
      property,
      value: "x",
    }));
    expect(
      parseCanvasElement(element({ computedStyles: styles })),
    ).not.toBeNull();
    const tooMany = Array.from({ length: 49 }, () => ({
      property: "display",
      value: "block",
    }));
    expect(parseCanvasElement(element({ computedStyles: tooMany }))).toBeNull();
  });

  it("rejects one style outside the curated set rather than dropping it", () => {
    expect(
      parseCanvasElement(
        element({
          computedStyles: [
            { property: "display", value: "block" },
            { property: "-webkit-text-stroke", value: "1px" },
          ],
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ["an overlong value", { property: "display", value: "v".repeat(301) }],
    ["a non-string value", { property: "display", value: 3 }],
    ["a missing property", { value: "block" }],
  ])("rejects a style with %s", (_label, style) => {
    expect(parseCanvasElement(element({ computedStyles: [style] }))).toBeNull();
  });

  it.each([null, "div", 4, [element({})]])(
    "rejects the non-record %j",
    (value) => {
      expect(parseCanvasElement(value)).toBeNull();
    },
  );
});

describe("parseCanvasTextSelection", () => {
  const selection = (overrides: Record<string, unknown>) => ({
    element: element({}),
    start: 3,
    end: 9,
    quote: "a quote",
    rects: [BOX],
    ...overrides,
  });

  it("round-trips a well-formed selection", () => {
    expect(parseCanvasTextSelection(selection({}))).toEqual(selection({}));
  });

  it("accepts a collapsed selection", () => {
    expect(
      parseCanvasTextSelection(selection({ start: 4, end: 4 })),
    ).not.toBeNull();
  });

  it.each([
    ["an end before the start", { start: 9, end: 3 }],
    ["a negative start", { start: -1 }],
    ["a fractional end", { end: 2.5 }],
    ["an overlong quote", { quote: "q".repeat(16_001) }],
    ["a non-string quote", { quote: 1 }],
    ["more than 256 rects", { rects: Array.from({ length: 257 }, () => BOX) }],
    ["a malformed rect", { rects: [BOX, { ...BOX, height: -1 }] }],
    ["rects that are not an array", { rects: BOX }],
    ["a malformed element", { element: element({ generated: true }) }],
  ])("rejects %s", (_label, overrides) => {
    expect(parseCanvasTextSelection(selection(overrides))).toBeNull();
  });

  it("accepts the limit values exactly", () => {
    expect(
      parseCanvasTextSelection(
        selection({
          quote: "q".repeat(16_000),
          rects: Array.from({ length: 256 }, () => BOX),
        }),
      ),
    ).not.toBeNull();
  });
});

describe("parseCanvasPageError", () => {
  it("accepts a message with and without a stack", () => {
    expect(parseCanvasPageError({ message: "boom", stack: "at x" })).toEqual({
      message: "boom",
      stack: "at x",
    });
    expect(parseCanvasPageError({ message: "boom", stack: null })).toEqual({
      message: "boom",
      stack: null,
    });
  });

  it.each([
    ["an overlong message", { message: "m".repeat(2001), stack: null }],
    ["an overlong stack", { message: "m", stack: "s".repeat(8001) }],
    ["a missing stack", { message: "m" }],
    ["a missing message", { stack: null }],
    ["a non-string message", { message: 7, stack: null }],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(parseCanvasPageError(value)).toBeNull();
  });

  it("accepts the limit values exactly", () => {
    expect(
      parseCanvasPageError({
        message: "m".repeat(2000),
        stack: "s".repeat(8000),
      }),
    ).not.toBeNull();
  });
});

describe("parseCanvasRelativeLink", () => {
  it("returns the href", () => {
    expect(parseCanvasRelativeLink({ href: "../other.html#top" })).toBe(
      "../other.html#top",
    );
  });

  it("accepts an href at the 8192 limit and rejects one past it", () => {
    expect(parseCanvasRelativeLink({ href: "a".repeat(8192) })).not.toBeNull();
    expect(parseCanvasRelativeLink({ href: "a".repeat(8193) })).toBeNull();
  });

  it.each([
    ["a missing href", {}],
    ["a non-string href", { href: 3 }],
    ["a bare string", "other.html"],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(parseCanvasRelativeLink(value)).toBeNull();
  });
});
