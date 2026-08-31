import { describe, expect, it } from "vitest";
import type { GitChangedFile } from "@traycer/protocol/host";
import { gitImageDiffRouting, gitRoutesToPdfDiffCards } from "../git-diff-tile";

function file(overrides: Partial<GitChangedFile>): GitChangedFile {
  return {
    path: "docs/report.pdf",
    previousPath: null,
    status: "modified",
    stage: "unstaged",
    insertions: 0,
    deletions: 0,
    isBinary: true,
    sizeBytes: 2_048,
    stagedOid: null,
    worktreeOid: null,
    ...overrides,
  };
}

describe("gitRoutesToPdfDiffCards", () => {
  it("routes a modified binary PDF", () => {
    expect(gitRoutesToPdfDiffCards(file({}))).toBe(true);
  });

  it("routes when only the previous path is a PDF (rename away from PDF)", () => {
    expect(
      gitRoutesToPdfDiffCards(
        file({ path: "docs/report.bin", previousPath: "docs/report.pdf" }),
      ),
    ).toBe(true);
  });

  it("routes a conflicted PDF even when isBinary was left false (numstat gap)", () => {
    expect(
      gitRoutesToPdfDiffCards(file({ stage: "conflicted", isBinary: false })),
    ).toBe(true);
  });

  it("does not route non-PDF paths", () => {
    expect(gitRoutesToPdfDiffCards(file({ path: "docs/report.txt" }))).toBe(
      false,
    );
    expect(gitRoutesToPdfDiffCards(file({ path: "images/logo.png" }))).toBe(
      false,
    );
  });

  it("routes a non-binary .pdf path (the SVG precedent: ASCII-authored PDFs sniff as text)", () => {
    expect(gitRoutesToPdfDiffCards(file({ isBinary: false }))).toBe(true);
  });

  it("yields to image routing on a rename straddling both allowlists", () => {
    // `a.png -> b.pdf` matches both routers; the tile checks image routing
    // FIRST, so this pins that such a file is still an image-diff candidate
    // (the pdf router also matching is fine - it is never reached).
    const straddling = file({
      path: "docs/report.pdf",
      previousPath: "images/logo.png",
    });
    expect(gitImageDiffRouting(straddling).routeToImageDiff).toBe(true);
    expect(gitRoutesToPdfDiffCards(straddling)).toBe(true);
  });
});
