import { prepareHistoryScopeForPromotion } from "@/lib/history-scope-handoff";
import { History } from "lucide-react";
import { LazyHistoryModalBody } from "@/stores/tabs/overlays/lazy-overlay-bodies";
import { resolveHistoryTabIntent } from "@/lib/commands/actions/open-system-tab";
import { isHistoryPath } from "@/stores/tabs/kinds/history";
import type { SystemOverlayModule } from "@/stores/tabs/system-overlay-registry";

export const historyOverlayModule: SystemOverlayModule<"history"> = {
  kind: "history",
  label: "History",
  Icon: History,
  renderBody: (_active, onClose) => (
    <LazyHistoryModalBody onSelectEpic={onClose} />
  ),
  promotionIntent: () => resolveHistoryTabIntent(),
  isOverlayPath: (pathname) => isHistoryPath(pathname),
  // Radix captures Escape before the input receives it. Keep the modal open
  // for the focused desktop search; the input alone clears and consumes it.
  consumeEscape: () => {
    const input = document.activeElement;
    return (
      input instanceof HTMLInputElement &&
      input.hasAttribute("data-history-search-clear-on-escape") &&
      input.value.length > 0
    );
  },
  prepareForPromotion: prepareHistoryScopeForPromotion,
  // Nothing outlives a refusal: the navigation consumed the handed-over scope
  // (`consumeHistoryScopeForPromotion`) before it was refused.
  abandonPromotion: () => undefined,
};
