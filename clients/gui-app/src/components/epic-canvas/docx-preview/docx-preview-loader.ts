/**
 * The Word viewer chunk's one loader - and the viewer's whole support gate,
 * on the same terms as `pdf-preview-loader.ts`: docx-preview and JSZip
 * target current engines, so on an old WKWebView the import ITSELF fails,
 * and that failure is the support check. No feature probe, no browser
 * table.
 *
 * One memoized promise, success or failure, so concurrent tiles share a
 * single import. A failure is deliberately not retried: the browser's module
 * map records a failed fetch or evaluation for the document's lifetime and
 * rejects every later `import()` of that URL without refetching.
 */
type DocxPreviewModule = typeof import("./docx-preview");

let loaded: Promise<DocxPreviewModule> | null = null;

export function loadDocxPreview(): Promise<DocxPreviewModule> {
  loaded ??= import("./docx-preview");
  return loaded;
}
