import { describe, it, expect } from "vitest";
import type { PrReviewThread } from "@traycer/protocol/host/pr-schemas";
import { buildPrReviewHunkPatch } from "@/lib/pr/pr-review-hunk";

/**
 * The adapter between GitHub's bare hunk and `parsePatchFiles`. The thing that
 * matters is the `@@` line: it is the only place the file's line numbers exist,
 * and the host clips long hunks, so both "header present" and "header gone"
 * are real inputs.
 */

function thread(overrides: Partial<PrReviewThread>): PrReviewThread {
  return {
    id: "PRRT_1",
    reviewId: "PRR_1",
    path: "src/a.ts",
    line: 22,
    originalLine: 20,
    side: "right",
    subject: "line",
    isResolved: false,
    isOutdated: false,
    diffHunk: null,
    comments: [],
    totalCommentCount: 0,
    ...overrides,
  };
}

function hunkLine(patch: string, index: number): string {
  return patch.split("\n")[index] ?? "";
}

describe("buildPrReviewHunkPatch", () => {
  it("keeps the header's start lines so the gutter matches the file", () => {
    const result = buildPrReviewHunkPatch(
      thread({
        diffHunk: [
          "@@ -120,3 +126,5 @@ function f() {",
          " ctx",
          "+one",
          "+two",
        ].join("\n"),
      }),
    );

    expect(result?.lineNumbers).toBe(true);
    // Counts are recomputed from the body that is actually present, not copied
    // from the header - a clipped hunk's header counts describe the ORIGINAL.
    expect(hunkLine(result?.patch ?? "", 3)).toBe("@@ -120,1 +126,3 @@");
  });

  it("wraps the hunk in the file headers the parser needs", () => {
    const result = buildPrReviewHunkPatch(
      thread({
        path: "traycer-host/src/domain/pr-detail/gh-sweep-runner.ts",
        diffHunk: "@@ -1,1 +1,2 @@\n ctx\n+added",
      }),
    );
    const patch = result?.patch ?? "";

    expect(hunkLine(patch, 0)).toBe(
      "diff --git a/traycer-host/src/domain/pr-detail/gh-sweep-runner.ts b/traycer-host/src/domain/pr-detail/gh-sweep-runner.ts",
    );
    expect(hunkLine(patch, 1)).toBe(
      "--- a/traycer-host/src/domain/pr-detail/gh-sweep-runner.ts",
    );
    expect(hunkLine(patch, 2)).toBe(
      "+++ b/traycer-host/src/domain/pr-detail/gh-sweep-runner.ts",
    );
    expect(patch.endsWith("+added\n")).toBe(true);
  });

  it("switches the gutter off when the header was clipped away", () => {
    // A number that is merely plausible is worse than no number at all when
    // the entire job of the panel is to say WHERE the finding is.
    const result = buildPrReviewHunkPatch(
      thread({ diffHunk: " ctx\n-gone\n+kept" }),
    );

    expect(result?.lineNumbers).toBe(false);
    expect(hunkLine(result?.patch ?? "", 3)).toBe("@@ -1,2 +1,2 @@");
  });

  it("does not count the no-newline marker as a line of either side", () => {
    const result = buildPrReviewHunkPatch(
      thread({
        diffHunk: [
          "@@ -5,2 +5,2 @@",
          "-old",
          "+new",
          "\\ No newline at end of file",
        ].join("\n"),
      }),
    );

    expect(hunkLine(result?.patch ?? "", 3)).toBe("@@ -5,1 +5,1 @@");
  });

  it("restores a context line whose leading space was stripped", () => {
    // An empty string would read to a patch parser as the end of the hunk,
    // silently truncating everything below it.
    const result = buildPrReviewHunkPatch(
      thread({ diffHunk: "@@ -1,3 +1,3 @@\n a\n\n b" }),
    );
    const patch = result?.patch ?? "";

    expect(hunkLine(patch, 5)).toBe(" ");
    expect(hunkLine(patch, 6)).toBe(" b");
    expect(hunkLine(patch, 3)).toBe("@@ -1,3 +1,3 @@");
  });

  it("has nothing to render for a thread with no hunk or an empty one", () => {
    expect(buildPrReviewHunkPatch(thread({ diffHunk: null }))).toBeNull();
    expect(buildPrReviewHunkPatch(thread({ diffHunk: "" }))).toBeNull();
    expect(
      buildPrReviewHunkPatch(thread({ diffHunk: "@@ -1,0 +1,0 @@\n" })),
    ).toBeNull();
  });
});
