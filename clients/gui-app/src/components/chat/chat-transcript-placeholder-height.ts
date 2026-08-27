import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";

/**
 * The OPENING guess at an unhydrated row's rendered height, in px.
 *
 * `byteLength` is the only size signal the skeleton carries, and the schema
 * puts it there for exactly this ("it lets the list give an unhydrated row a
 * plausible height instead of the flat default, which is what stops the
 * scrollbar from lurching as rows hydrate"). It is a HINT and is treated as
 * one - LegendList remeasures the moment a real body lands, and the follow
 * latch is what keeps the tail pinned across that correction.
 *
 * This is only the opening guess. Once the transcript has MEASURED some rows,
 * `chat-transcript-row-height-memory.ts` supersedes it - exactly for a row it
 * has measured before, and scaled by what this function's error turned out to
 * be for every other row. Read that module's doc for the division of labour;
 * the constants here only have to be reasonable before any row has been seen.
 *
 * ## Why bytes alone are capped so hard
 *
 * Because `byteLength` on its own is a WEAK predictor of pixels, and measuring
 * a real transcript is what settled it. In a 403-row chat the two roles carried
 * almost the same bytes and rendered 39x apart:
 *
 * | role      | byteLength (p50) | renders | px per byte |
 * | --------- | ---------------- | ------- | ----------- |
 * | user      | 31,612           | 212px   | 0.0067      |
 * | assistant | 30,902           | 8,224px | 0.266       |
 *
 * A long user message is clamped to a bubble; an assistant turn of the same
 * size draws every line of it. So the linear byte model cannot be trusted far
 * from the floor until something has actually been MEASURED - which is why the
 * uncalibrated cap stays where it has always been, and only the CALIBRATED
 * estimate in `chat-transcript-row-height-memory.ts` is allowed to reach the
 * heights real rows reach. Raising this cap on its own was tried and made user
 * rows worse (212px rows standing at 3200) exactly as fast as it made assistant
 * rows better.
 *
 * Lives here rather than in `chat-transcript-placeholder-row.tsx` so that
 * component file keeps exporting only components (Fast Refresh) - same split
 * as `chat-messages-scroll-helpers.ts`.
 */
export const PLACEHOLDER_MIN_HEIGHT_PX = 44;
/**
 * The cap while NOTHING about this chat has been measured. Deliberately the
 * long-standing value: with no evidence, a big byte count is not evidence of a
 * tall row (see the table above), so the no-evidence answer should stay the
 * conservative one it has always been.
 */
export const PLACEHOLDER_UNCALIBRATED_MAX_HEIGHT_PX = 320;
/**
 * The floor of the CALIBRATED ceiling. Once a scale factor exists the estimate
 * may reach real row heights; this is only the absurdity rail beneath which
 * that ceiling never drops, and it rises to the tallest row actually measured.
 */
export const PLACEHOLDER_MAX_HEIGHT_PX = 3200;
/** Bytes of transcript that typically render as one line at usual widths. */
const PLACEHOLDER_BYTES_PER_LINE = 80;
const PLACEHOLDER_LINE_HEIGHT_PX = 22;

/**
 * A row the skeleton has not described yet.
 *
 * Deliberately NOT the one-line floor. A hole in the skeleton means "a row
 * exists here and nothing about it has arrived", and most rows in a transcript
 * are assistant turns, so sizing it as a single line guarantees the largest
 * possible correction the moment anything lands. This is superseded by the
 * measured average as soon as the memory has samples.
 */
export const PLACEHOLDER_UNKNOWN_HEIGHT_PX = 120;

/**
 * Clamp a candidate height into the range a placeholder may occupy.
 *
 * `ceiling` lets a caller that has MEASURED taller rows raise the cap to what
 * this chat's rows actually reach. A fixed cap below the real distribution is
 * not a safety rail, it is a guaranteed jump: rows that genuinely draw 8000px
 * would be held at 3200 and correct by 5000px the moment a body landed.
 */
export function clampPlaceholderHeight(
  height: number,
  ceiling: number,
): number {
  return Math.min(
    Math.max(PLACEHOLDER_MIN_HEIGHT_PX, ceiling),
    Math.max(PLACEHOLDER_MIN_HEIGHT_PX, Math.round(height)),
  );
}

/**
 * The linear byte model, UNCLAMPED.
 *
 * The memory calibrates against this rather than the clamped result, because a
 * clamped base is flat across everything above the cap - and a scale factor
 * fitted to a flat base cannot recover the size signal the clamp destroyed.
 */
export function rawPlaceholderRowHeight(byteLength: number): number {
  const lines = Math.ceil(byteLength / PLACEHOLDER_BYTES_PER_LINE);
  return PLACEHOLDER_MIN_HEIGHT_PX + lines * PLACEHOLDER_LINE_HEIGHT_PX;
}

/**
 * The estimate with no measurements behind it - the fallback for a surface that
 * keeps no memory, and the opening guess before this chat has calibrated.
 */
export function placeholderRowHeight(entry: RowSkeletonEntry | null): number {
  if (entry === null) return PLACEHOLDER_UNKNOWN_HEIGHT_PX;
  return clampPlaceholderHeight(
    rawPlaceholderRowHeight(entry.byteLength),
    PLACEHOLDER_UNCALIBRATED_MAX_HEIGHT_PX,
  );
}
