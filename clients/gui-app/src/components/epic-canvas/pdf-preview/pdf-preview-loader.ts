/**
 * Retrying a failure is not ours to offer: the browser's module map records a failed fetch or evaluation for the document's lifetime and rejects every later `import()` of that URL without refetching (verified live - only a reload starts over), which also means an engine that cannot run the chunk fails instantly on every later PDF.
 */
type PdfPreviewModule = typeof import("./pdf-preview");

let loaded: Promise<PdfPreviewModule> | null = null;

export function loadPdfPreview(): Promise<PdfPreviewModule> {
  loaded ??= import("./pdf-preview");
  return loaded;
}
