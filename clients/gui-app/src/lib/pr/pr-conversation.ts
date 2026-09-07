/** Grouping for the Feedback tab's card stack. */
import type {
  PrActivityItem,
  PrReviewThread,
} from "@traycer/protocol/host/pr-schemas";
import { prActivityItemKey } from "./pr-detail-projection";

export type PrReviewActivityItem = Extract<PrActivityItem, { kind: "review" }>;

export type PrConversationEntry =
  | {
      readonly kind: "card";
      readonly key: string;
      readonly item: PrActivityItem;
      /** Inline findings this review submitted. Empty for a comment. */
      readonly threads: readonly PrReviewThread[];
    }
  | {
      readonly kind: "event";
      readonly key: string;
      readonly item: PrReviewActivityItem;
      /** How many identical consecutive submissions this row stands for. */
      readonly repeats: number;
    };

export interface PrConversation {
  readonly entries: readonly PrConversationEntry[];
  /**
   * Threads whose review is not in this frame - it fell out of the 20-review window, or the fact predates review ids being captured.
   * Shown under their own heading rather than dropped, because an unresolved finding is the thing the tab exists to surface.
   */
  readonly orphanThreads: readonly PrReviewThread[];
}

function sameEventActor(
  left: PrReviewActivityItem,
  right: PrReviewActivityItem,
): boolean {
  return (left.author?.login ?? null) === (right.author?.login ?? null);
}

/** Threads keyed by the review that submitted them. */
function indexThreadsByReview(
  threads: readonly PrReviewThread[],
): ReadonlyMap<string, PrReviewThread[]> {
  const byReview = new Map<string, PrReviewThread[]>();
  for (const thread of threads) {
    if (thread.reviewId === null) continue;
    const bucket = byReview.get(thread.reviewId);
    if (bucket === undefined) byReview.set(thread.reviewId, [thread]);
    else bucket.push(thread);
  }
  return byReview;
}

export function groupPrConversation(
  items: readonly PrActivityItem[],
  threads: readonly PrReviewThread[],
): PrConversation {
  const byReview = indexThreadsByReview(threads);
  const claimed = new Set<string>();
  const entries: PrConversationEntry[] = [];
  for (const item of items) {
    const own = item.kind === "review" ? (byReview.get(item.id) ?? []) : [];
    if (own.length > 0) claimed.add(item.id);
    // A review that submitted findings ALWAYS earns a card, even with an empty body.
    // Folding it into a one-line event would take its findings with it, which is the exact failure this feature exists to fix.
    if (
      item.kind === "comment" ||
      item.body.trim().length > 0 ||
      own.length > 0
    ) {
      entries.push({
        kind: "card",
        key: prActivityItemKey(item),
        item,
        threads: own,
      });
      continue;
    }
    const previous = entries.at(-1);
    if (
      previous !== undefined &&
      previous.kind === "event" &&
      previous.item.state === item.state &&
      sameEventActor(previous.item, item)
    ) {
      entries[entries.length - 1] = {
        ...previous,
        repeats: previous.repeats + 1,
      };
      continue;
    }
    entries.push({
      kind: "event",
      key: prActivityItemKey(item),
      item,
      repeats: 1,
    });
  }
  const orphanThreads = threads.filter(
    (thread) => thread.reviewId === null || !claimed.has(thread.reviewId),
  );
  return { entries, orphanThreads };
}

/** How many entries in the feed actually carry text worth reading. */
export function countPrConversationCards(
  entries: readonly PrConversationEntry[],
): number {
  return entries.filter((entry) => entry.kind === "card").length;
}

/** Open findings first - the tab is about what is still blocking. */
export function partitionThreadsByResolution(
  threads: readonly PrReviewThread[],
): {
  readonly open: readonly PrReviewThread[];
  readonly resolved: readonly PrReviewThread[];
} {
  return {
    open: threads.filter((thread) => !thread.isResolved),
    resolved: threads.filter((thread) => thread.isResolved),
  };
}

/** Where a thread points, as one label. */
export function prReviewThreadAnchor(thread: PrReviewThread): {
  readonly label: string;
  readonly isOriginal: boolean;
} {
  if (thread.subject === "file") {
    return { label: thread.path, isOriginal: false };
  }
  if (thread.line !== null) {
    return { label: `${thread.path}:${thread.line}`, isOriginal: false };
  }
  if (thread.originalLine !== null) {
    return {
      label: `${thread.path}:${thread.originalLine}`,
      isOriginal: true,
    };
  }
  return { label: thread.path, isOriginal: false };
}
