import { describe, expect, it } from "vitest";
import { tabMonogram } from "../tab-monogram";

describe("tabMonogram", () => {
  it("takes the first letter of each of the first two words", () => {
    expect(tabMonogram("fix login bug")).toBe("FL");
  });

  it("takes one letter from a one-word title", () => {
    expect(tabMonogram("refactor")).toBe("R");
  });

  it("counts digits as significant", () => {
    expect(tabMonogram("42 answers")).toBe("4A");
  });

  it("skips emoji-only words and keeps an emoji out of the monogram", () => {
    expect(tabMonogram("🚀 launch plan")).toBe("LP");
    expect(tabMonogram("👨‍👩‍👧‍👦")).toBeNull();
  });

  it("keeps a letter and its combining mark together as one grapheme", () => {
    // "e" followed by U+0301 COMBINING ACUTE ACCENT, spelled out so the case is visible.
    const decomposed = "éclair recipe";
    expect(tabMonogram(decomposed)).toBe("ÉR");
  });

  it("keeps precomposed accented letters and upper-cases them", () => {
    expect(tabMonogram("éclair recipe")).toBe("ÉR");
    expect(tabMonogram("école ouverte")).toBe("ÉO");
  });

  it("uses CJK characters as they are, since the script has no case", () => {
    const monogram = tabMonogram("修复登录");
    expect(monogram).not.toBeNull();
    expect(monogram?.startsWith("修")).toBe(true);
    expect(tabMonogram("バグ 修正")).toBe("バ修");
  });

  it("keeps right-to-left titles in logical order with no case change", () => {
    expect(tabMonogram("שלום עולם")).toBe("שע");
    expect(tabMonogram("مرحبا بالعالم")).toBe("مب");
  });

  it("skips leading punctuation", () => {
    expect(tabMonogram("  -- (draft) notes")).toBe("DN");
  });

  it("returns null for a punctuation-only title", () => {
    expect(tabMonogram("... --- !!!")).toBeNull();
  });

  it("returns null for an empty or blank title", () => {
    expect(tabMonogram("")).toBeNull();
    expect(tabMonogram("   ")).toBeNull();
  });
});
