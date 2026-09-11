import { describe, expect, it } from "vitest";

import {
  DOCUMENT_ASSET_LABELS,
  documentAssetKindOf,
  isDocumentAssetPath,
  isImageAssetPath,
  isPreviewableAssetPath,
  isSvgAssetPath,
} from "../image-extension-allowlist";

describe("image extension allowlist", () => {
  it("routes supported extensions case-insensitively", () => {
    expect(isImageAssetPath("images/logo.PNG")).toBe(true);
    expect(isImageAssetPath("images/logo.jpg")).toBe(true);
    expect(isImageAssetPath("images/photo.jpeg")).toBe(true);
    expect(isImageAssetPath("images/animated.gif")).toBe(true);
    expect(isImageAssetPath("images/photo.webp")).toBe(true);
    expect(isImageAssetPath("images/icon.svg")).toBe(true);
  });

  it("rejects paths without an allowed image extension", () => {
    expect(isImageAssetPath("README.md")).toBe(false);
    expect(isImageAssetPath("no-extension")).toBe(false);
    expect(isImageAssetPath("images/scan.bmp")).toBe(false);
  });

  it("recognizes SVG paths case-insensitively without treating other images as SVG", () => {
    expect(isSvgAssetPath("icons/mark.svg")).toBe(true);
    expect(isSvgAssetPath("icons/mark.SVG")).toBe(true);
    expect(isSvgAssetPath("icons/mark.png")).toBe(false);
    expect(isSvgAssetPath("icons/mark")).toBe(false);
  });

  // Documents are NOT images - each format routes to its OWN renderer.
  it("routes documents separately from images", () => {
    expect(isImageAssetPath("docs/report.pdf")).toBe(false);
    expect(isImageAssetPath("docs/brief.docx")).toBe(false);
  });

  // Legacy `.doc` is the binary OLE format docx-preview cannot read - the
  // single-c extension must stay on the plain binary path.
  it("does not treat legacy .doc as a document", () => {
    expect(documentAssetKindOf("docs/legacy.doc")).toBeNull();
    expect(isDocumentAssetPath("docs/legacy.doc")).toBe(false);
    expect(isPreviewableAssetPath("docs/legacy.doc")).toBe(false);
  });

  it("names which viewer a path routes to, case-insensitively", () => {
    expect(documentAssetKindOf("docs/report.pdf")).toBe("pdf");
    expect(documentAssetKindOf("docs/report.PDF")).toBe("pdf");
    expect(documentAssetKindOf("docs/brief.docx")).toBe("docx");
    expect(documentAssetKindOf("docs/brief.DocX")).toBe("docx");
    expect(documentAssetKindOf("docs/report.pdf.txt")).toBeNull();
    expect(documentAssetKindOf("images/logo.png")).toBeNull();
    expect(documentAssetKindOf("no-extension")).toBeNull();
  });

  it("unions both document formats behind the no-text-diff predicate", () => {
    expect(isDocumentAssetPath("docs/report.pdf")).toBe(true);
    expect(isDocumentAssetPath("docs/brief.docx")).toBe(true);
    expect(isDocumentAssetPath("images/logo.png")).toBe(false);
    expect(isDocumentAssetPath("README.md")).toBe(false);
  });

  it("labels each document format the way user-facing copy names it", () => {
    expect(DOCUMENT_ASSET_LABELS.pdf).toBe("PDF");
    expect(DOCUMENT_ASSET_LABELS.docx).toBe("Word document");
  });

  it("treats the previewable union as images plus every document format", () => {
    expect(isPreviewableAssetPath("images/logo.png")).toBe(true);
    expect(isPreviewableAssetPath("docs/report.pdf")).toBe(true);
    expect(isPreviewableAssetPath("docs/brief.docx")).toBe(true);
    expect(isPreviewableAssetPath("README.md")).toBe(false);
  });
});
