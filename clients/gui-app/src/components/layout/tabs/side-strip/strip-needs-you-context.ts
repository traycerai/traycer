import { createContext, useContext } from "react";
import type { NeedsYouItem } from "@/stores/notifications/needs-you-items";

const NO_ITEMS: ReadonlyArray<NeedsYouItem> = [];

export const NO_NEEDS_YOU_GROUPS: ReadonlyMap<
  string,
  ReadonlyArray<NeedsYouItem>
> = new Map();

/** The prompts waiting on the person by task, from the row list's scope. */
export const StripNeedsYouContext = createContext(NO_NEEDS_YOU_GROUPS);

/** One task's waiting prompts; none for a tab that is not a task. */
export function useStripTaskNeedsYou(
  epicId: string | null,
): ReadonlyArray<NeedsYouItem> {
  const groups = useContext(StripNeedsYouContext);
  return epicId === null ? NO_ITEMS : (groups.get(epicId) ?? NO_ITEMS);
}
