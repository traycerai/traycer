import type { FileEditReason } from "@/stores/composer/chat-store";
import {
  DOCUMENT_ASSET_LABELS,
  documentAssetKindOf,
} from "@/lib/assets/image-extension-allowlist";

/**
 * User-facing copy for each `FileEditReason`, shown in place of a diff when one
 * can't be rendered. Single source of truth for the file-change row, the
 * snapshot bundle tile, and the artifact hash diff. Exhaustive `Record` so a new
 * reason is a compile error here rather than a silent generic fallback.
 */
export const FILE_EDIT_REASON_COPY: Record<FileEditReason, string> = {
  snapshot: "No changes.",
  binary: "Skipped - binary file.",
  too_large: "Skipped - file too large for diff.",
  blob_missing: "Skipped - snapshot blob missing.",
  capture_failed: "Edit failed - the file was not changed.",
  not_intercepted: "Skipped - edit was not intercepted.",
  denied: "Edit denied - the file was not changed.",
};

/**
 * Document-format stand-in for a snapshot text diff ("PDF file - text diff
 * not shown."). Snapshots retain only text content (binary captures are
 * rejected at the store), so the only documents that reach a snapshot patch
 * are ASCII-authored PDFs - and even for those, a line diff of PDF source is
 * noise, not review material. Callers only ask for paths that
 * `isDocumentAssetPath` already accepted; a non-document falls back to the
 * generic binary copy rather than a lie about its format.
 */
export function documentFileDiffCopy(filePath: string): string {
  const kind = documentAssetKindOf(filePath);
  if (kind === null) return FILE_EDIT_REASON_COPY.binary;
  return `${DOCUMENT_ASSET_LABELS[kind]} file - text diff not shown.`;
}
