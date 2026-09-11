import { describe, expect, it } from "vitest";
import type { GitChangedFile } from "@traycer/protocol/host";
import {
  gitImageDiffRouting,
  gitRoutesToDocumentDiffBlock,
} from "../git-diff-tile";

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

describe("gitRoutesToDocumentDiffBlock", () => {
  it("routes a modified binary PDF", () => {
    expect(gitRoutesToDocumentDiffBlock(file({}))).toBe(true);
  });

  // Word documents share the block by extension alone - the router is a
  // document-format union, not a PDF special case.
  it("routes a modified binary Word document", () => {
    expect(
      gitRoutesToDocumentDiffBlock(file({ path: "docs/brief.docx" })),
    ).toBe(true);
  });

  it("routes when only the previous path is a document and the new side is binary", () => {
    // `old.pdf -> new.bin`: nothing to read on either side, so the block's
    // named old side beats the binary placeholder.
    expect(
      gitRoutesToDocumentDiffBlock(
        file({ path: "docs/report.bin", previousPath: "docs/report.pdf" }),
      ),
    ).toBe(true);
    expect(
      gitRoutesToDocumentDiffBlock(
        file({ path: "docs/brief.bin", previousPath: "docs/brief.docx" }),
      ),
    ).toBe(true);
  });

  it("keeps the text diff when a document was renamed into a readable file", () => {
    // `old.pdf -> new.txt` with `isBinary: false` has a real source diff on
    // the surviving side; a summary block about a file that is no longer a
    // document would discard it.
    expect(
      gitRoutesToDocumentDiffBlock(
        file({
          path: "docs/report.txt",
          previousPath: "docs/report.pdf",
          isBinary: false,
        }),
      ),
    ).toBe(false);
    expect(
      gitRoutesToDocumentDiffBlock(
        file({
          path: "docs/brief.txt",
          previousPath: "docs/brief.docx",
          isBinary: false,
        }),
      ),
    ).toBe(false);
  });

  it("routes a conflicted PDF even when isBinary was left false (numstat gap)", () => {
    expect(
      gitRoutesToDocumentDiffBlock(
        file({ stage: "conflicted", isBinary: false }),
      ),
    ).toBe(true);
  });

  it("does not route non-document paths", () => {
    expect(
      gitRoutesToDocumentDiffBlock(file({ path: "docs/report.txt" })),
    ).toBe(false);
    expect(
      gitRoutesToDocumentDiffBlock(file({ path: "images/logo.png" })),
    ).toBe(false);
    // Legacy `.doc` is a different (binary OLE) format with no viewer here.
    expect(
      gitRoutesToDocumentDiffBlock(file({ path: "docs/legacy.doc" })),
    ).toBe(false);
  });

  it("routes a non-binary .pdf path (the SVG precedent: ASCII-authored PDFs sniff as text)", () => {
    expect(gitRoutesToDocumentDiffBlock(file({ isBinary: false }))).toBe(true);
  });

  it("yields to image routing on a rename straddling both allowlists", () => {
    // `a.png -> b.pdf` matches both routers; the tile checks image routing
    // FIRST, so this pins that such a file is still an image-diff candidate
    // (the document router also matching is fine - it is never reached).
    const straddling = file({
      path: "docs/report.pdf",
      previousPath: "images/logo.png",
    });
    expect(gitImageDiffRouting(straddling).routeToImageDiff).toBe(true);
    expect(gitRoutesToDocumentDiffBlock(straddling)).toBe(true);
  });
});
