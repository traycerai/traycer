import { describe, expect, it } from "vitest";
import { findTextMatches } from "../find-text";

describe("findTextMatches", () => {
  it("returns original-text offsets after a lowercase expansion", () => {
    expect(findTextMatches("İstanbul report", "report", false)).toEqual([
      { offset: 9, length: 6 },
    ]);
    expect(findTextMatches("İstanbul report", "İs", false)).toEqual([
      { offset: 0, length: 2 },
    ]);
    expect(findTextMatches("😀İstanbul report🚀", "report", false)).toEqual([
      { offset: 11, length: 6 },
    ]);
    expect(findTextMatches("😀İstanbul report🚀", "🚀", false)).toEqual([
      { offset: 17, length: 2 },
    ]);
  });

  it("keeps case-sensitive and case-insensitive matching literal", () => {
    expect(findTextMatches("Cat cat .", "cat", false)).toEqual([
      { offset: 0, length: 3 },
      { offset: 4, length: 3 },
    ]);
    expect(findTextMatches("Cat cat .", "cat", true)).toEqual([
      { offset: 4, length: 3 },
    ]);
    expect(findTextMatches("a.b", ".", false)).toEqual([
      { offset: 1, length: 1 },
    ]);
  });

  it("returns non-overlapping matches and no matches for an empty query", () => {
    expect(findTextMatches("aaaa", "aa", false)).toEqual([
      { offset: 0, length: 2 },
      { offset: 2, length: 2 },
    ]);
    expect(findTextMatches("anything", "", false)).toEqual([]);
  });
});
