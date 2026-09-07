import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";

/** So the linear byte model cannot be trusted far from the floor until something has actually been MEASURED - which is why the uncalibrated cap stays where it has always been, and only the CALIBRATED estimate in `chat-transcript-row-height-memory.ts` is allowed to reach the heights real rows reach. Lives here rather than in `chat-transcript-placeholder-row.tsx` so that component file keeps exporting only components (Fast Refresh) - same split as `chat-messages-scroll-helpers.ts`. */
export const PLACEHOLDER_MIN_HEIGHT_PX = 44;
/** The cap while NOTHING about this chat has been measured. Deliberately the long-standing value: with no evidence, a big byte count is not evidence of a tall row (see the table above), so the no-evidence answer should stay the conservative one it has always been. */
export const PLACEHOLDER_UNCALIBRATED_MAX_HEIGHT_PX = 320;
/** The floor of the CALIBRATED ceiling. Once a scale factor exists the estimate may reach real row heights; this is only the absurdity rail beneath which that ceiling never drops, and it rises to the tallest row actually measured. */
export const PLACEHOLDER_MAX_HEIGHT_PX = 3200;
/** Bytes of transcript that typically render as one line at usual widths. */
const PLACEHOLDER_BYTES_PER_LINE = 80;
const PLACEHOLDER_LINE_HEIGHT_PX = 22;

/** Deliberately NOT the one-line floor. */
export const PLACEHOLDER_UNKNOWN_HEIGHT_PX = 120;

/** A fixed cap below the real distribution is not a safety rail, it is a guaranteed jump: rows that genuinely draw 8000px would be held at 3200 and correct by 5000px the moment a body landed. */
export function clampPlaceholderHeight(
  height: number,
  ceiling: number,
): number {
  return Math.min(
    Math.max(PLACEHOLDER_MIN_HEIGHT_PX, ceiling),
    Math.max(PLACEHOLDER_MIN_HEIGHT_PX, Math.round(height)),
  );
}

/** The linear byte model, UNCLAMPED. The memory calibrates against this rather than the clamped result, because a clamped base is flat across everything above the cap - and a scale factor fitted to a flat base cannot recover the size signal the clamp destroyed. */
export function rawPlaceholderRowHeight(byteLength: number): number {
  const lines = Math.ceil(byteLength / PLACEHOLDER_BYTES_PER_LINE);
  return PLACEHOLDER_MIN_HEIGHT_PX + lines * PLACEHOLDER_LINE_HEIGHT_PX;
}

/** The estimate with no measurements behind it - the fallback for a surface that keeps no memory, and the opening guess before this chat has calibrated. */
export function placeholderRowHeight(entry: RowSkeletonEntry | null): number {
  if (entry === null) return PLACEHOLDER_UNKNOWN_HEIGHT_PX;
  return clampPlaceholderHeight(
    rawPlaceholderRowHeight(entry.byteLength),
    PLACEHOLDER_UNCALIBRATED_MAX_HEIGHT_PX,
  );
}
