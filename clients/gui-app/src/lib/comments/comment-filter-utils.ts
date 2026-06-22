import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
export {
  scanThreadAnchorsFromDoc,
  sortThreadsByDocumentOrder,
  type AnchorPositionMap,
  type AnchorPosResolvedThread as SortedThread,
} from "@traycer/protocol/comments/comment-thread-ordering";

export type CommentThreadStatusFilter = "open" | "resolved" | "all";

/**
 * Apply the sidebar's Open / Resolved / All tab filter to a thread list.
 * `open` and `resolved` are mutually exclusive; `all` keeps everything.
 */
export function filterThreadsByStatus(
  threads: ReadonlyArray<CommentThreadWire>,
  filter: CommentThreadStatusFilter,
): ReadonlyArray<CommentThreadWire> {
  if (filter === "all") return threads;
  if (filter === "open") return threads.filter((t) => !t.resolved);
  return threads.filter((t) => t.resolved);
}

/**
 * Count of unresolved threads, used by the artifact tree to render the
 * per-artifact open-thread badge.
 */
export function countOpenThreads(
  threads: ReadonlyArray<CommentThreadWire>,
): number {
  let count = 0;
  for (const t of threads) {
    if (!t.resolved) count += 1;
  }
  return count;
}
