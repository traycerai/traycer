import type { FileEditReason } from "@/stores/composer/chat-store";

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
