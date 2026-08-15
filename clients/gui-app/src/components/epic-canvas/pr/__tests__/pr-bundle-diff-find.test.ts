import { describe, expect, it } from "vitest";
import type { PrLocalDiffSummaryFile } from "@traycer/protocol/host/pr-schemas";
import { isPrLocalDiffLargeFile } from "@/lib/pr/pr-local-diff-large-file";
import {
  prBundleDiffFindFileId,
  prBundleLoadedPatchCacheKey,
} from "@/components/epic-canvas/pr/pr-bundle-diff-find";

function file(
  overrides: Partial<PrLocalDiffSummaryFile>,
): PrLocalDiffSummaryFile {
  return {
    path: "src/a.ts",
    previousPath: null,
    status: "modified",
    insertions: 3,
    deletions: 1,
    isBinary: false,
    ...overrides,
  };
}

describe("isPrLocalDiffLargeFile", () => {
  it("is large when insertions is null", () => {
    expect(isPrLocalDiffLargeFile(file({ insertions: null }))).toBe(true);
  });

  it("is large when deletions is null", () => {
    expect(isPrLocalDiffLargeFile(file({ deletions: null }))).toBe(true);
  });

  it("is large when insertions + deletions exceeds the threshold", () => {
    expect(
      isPrLocalDiffLargeFile(file({ insertions: 900, deletions: 101 })),
    ).toBe(true);
  });

  it("is not large when insertions + deletions is at or under the threshold", () => {
    expect(
      isPrLocalDiffLargeFile(file({ insertions: 900, deletions: 100 })),
    ).toBe(false);
  });
});

describe("prBundleDiffFindFileId", () => {
  it("prefixes the path with pr:", () => {
    expect(prBundleDiffFindFileId(file({ path: "src/a.ts" }))).toBe(
      "pr:src/a.ts",
    );
  });
});

describe("prBundleLoadedPatchCacheKey", () => {
  function key(overrides: {
    readonly comparisonKey?: string;
    readonly file?: PrLocalDiffSummaryFile;
    readonly ignoreWhitespace?: boolean;
    readonly isTruncated?: boolean;
  }): string {
    return prBundleLoadedPatchCacheKey({
      comparisonKey: "base..head",
      file: file({}),
      ignoreWhitespace: false,
      isTruncated: false,
      ...overrides,
    });
  }

  it("is equal for equal inputs", () => {
    expect(key({})).toBe(key({}));
  });

  it("differs when comparisonKey differs", () => {
    expect(key({ comparisonKey: "base..head" })).not.toBe(
      key({ comparisonKey: "other..head" }),
    );
  });

  it("differs when ignoreWhitespace differs", () => {
    expect(key({ ignoreWhitespace: false })).not.toBe(
      key({ ignoreWhitespace: true }),
    );
  });

  it("differs when isTruncated differs", () => {
    expect(key({ isTruncated: false })).not.toBe(key({ isTruncated: true }));
  });

  it("differs when the file's path differs", () => {
    expect(key({ file: file({ path: "src/a.ts" }) })).not.toBe(
      key({ file: file({ path: "src/b.ts" }) }),
    );
  });

  it("differs when the file's previousPath differs", () => {
    expect(key({ file: file({ previousPath: null }) })).not.toBe(
      key({ file: file({ previousPath: "src/old.ts" }) }),
    );
  });

  it("cannot collide across fields for a path containing the JSON-unsafe marker string", () => {
    const weirdPath = 'pr-local-diff","truncated';
    const a = prBundleLoadedPatchCacheKey({
      comparisonKey: "base..head",
      file: file({ path: weirdPath, previousPath: null }),
      ignoreWhitespace: false,
      isTruncated: false,
    });
    const b = prBundleLoadedPatchCacheKey({
      comparisonKey: "base..head",
      file: file({ path: "src/a.ts", previousPath: null }),
      ignoreWhitespace: false,
      isTruncated: true,
    });
    expect(a).not.toBe(b);
  });
});
