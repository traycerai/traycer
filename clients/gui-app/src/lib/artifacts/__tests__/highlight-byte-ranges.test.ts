import { describe, expect, it } from "vitest";
import { highlightSegmentsFromByteRanges } from "@/lib/artifacts/highlight-byte-ranges";

function highlightedText(
  segments: ReadonlyArray<{ text: string; highlighted: boolean }>,
): string {
  return segments
    .filter((segment) => segment.highlighted)
    .map((segment) => segment.text)
    .join("|");
}

function joinedText(
  segments: ReadonlyArray<{ text: string; highlighted: boolean }>,
): string {
  return segments.map((segment) => segment.text).join("");
}

describe("highlightSegmentsFromByteRanges", () => {
  it("returns an empty list for empty text", () => {
    expect(highlightSegmentsFromByteRanges("", [{ startByte: 0, endByte: 1 }])).toEqual(
      [],
    );
  });

  it("returns a single non-highlighted segment when there are no ranges", () => {
    const segments = highlightSegmentsFromByteRanges("hello world", []);
    expect(segments).toEqual([
      { text: "hello world", highlighted: false, start: 0 },
    ]);
  });

  it("highlights an ASCII byte range on JS-string boundaries", () => {
    const segments = highlightSegmentsFromByteRanges("hello world", [
      { startByte: 6, endByte: 11 },
    ]);
    expect(joinedText(segments)).toBe("hello world");
    expect(highlightedText(segments)).toBe("world");
    expect(segments).toEqual([
      { text: "hello ", highlighted: false, start: 0 },
      { text: "world", highlighted: true, start: 6 },
    ]);
  });

  it("maps multibyte UTF-8 byte offsets to the correct JS characters", () => {
    // "naïve" — the ï is 2 UTF-8 bytes, so "naïve" is 6 bytes; the match on
    // the leading "naïve" word ends at byte 6, not char index 5.
    const segments = highlightSegmentsFromByteRanges("naïve text", [
      { startByte: 0, endByte: 6 },
    ]);
    expect(highlightedText(segments)).toBe("naïve");
    expect(joinedText(segments)).toBe("naïve text");
  });

  it("handles astral (surrogate-pair) characters — 4 UTF-8 bytes, 2 UTF-16 units", () => {
    // "a😀b": 'a' (1 byte), '😀' (4 bytes, 2 UTF-16 units), 'b' (1 byte).
    // Highlight the emoji: bytes [1, 5).
    const segments = highlightSegmentsFromByteRanges("a😀b", [
      { startByte: 1, endByte: 5 },
    ]);
    expect(highlightedText(segments)).toBe("😀");
    expect(joinedText(segments)).toBe("a😀b");
  });

  it("merges overlapping and adjacent ranges", () => {
    const segments = highlightSegmentsFromByteRanges("abcdefgh", [
      { startByte: 1, endByte: 3 },
      { startByte: 2, endByte: 4 },
      { startByte: 4, endByte: 5 },
    ]);
    expect(highlightedText(segments)).toBe("bcde");
    expect(joinedText(segments)).toBe("abcdefgh");
  });

  it("clamps ranges past the snippet's byte length and drops empty/inverted ranges", () => {
    const segments = highlightSegmentsFromByteRanges("abc", [
      { startByte: 2, endByte: 999 },
      { startByte: 1, endByte: 1 },
      { startByte: 3, endByte: 2 },
    ]);
    expect(highlightedText(segments)).toBe("c");
    expect(joinedText(segments)).toBe("abc");
  });

  it("orders multiple disjoint ranges left to right", () => {
    const segments = highlightSegmentsFromByteRanges("one two three", [
      { startByte: 4, endByte: 7 },
      { startByte: 0, endByte: 3 },
    ]);
    expect(segments).toEqual([
      { text: "one", highlighted: true, start: 0 },
      { text: " ", highlighted: false, start: 3 },
      { text: "two", highlighted: true, start: 4 },
      { text: " three", highlighted: false, start: 7 },
    ]);
  });
});
