import { memo, type ReactNode } from "react";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { placeholderRowHeight } from "@/components/chat/chat-transcript-placeholder-height";
import type { ChatTranscriptRowHeightMemory } from "@/components/chat/chat-transcript-row-height-memory";

/**
 * A row the transcript knows exists but holds no body for.
 *
 * Its job is to occupy the right ordinal at roughly the right height so the
 * scrollbar describes the whole chat rather than the loaded part of it, and so
 * the viewport has something to report when the reader scrolls into unhydrated
 * history. Its loading treatment mirrors the shared usage skeleton: a few
 * restrained lines inside the normal chat column, never a slab stretched to
 * the row's estimated height. The estimate still reserves scroll geometry,
 * while the visible placeholder reads as loading rather than missing content.
 *
 * "Roughly the right height" is the whole difficulty, and it is
 * `heightMemory`'s job rather than this component's - see that module. The
 * height is read once per mount and never subscribed to: a placeholder that
 * corrected itself while the reader was looking at it would be the same jump
 * this is here to avoid.
 */

interface ChatTranscriptPlaceholderRowProps {
  readonly entry: RowSkeletonEntry | null;
  readonly ordinal: number;
  /**
   * What this transcript has measured so far. `null` on a surface with no
   * memory of its own, which falls back to the raw byte estimate.
   */
  readonly heightMemory: ChatTranscriptRowHeightMemory | null;
}

const SKELETON_LINE_WIDTHS = ["w-full", "w-4/5", "w-2/3"] as const;

/** Keep the loading cluster inside the exact height the window estimated. */
function skeletonLineCount(height: number, userBubble: boolean): number {
  if (height >= 320) return Math.min(20, Math.max(3, Math.ceil(height / 160)));
  if (userBubble) {
    if (height >= 104) return 3;
    if (height >= 72) return 2;
    return 1;
  }
  if (height >= 80) return 3;
  if (height >= 56) return 2;
  return 1;
}

function ChatTranscriptPlaceholderRowImpl({
  entry,
  ordinal,
  heightMemory,
}: ChatTranscriptPlaceholderRowProps): React.JSX.Element {
  const height =
    heightMemory === null
      ? placeholderRowHeight(entry)
      : heightMemory.placeholderHeight(entry);
  // A human user row is the one kind whose text the skeleton carries, so it is
  // the one kind that can say anything truthful about itself before it loads.
  const preview =
    entry !== null && entry.role === "user" && entry.sentByAgent !== true
      ? (entry.preview ?? null)
      : null;
  const userBubble = entry !== null && entry.role === "user";
  const lineCount = skeletonLineCount(height, userBubble);
  const skeletonLines = Array.from(
    { length: lineCount },
    (_unused, lineNumber) => ({
      key: `placeholder-line-${lineNumber}`,
      width: SKELETON_LINE_WIDTHS[lineNumber % SKELETON_LINE_WIDTHS.length],
    }),
  );
  const distributeThroughTallRow = height >= 320;
  let loadingContent: ReactNode;
  if (userBubble && !distributeThroughTallRow) {
    loadingContent = (
      <div
        data-testid="chat-transcript-placeholder-user-bubble"
        className="ml-auto flex w-2/3 max-w-full flex-col gap-2 overflow-hidden rounded-lg border border-border/40 bg-foreground/3 px-4 py-2"
      >
        {preview === null ? (
          skeletonLines.map((line) => (
            <Skeleton key={line.key} className={cn("h-2", line.width)} />
          ))
        ) : (
          <span className="line-clamp-1 text-sm text-muted-foreground/60">
            {preview}
          </span>
        )}
      </div>
    );
  } else if (preview === null) {
    loadingContent = skeletonLines.map((line) => (
      <Skeleton
        key={line.key}
        className={cn("h-2", line.width, userBubble && "ml-auto")}
      />
    ));
  } else {
    loadingContent = (
      <div
        data-testid="chat-transcript-placeholder-user-bubble"
        className="ml-auto w-2/3 max-w-full overflow-hidden rounded-lg border border-border/40 bg-foreground/3 px-4 py-2"
      >
        <span className="line-clamp-1 text-sm text-muted-foreground/60">
          {preview}
        </span>
      </div>
    );
  }
  return (
    <div
      data-testid="chat-transcript-placeholder-row"
      data-ordinal={ordinal}
      aria-hidden="true"
      className="mx-auto w-full max-w-3xl px-6"
      style={{ height: `${height}px` }}
    >
      <div
        className={cn(
          "flex flex-col",
          distributeThroughTallRow ? "h-full justify-around" : "gap-2",
          "w-full",
        )}
      >
        {loadingContent}
      </div>
    </div>
  );
}

export const ChatTranscriptPlaceholderRow = memo(
  ChatTranscriptPlaceholderRowImpl,
);
