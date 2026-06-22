import { describe, expect, it } from "vitest";
import { splitPathMatchRanges } from "@/lib/git/path-highlight";

describe("splitPathMatchRanges", () => {
  it("returns empty ranges when there are no matches", () => {
    const result = splitPathMatchRanges(
      "src/foo/bar.ts",
      "bar.ts",
      "src/foo",
      [],
    );
    expect(result.fileNameRanges).toEqual([]);
    expect(result.directoryRanges).toEqual([]);
  });

  it("maps a filename-only match onto the filename segment", () => {
    // "src/foo/bar.ts": fileName starts at index 8.
    const result = splitPathMatchRanges("src/foo/bar.ts", "bar.ts", "src/foo", [
      [8, 10],
    ]);
    expect(result.fileNameRanges).toEqual([[0, 2]]);
    expect(result.directoryRanges).toEqual([]);
  });

  it("maps a directory match onto the directory segment", () => {
    // Match "foo" at indices 4-6 (inside the directory portion).
    const result = splitPathMatchRanges("src/foo/bar.ts", "bar.ts", "src/foo", [
      [4, 6],
    ]);
    expect(result.directoryRanges).toEqual([[4, 6]]);
    expect(result.fileNameRanges).toEqual([]);
  });

  it("splits a range that straddles the separator into both segments", () => {
    // Indices 5-9 cover "oo/ba": directory [5,6], separator at 7 (skipped),
    // filename "ba" maps to [0,1].
    const result = splitPathMatchRanges("src/foo/bar.ts", "bar.ts", "src/foo", [
      [5, 9],
    ]);
    expect(result.directoryRanges).toEqual([[5, 6]]);
    expect(result.fileNameRanges).toEqual([[0, 1]]);
  });

  it("handles a root-level file with no directory", () => {
    const result = splitPathMatchRanges("README.md", "README.md", "", [[0, 2]]);
    expect(result.fileNameRanges).toEqual([[0, 2]]);
    expect(result.directoryRanges).toEqual([]);
  });
});
