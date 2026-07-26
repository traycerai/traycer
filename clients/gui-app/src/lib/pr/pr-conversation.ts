/**
 * Grouping for the Feedback tab's card stack.
 *
 * GitHub renders every review submission as its own row on a connector line,
 * so a bot that posts five inline-comment reviews in one pass produces five
 * identical "coderabbitai reviewed" rows carrying no text at all. That ladder
 * is most of the vertical space on a reviewed PR and none of its information.
 *
 * Here an entry earns a card only when it has something to READ. Everything
 * else collapses to a one-line event, and consecutive body-less reviews from
 * the same login with the same verdict fold into a single row with a count -
 * the fact ("this bot reviewed, repeatedly, without leaving a summary") is
 * preserved, the repetition is not.
 *
 * Body-less COMMENTS are never folded: a comment with no text is a data
 * oddity rather than a routine event, and silently dropping one would hide a
 * fact the feed is supposed to be a faithful window onto.
 */
import type { PrActivityItem } from "@traycer/protocol/host/pr-schemas";
import { prActivityItemKey } from "./pr-detail-projection";

export type PrReviewActivityItem = Extract<PrActivityItem, { kind: "review" }>;

export type PrConversationEntry =
  | {
      readonly kind: "card";
      readonly key: string;
      readonly item: PrActivityItem;
    }
  | {
      readonly kind: "event";
      readonly key: string;
      readonly item: PrReviewActivityItem;
      /** How many identical consecutive submissions this row stands for. */
      readonly repeats: number;
    };

function sameEventActor(
  left: PrReviewActivityItem,
  right: PrReviewActivityItem,
): boolean {
  return (left.author?.login ?? null) === (right.author?.login ?? null);
}

export function groupPrConversation(
  items: readonly PrActivityItem[],
): readonly PrConversationEntry[] {
  const entries: PrConversationEntry[] = [];
  for (const item of items) {
    if (item.kind === "comment" || item.body.trim().length > 0) {
      entries.push({ kind: "card", key: prActivityItemKey(item), item });
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
  return entries;
}

/** How many entries in the feed actually carry text worth reading. */
export function countPrConversationCards(
  entries: readonly PrConversationEntry[],
): number {
  return entries.filter((entry) => entry.kind === "card").length;
}
