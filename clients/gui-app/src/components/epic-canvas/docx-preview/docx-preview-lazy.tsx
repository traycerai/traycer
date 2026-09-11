/**
 * The only sanctioned entry to `DocxPreview` - see `lazy-document-viewer.tsx`
 * for the loading and "viewer unavailable" contract, and
 * `docx-preview-loader.ts` for why the chunk load itself is the support
 * check.
 */
import { createLazyDocumentViewer } from "@/components/epic-canvas/document-preview/lazy-document-viewer";
import { loadDocxPreview } from "./docx-preview-loader";

/** Placeholder copy for a viewer that could not load or start here. */
export const DOCX_VIEWER_UNAVAILABLE_REASON =
  "The Word document viewer could not be loaded on this device.";

export const DocxPreviewLazy = createLazyDocumentViewer({
  load: loadDocxPreview,
  logTag: "docx-preview",
});
