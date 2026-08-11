import { beforeEach, describe, expect, it, vi } from "vitest";
import { structuredPatch } from "diff";
import {
  diffLineCountsFromContents,
  resetDiffLineCountCacheForTests,
} from "@/lib/file-change-diff-hunks";

vi.mock("diff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("diff")>();
  return { ...actual, structuredPatch: vi.fn(actual.structuredPatch) };
});

describe("diffLineCountsFromContents", () => {
  beforeEach(() => {
    resetDiffLineCountCacheForTests();
  });

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

describe("diffLineCountsFromContents memoization", () => {
  beforeEach(() => {
    resetDiffLineCountCacheForTests();
    vi.mocked(structuredPatch).mockClear();
  });

  it("diffs a given pair of revisions once, however many times it is asked", () => {
    // Freshly built strings on every call, mirroring the panel: the host's
    // accumulated changes are re-decoded per frame, so nothing upstream can
    // memoize them by object identity.
    const before = (): string =>
      ["line one", "line two", "line three"].join("\n");
    const after = (): string =>
      ["line one", "line two changed", "line three"].join("\n");

    const first = diffLineCountsFromContents(before(), after(), false);
    const second = diffLineCountsFromContents(before(), after(), false);
    const third = diffLineCountsFromContents(before(), after(), false);

    expect(first).toEqual({ additions: 1, deletions: 1 });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(vi.mocked(structuredPatch)).toHaveBeenCalledTimes(1);
  });

  it("does not serve one revision pair's counts for another's", () => {
    const before = "a\nb\n";

    const unchanged = diffLineCountsFromContents(before, "a\nb\n", false);
    const oneEdit = diffLineCountsFromContents(before, "a\nB\n", false);
    const twoEdits = diffLineCountsFromContents(before, "A\nB\n", false);

    expect(unchanged).toEqual({ additions: 0, deletions: 0 });
    expect(oneEdit).toEqual({ additions: 1, deletions: 1 });
    expect(twoEdits).toEqual({ additions: 2, deletions: 2 });
  });

  it("keys on the whitespace mode as well as the content", () => {
    const before = "const value = 1;\n";
    const after = "const value = 1;   \n";

    expect(diffLineCountsFromContents(before, after, false)).toEqual({
      additions: 1,
      deletions: 1,
    });
    expect(diffLineCountsFromContents(before, after, true)).toEqual({
      additions: 0,
      deletions: 0,
    });
    expect(vi.mocked(structuredPatch)).toHaveBeenCalledTimes(2);
  });
});
