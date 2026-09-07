/**
 * Both the renderer's attach-time checks (`use-report-issue-attachments.ts`) and Electron main's authoritative revalidation (`support-ipc.ts`) import from here, so the two enforcement points can never drift apart.
 */

export type ReportAttachmentMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

export const MAX_REPORT_IMAGES = 3;

// Matches the composer's per-image cap (`use-composer-paste.ts`'s `MAX_IMAGE_BYTES`) - same 5 MiB rule.
// Duplicated rather than imported: that module is gui-app-only (tiptap-coupled insertion), while this needs to be reachable from Electron main too.
export const MAX_REPORT_IMAGE_BYTES = 5 * 1024 * 1024;

// Matches the composer's read timeout (`use-composer-paste.ts`'s
// `IMAGE_READ_TIMEOUT_MS`).
export const REPORT_IMAGE_READ_TIMEOUT_MS = 15_000;

// Matches `support.ts`'s per-log-tail cap (`LOG_ATTACHMENT_MAX_BYTES`, which
// imports this constant rather than redefining it - see that file).
export const REPORT_LOG_TAIL_MAX_BYTES = 512_000;

/** Was 2 before browser diagnostics existed. */
export const MAX_REPORT_LOG_ATTACHMENTS = 4;

export const TOTAL_ATTACHMENT_BUDGET_BYTES = 20 * 1024 * 1024;

export function reportImageMediaTypeForMimeType(
  mimeType: string,
): ReportAttachmentMediaType | null {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return "image/png";
    case "image/jpeg":
    case "image/jpg":
      return "image/jpeg";
    case "image/gif":
      return "image/gif";
    case "image/webp":
      return "image/webp";
    default:
      return null;
  }
}

/**
 * True when `imageBytesTotal` (the sum of every attached image's byte length) would push the report's total attachment payload - images plus every possible frozen log tail - over {@link TOTAL_ATTACHMENT_BUDGET_BYTES}.
 */
export function reportImagesExceedBudget(
  imageBytesTotal: number,
  attachedLogCount: number,
): boolean {
  return (
    imageBytesTotal + attachedLogCount * REPORT_LOG_TAIL_MAX_BYTES >
    TOTAL_ATTACHMENT_BUDGET_BYTES
  );
}

export function matchesReportImageMagicBytes(
  bytes: Uint8Array,
  mediaType: ReportAttachmentMediaType,
): boolean {
  if (bytes.length < 4) return false;
  switch (mediaType) {
    case "image/png":
      // 89 50 4E 47
      return (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
      );
    case "image/jpeg":
      // FF D8 FF
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif":
      // 47 49 46 38
      return (
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38
      );
    case "image/webp":
      // 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
      if (bytes.length < 12) return false;
      return (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
  }
}
