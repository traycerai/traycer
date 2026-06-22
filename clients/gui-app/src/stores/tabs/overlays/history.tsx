import { History } from "lucide-react";
import { HistoryModalContent } from "@/components/epics/history-modal-content";
import { ensureHistoryTab } from "@/lib/commands/actions/open-system-tab";
import { isHistoryPath } from "@/stores/tabs/kinds/history";
import type { SystemOverlayModule } from "@/stores/tabs/system-overlay-registry";

export const historyOverlayModule: SystemOverlayModule<"history"> = {
  kind: "history",
  label: "History",
  Icon: History,
  renderBody: (_active, onClose) => (
    <HistoryModalContent onSelectEpic={onClose} />
  ),
  promotionIntent: () => ensureHistoryTab(),
  isOverlayPath: (pathname) => isHistoryPath(pathname),
};
