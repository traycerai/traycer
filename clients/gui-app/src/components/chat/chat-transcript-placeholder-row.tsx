import { memo } from "react";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { cn } from "@/lib/utils";

/**
 * A row the transcript knows exists but holds no body for.
 *
 * Its job is to occupy the right ordinal at roughly the right height so the
 * scrollbar describes the whole chat rather than the loaded part of it, and so
 * the viewport has something to report when the reader scrolls into unhydrated
 * history. It is deliberately quiet: a skeleton shimmer at every unvisited
 * ordinal would make an ordinary scroll look like a chat that is broken.
 */

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

interface ChatTranscriptPlaceholderRowProps {
  readonly entry: RowSkeletonEntry | null;
  readonly ordinal: number;
}

function ChatTranscriptPlaceholderRowImpl({
  entry,
  ordinal,
}: ChatTranscriptPlaceholderRowProps): React.JSX.Element {
  const height = placeholderRowHeight(entry);
  // A human user row is the one kind whose text the skeleton carries, so it is
  // the one kind that can say anything truthful about itself before it loads.
  const preview =
    entry !== null && entry.role === "user" && entry.sentByAgent !== true
      ? (entry.preview ?? null)
      : null;
  return (
    <div
      data-testid="chat-transcript-placeholder-row"
      data-ordinal={ordinal}
      aria-hidden="true"
      className={cn(
        "w-full px-4 py-2",
        entry !== null && entry.role === "user" && "flex justify-end",
      )}
      style={{ minHeight: `${height}px` }}
    >
      <div
        className={cn(
          "h-full w-full max-w-full rounded-md bg-foreground/5",
          entry !== null && entry.role === "user" && "max-w-[80%]",
        )}
        style={{ minHeight: `${height - 16}px` }}
      >
        {preview === null ? null : (
          <span className="line-clamp-2 px-3 py-2 text-sm text-muted-foreground/60">
            {preview}
          </span>
        )}
      </div>
    </div>
  );
}

export const ChatTranscriptPlaceholderRow = memo(
  ChatTranscriptPlaceholderRowImpl,
);
