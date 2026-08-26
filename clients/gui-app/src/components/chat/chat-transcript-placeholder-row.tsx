import { memo } from "react";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { cn } from "@/lib/utils";
import { placeholderRowHeight } from "@/components/chat/chat-transcript-placeholder-height";

/**
 * A row the transcript knows exists but holds no body for.
 *
 * Its job is to occupy the right ordinal at roughly the right height so the
 * scrollbar describes the whole chat rather than the loaded part of it, and so
 * the viewport has something to report when the reader scrolls into unhydrated
 * history. It is deliberately quiet: a skeleton shimmer at every unvisited
 * ordinal would make an ordinary scroll look like a chat that is broken.
 */

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
