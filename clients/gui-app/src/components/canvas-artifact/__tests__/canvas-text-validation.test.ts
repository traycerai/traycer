import { describe, expect, it } from "vitest";
import type { CanvasSelection } from "../canvas-selection-store";
import {
  CANVAS_SCRIPT_TEXT_NOTE,
  canvasLiveText,
  canvasRangeRefusal,
} from "../canvas-text-validation";
import {
  boardDocument,
  canvasElement,
  quotedSelection,
  textSelection,
  withTextRange,
} from "./canvas-edit-test-support";

const WAIT = "Wait for the artboard to finish loading.";

describe("canvasRangeRefusal", () => {
  // "Hello " 0-6, "big" 6-9, " world" 9-15.
  const TEXT = "Hello big world";
  const board = boardDocument(`<p data-tid="t">Hello <b>big</b> world</p>`);
  const range = (start: number, end: number) =>
    quotedSelection(TEXT, start, end, {});
  const BIG = range(6, 9);

  it("accepts a range whose quote is the source text at that range", () => {
    expect(canvasRangeRefusal(board, range(6, 9))).toBeNull();
    expect(canvasRangeRefusal(board, range(0, 15))).toBeNull();
  });

  it("measures offsets across nested elements, as the page's text does", () => {
    expect(canvasRangeRefusal(board, range(3, 12))).toBeNull();
  });

  it("ignores comments, which the page's text does not contain", () => {
    const withComment = boardDocument(`<p data-tid="t">a<!--c-->b</p>`);
    expect(
      canvasRangeRefusal(withComment, quotedSelection("ab", 1, 2, {})),
    ).toBeNull();
  });

  it("reads entities decoded, as the page's text does", () => {
    const entity = boardDocument(`<p data-tid="t">a &amp; b</p>`);
    expect(
      canvasRangeRefusal(entity, quotedSelection("a & b", 2, 5, {})),
    ).toBeNull();
  });

  it("asks to wait while there is no source", () => {
    expect(canvasRangeRefusal(null, range(6, 9))).toBe(WAIT);
  });

  it("asks to wait while the source is a different revision from the page's", () => {
    expect(
      canvasRangeRefusal({ ...board, sha256: "sha-older" }, range(6, 9)),
    ).toBe(WAIT);
  });

  it.each([
    [
      "a quote that differs from the source",
      (selection: CanvasSelection) =>
        withTextRange(selection, { quote: "bug" }),
    ],
    [
      "a quote with different case",
      (selection: CanvasSelection) =>
        withTextRange(selection, { quote: "BIG" }),
    ],
    [
      "offsets shifted by one",
      (selection: CanvasSelection) =>
        withTextRange(selection, { start: 7, end: 10 }),
    ],
    [
      "an end past the text",
      (selection: CanvasSelection) => withTextRange(selection, { end: 99 }),
    ],
    [
      "an empty range",
      (selection: CanvasSelection) =>
        withTextRange(selection, { start: 6, end: 6, quote: "" }),
    ],
    [
      "an end before the start",
      (selection: CanvasSelection) =>
        withTextRange(selection, { start: 9, end: 6 }),
    ],
    [
      "a negative start",
      (selection: CanvasSelection) =>
        withTextRange(selection, { start: -1, end: 3, quote: "" }),
    ],
    [
      "a fractional end",
      (selection: CanvasSelection) => withTextRange(selection, { end: 8.5 }),
    ],
  ])("says a script changed the text for %s", (_label, change) => {
    expect(canvasRangeRefusal(board, change(BIG))).toBe(
      CANVAS_SCRIPT_TEXT_NOTE,
    );
  });

  it("says a script changed the text when the source has no such element", () => {
    expect(
      canvasRangeRefusal(
        board,
        quotedSelection(TEXT, 6, 9, { tid: "missing" }),
      ),
    ).toBe(CANVAS_SCRIPT_TEXT_NOTE);
  });

  it("says a script changed the text when the range belongs to another element", () => {
    const other = canvasElement({ tid: "other" });
    expect(
      canvasRangeRefusal(board, withTextRange(BIG, { element: other })),
    ).toBe(CANVAS_SCRIPT_TEXT_NOTE);
  });

  it("says a script changed the text when there is no range at all", () => {
    expect(canvasRangeRefusal(board, textSelection(null, {}))).toBe(
      CANVAS_SCRIPT_TEXT_NOTE,
    );
  });
});

describe("canvasLiveText", () => {
  const element = (
    textSnapshot: {
      content: string;
      nodes: string[];
      textOnly: boolean;
    } | null,
  ) => canvasElement({ textSnapshot });

  it("reads the whole text of a text-only element", () => {
    expect(
      canvasLiveText(
        { text: "Hello", textNodeIndex: null },
        element({ content: "Hello", nodes: ["Hello"], textOnly: true }),
      ),
    ).toBe("Hello");
  });

  it("reads an empty text-only element as empty text", () => {
    expect(
      canvasLiveText(
        { text: "", textNodeIndex: null },
        element({ content: "", nodes: [], textOnly: true }),
      ),
    ).toBe("");
  });

  it("will not read the whole text of an element with elements inside it", () => {
    expect(
      canvasLiveText(
        { text: "Hello ", textNodeIndex: null },
        element({ content: "Hello big", nodes: ["Hello "], textOnly: false }),
      ),
    ).toBeNull();
  });

  it("reads the one text node beside an element's children", () => {
    expect(
      canvasLiveText(
        { text: "Title ", textNodeIndex: 0 },
        element({ content: "Title x", nodes: ["Title "], textOnly: false }),
      ),
    ).toBe("Title ");
  });

  it("will not pick one of several text nodes", () => {
    expect(
      canvasLiveText(
        { text: "Hello ", textNodeIndex: 0 },
        element({
          content: "Hello big world",
          nodes: ["Hello ", " world"],
          textOnly: false,
        }),
      ),
    ).toBeNull();
  });

  it("will not read a node index the page does not have", () => {
    expect(
      canvasLiveText(
        { text: "x", textNodeIndex: 3 },
        element({ content: "x", nodes: ["x"], textOnly: false }),
      ),
    ).toBeNull();
  });

  it.each([
    ["no snapshot", undefined],
    ["a snapshot the page could not send", null],
  ])("reads nothing when the page sent %s", (_label, snapshot) => {
    const described =
      snapshot === undefined ? canvasElement({}) : element(snapshot);
    expect(
      canvasLiveText({ text: "Hello", textNodeIndex: null }, described),
    ).toBeNull();
  });
});
