import { epicDisplayTitle } from "@/lib/display-title";
import type { HistoryItem } from "@/components/home/data/home-page.data";

/**
 * Single source of a row's display label, for both visible text and accessible
 * names, in every list that renders history rows.
 *
 * `item.title` is the RAW title (epics can be empty); apply the source-aware
 * "Untitled task" fallback for epics, while phases already carry their own
 * baked fallback and render verbatim.
 */
export function historyItemDisplayTitle(item: HistoryItem): string {
  return item.taskType === "phase"
    ? item.title
    : epicDisplayTitle({
        title: item.title,
        initialUserPrompt: item.initialUserPrompt,
      });
}
