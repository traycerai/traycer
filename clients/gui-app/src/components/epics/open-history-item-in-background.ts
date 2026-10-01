import { toast } from "sonner";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { historyItemDisplayTitle } from "@/components/epics/history-item-title";
import { openEpicInBackground } from "@/lib/commands/actions/open-epic-in-background";

export function openHistoryItemInBackground(
  item: HistoryItem,
  isOpen: boolean,
): void {
  if (isOpen) {
    toast("Task already open", {
      id: "history-task-already-open",
      description: historyItemDisplayTitle(item),
    });
    return;
  }
  openEpicInBackground(item.epicId, item.title);
}
