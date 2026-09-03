/**
 * The viewer chunk's one loader - and the viewer's whole support gate.
 *
 * pdf.js targets current engines only (even its `legacy` build's floor is
 * Safari 18), so on an old WKWebView the import ITSELF fails: a parse error
 * on syntax the engine lacks, or a missing API thrown at module scope. That
 * failure is the support check. There is deliberately no feature probe
 * (`Promise.withResolvers`, ...) and no browser-version table to keep in
 * step with pdf.js - the next API it starts requiring fails the very same
 * way, with no code change here.
 *
 * One memoized promise, success or failure, so concurrent tiles share a
 * single import. Retrying a failure is not ours to offer: the browser's
 * module map records a failed fetch or evaluation for the document's
 * lifetime and rejects every later `import()` of that URL without
 * refetching (verified live - only a reload starts over), which also means
 * an engine that cannot run the chunk fails instantly on every later PDF.
 */
type PdfPreviewModule = typeof import("./pdf-preview");

let loaded: Promise<PdfPreviewModule> | null = null;

export function loadPdfPreview(): Promise<PdfPreviewModule> {
  loaded ??= import("./pdf-preview");
  return loaded;
}
