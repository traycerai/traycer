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
 * A successful load is memoized. A failed one is forgotten, so the next
 * PDF opened retries: remembering it would turn one network blip into "no
 * PDF previews until restart" on a desktop, while an engine that genuinely
 * cannot run the chunk fails fast again from the browser's cache (and in
 * the mobile app the chunk is a local asset - nothing is re-downloaded).
 */
type PdfPreviewModule = typeof import("./pdf-preview");

let loaded: Promise<PdfPreviewModule> | null = null;

export function loadPdfPreview(): Promise<PdfPreviewModule> {
  if (loaded === null) {
    const attempt = import("./pdf-preview");
    loaded = attempt;
    void attempt.catch(() => {
      if (loaded === attempt) loaded = null;
    });
  }
  return loaded;
}
