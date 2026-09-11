/**
 * The only sanctioned entry to `PdfPreview` - see `lazy-document-viewer.tsx`
 * for the loading and "viewer unavailable" contract, and
 * `pdf-preview-loader.ts` for why the chunk load itself is the support
 * check.
 */
import { createLazyDocumentViewer } from "@/components/epic-canvas/document-preview/lazy-document-viewer";
import { loadPdfPreview } from "./pdf-preview-loader";

/** Placeholder copy for a viewer that could not load or start here. */
export const PDF_VIEWER_UNAVAILABLE_REASON =
  "The PDF viewer could not be loaded on this device.";

export const PdfPreviewLazy = createLazyDocumentViewer({
  load: loadPdfPreview,
  logTag: "pdf-preview",
});
