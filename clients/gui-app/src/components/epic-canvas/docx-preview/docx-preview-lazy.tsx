/**
 * The only sanctioned entry to `DocxPreview` - see `lazy-document-viewer.tsx`
 * for the loading and "viewer unavailable" contract.
 */
import { createLazyDocumentViewer } from "@/components/epic-canvas/document-preview/lazy-document-viewer";

/** Placeholder copy for a viewer that could not load or start here. */
export const DOCX_VIEWER_UNAVAILABLE_REASON =
  "The Word document viewer could not be loaded on this device.";

export const DocxPreviewLazy = createLazyDocumentViewer({
  load: () => import("./docx-preview"),
  logTag: "docx-preview",
});
