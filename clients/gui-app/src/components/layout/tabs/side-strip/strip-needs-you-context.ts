import { createContext, useContext } from "react";
import type { NeedsYouItem } from "@/stores/notifications/needs-you-items";

const NO_ITEMS: ReadonlyArray<NeedsYouItem> = [];

/** What the strip reads from its one needs-you read, split by where it draws. */
export interface StripNeedsYou {
  /** The prompts by task, for the rows nested under each task. */
  readonly byEpic: ReadonlyMap<string, ReadonlyArray<NeedsYouItem>>;
  /** The prompts whose task has no row in the strip: the pinned block's. */
  readonly pinned: ReadonlyArray<NeedsYouItem>;
}

export const NO_STRIP_NEEDS_YOU: StripNeedsYou = {
  byEpic: new Map(),
  pinned: NO_ITEMS,
};

export const StripNeedsYouContext = createContext(NO_STRIP_NEEDS_YOU);

/** One task's waiting prompts; none for a tab that is not a task. */
export function useStripTaskNeedsYou(
  epicId: string | null,
): ReadonlyArray<NeedsYouItem> {
  const { byEpic } = useContext(StripNeedsYouContext);
  return epicId === null ? NO_ITEMS : (byEpic.get(epicId) ?? NO_ITEMS);
}

/** The prompts the pinned Needs you block lists. */
export function useStripPinnedNeedsYou(): ReadonlyArray<NeedsYouItem> {
  return useContext(StripNeedsYouContext).pinned;
}
