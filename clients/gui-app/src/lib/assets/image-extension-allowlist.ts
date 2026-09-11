/**
 * Single source for the client-side extension gate (image-preview decision
 * log, decision #6): the workspace file tile and git diff tile both check a
 * path against this allowlist BEFORE opening `workspace.streamAsset` /
 * `git.streamFileAsset`, so a non-asset file never touches the asset stream.
 * The host still validates independently via magic bytes and answers with
 * the authoritative `mediaType` - routing only ever needs a boolean here,
 * never a candidate media type to trust.
 */
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);

/**
 * The document formats the app previews in a dedicated viewer (pdf.js for
 * PDF, docx-preview for Word). Each routes to its OWN renderer, but every
 * other surface treats them alike: no text diff, no line counts, a
 * placeholder that names the format, and an Open Externally that prefers
 * the OS default application over the code editor.
 */
export type DocumentAssetKind = "pdf" | "docx";

const DOCUMENT_KIND_BY_EXTENSION: ReadonlyMap<string, DocumentAssetKind> =
  new Map([
    [".pdf", "pdf"],
    [".docx", "docx"],
  ]);

/** What each format is called in user-facing copy ("PDF diffs aren't previewed."). */
export const DOCUMENT_ASSET_LABELS: Record<DocumentAssetKind, string> = {
  pdf: "PDF",
  docx: "Word document",
};

function extensionOf(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  return path.slice(dot).toLowerCase();
}

/** Whether `path`'s extension routes to the image asset stream at all. */
export function isImageAssetPath(path: string): boolean {
  const extension = extensionOf(path);
  return extension !== null && IMAGE_EXTENSIONS.has(extension);
}

/**
 * SVG is text to git and valid UTF-8 to `readFile` (image-preview decision
 * log, decision #5) - both tiles route it to image preview by default with a
 * per-tile toggle back to the existing source view, unlike the other four
 * formats which have no source view at all.
 */
export function isSvgAssetPath(path: string): boolean {
  return extensionOf(path) === ".svg";
}

/**
 * Which document viewer `path`'s extension routes to, or `null` for a
 * non-document. Kept separate from `isImageAssetPath` because documents and
 * images route to DIFFERENT renderers (a viewer vs an `<img>`). A document
 * additionally needs the host to have negotiated the asset stream minor that
 * added its media type - the STREAM's own negotiation decides that, and an
 * old host's refusal degrades inside `useFileAsset`; nothing here gates on
 * versions.
 */
export function documentAssetKindOf(path: string): DocumentAssetKind | null {
  const extension = extensionOf(path);
  if (extension === null) return null;
  return DOCUMENT_KIND_BY_EXTENSION.get(extension) ?? null;
}

/** Whether `path` routes to ANY document viewer - the "no text diff" union. */
export function isDocumentAssetPath(path: string): boolean {
  return documentAssetKindOf(path) !== null;
}

/** Any extension the asset stream can serve - the "should this enter asset mode at all" union. */
export function isPreviewableAssetPath(path: string): boolean {
  return isImageAssetPath(path) || isDocumentAssetPath(path);
}
