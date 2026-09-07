import { epicDisplayTitle } from "@/lib/display-title";
import type { HistoryItem } from "@/components/home/data/home-page.data";

/** `item.title` is the raw title (epics can be empty); apply the source-aware "Untitled task" fallback for
 * epics, while phases already carry their own baked fallback and render verbatim. */
export function historyItemDisplayTitle(item: HistoryItem): string {
  return item.taskType === "phase"
    ? item.title
    : epicDisplayTitle({
        title: item.title,
        initialUserPrompt: item.initialUserPrompt,
      });
}
