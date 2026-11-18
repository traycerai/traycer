/**
 * The only sanctioned entry to `PdfPreview` - see `lazy-document-viewer.tsx`
 * for the loading and "viewer unavailable" contract.
 */
import { createLazyDocumentViewer } from "@/components/epic-canvas/document-preview/lazy-document-viewer";

/** Placeholder copy for a viewer that could not load or start here. */
export const PDF_VIEWER_UNAVAILABLE_REASON =
  "The PDF viewer could not be loaded on this device.";

export const PdfPreviewLazy = createLazyDocumentViewer({
  load: () => import("./pdf-preview"),
  logTag: "pdf-preview",
});
