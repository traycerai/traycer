import { describe, expect, it } from "vitest";
import { diffLineCountsFromContents } from "@/lib/file-change-diff-hunks";

describe("diffLineCountsFromContents", () => {
  it("honors ignoreWhitespace for header counts", () => {
    const beforeContent = "const value = 1;\n";
    const afterContent = "const value = 1;   \n";

    expect(
      diffLineCountsFromContents(beforeContent, afterContent, false),
    ).toEqual({
      additions: 1,
      deletions: 1,
    });
    expect(
      diffLineCountsFromContents(beforeContent, afterContent, true),
    ).toEqual({
      additions: 0,
      deletions: 0,
    });
  });
});
