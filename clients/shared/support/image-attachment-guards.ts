/**
 * Shared image-attachment guard rules for report-issue image ingest (ticket
 * 08 / tech-plan T5). Both the renderer's attach-time checks
 * (`use-report-issue-attachments.ts`) and Electron main's authoritative
 * revalidation (`support-ipc.ts`) import from here, so the two enforcement
 * points can never drift apart.
 *
 * The magic-byte patterns below are copied from `matchesImageMagicBytes` in
 * `traycer-host/src/harnesses/runtime-image-attachments.ts` (INTERNAL repo)
 * rather than imported across the repo boundary - this module ships in the
 * OSS `traycer/` submodule, which cannot depend on the internal host, and the
 * internal host cannot depend on this OSS package either. Keep the two sets
 * of patterns in sync by hand; `runtime-image-attachments.ts` carries the
 * matching provenance comment pointing back here.
 */

export type ReportAttachmentMediaType =
  "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export const MAX_REPORT_IMAGES = 3;

// Matches the composer's per-image cap (`use-composer-paste.ts`'s
// `MAX_IMAGE_BYTES`) - same 5 MiB rule. Duplicated rather than imported:
// that module is gui-app-only (tiptap-coupled insertion), while this needs
// to be reachable from Electron main too.
export const MAX_REPORT_IMAGE_BYTES = 5 * 1024 * 1024;

// Matches the composer's read timeout (`use-composer-paste.ts`'s
// `IMAGE_READ_TIMEOUT_MS`).
export const REPORT_IMAGE_READ_TIMEOUT_MS = 15_000;

// Matches `support.ts`'s per-log-tail cap (`LOG_ATTACHMENT_MAX_BYTES`, which
// imports this constant rather than redefining it - see that file).
export const REPORT_LOG_TAIL_MAX_BYTES = 512_000;

/**
 * Total attachment budget (Critique G5): 3 images x 5 MiB (15 MiB) + 2 log
 * tails x ~512 KB (~1 MiB) = ~16 MiB of real payload. 20 MiB total leaves
 * ~4 MiB of headroom for Sentry envelope framing/JSON overhead around that
 * payload, comfortably under Sentry's server-side envelope ceiling. This is
 * enforced at attach time in the UI (never silently at flush, see the ticket
 * 08 guardrail) and re-enforced by Electron main's IPC parser.
 */
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
 * True when `imageBytesTotal` (the sum of every attached image's byte
 * length) would push the report's total attachment payload - images plus
 * both frozen log tails - over {@link TOTAL_ATTACHMENT_BUDGET_BYTES}. Both
 * tails are counted at their max cap regardless of whether the consent
 * panel's log toggles are on, since the budget must hold even when a retry
 * flips a toggle back on after this check ran.
 */
export function reportImagesExceedBudget(imageBytesTotal: number): boolean {
  return (
    imageBytesTotal + 2 * REPORT_LOG_TAIL_MAX_BYTES >
    TOTAL_ATTACHMENT_BUDGET_BYTES
  );
}

/**
 * Verifies the first 12 decoded bytes of an image payload against the
 * canonical magic byte sequence for its declared media type. Copied
 * verbatim from `matchesImageMagicBytes` in `traycer-host/src/harnesses/
 * runtime-image-attachments.ts` (internal repo) - see that file's matching
 * provenance comment. Keep the two in sync by hand.
 */
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
