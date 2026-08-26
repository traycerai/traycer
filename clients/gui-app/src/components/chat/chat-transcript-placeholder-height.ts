import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";

/**
 * Rough rendered height for an unhydrated row, in px.
 *
 * `byteLength` is the only size signal the skeleton carries. It was put there
 * for the eviction budget rather than for layout, so this is an ESTIMATE and
 * is treated as one - LegendList remeasures the moment a real body lands, and
 * the follow latch is what keeps the tail pinned across that correction.
 *
 * The mapping is deliberately coarse and clamped at both ends. Too small and a
 * long history collapses into a scrollbar that lurches on every hydration; too
 * large and the reader scrolls through empty space to reach content. The floor
 * is about one line of text plus the row's own padding.
 *
 * Lives here rather than in `chat-transcript-placeholder-row.tsx` so that
 * component file keeps exporting only components (Fast Refresh) - same split
 * as `chat-messages-scroll-helpers.ts`.
 */
const PLACEHOLDER_MIN_HEIGHT_PX = 44;
const PLACEHOLDER_MAX_HEIGHT_PX = 320;
/** Bytes of transcript that typically render as one line at usual widths. */
const PLACEHOLDER_BYTES_PER_LINE = 80;
const PLACEHOLDER_LINE_HEIGHT_PX = 22;

export function placeholderRowHeight(entry: RowSkeletonEntry | null): number {
  if (entry === null) return PLACEHOLDER_MIN_HEIGHT_PX;
  const lines = Math.ceil(entry.byteLength / PLACEHOLDER_BYTES_PER_LINE);
  const height = PLACEHOLDER_MIN_HEIGHT_PX + lines * PLACEHOLDER_LINE_HEIGHT_PX;
  return Math.min(PLACEHOLDER_MAX_HEIGHT_PX, height);
}
