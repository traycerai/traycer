import type { ReactNode } from "react";
import { EpicsListPanel } from "@/components/epics/epics-list-panel";

export interface HistoryModalContentProps {
  /**
   * Called immediately before navigation. The host hands `modal.close`
   * here so the modal dismisses in the same render that opens the
   * epic - keeps the URL flip clean (overlay cleared + epic route
   * landed in one user-visible step).
   */
  readonly onSelectEpic: () => void;
}

export function HistoryModalContent(
  props: HistoryModalContentProps,
): ReactNode {
  // `variant="page"` keeps the chrome (header + search + filters)
  // identical to the `/epics` strip-tab view so the modal and tab
  // forms read as the same surface, just framed differently.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EpicsListPanel
        variant="page"
        onSelectEpic={props.onSelectEpic}
        routeSearch={null}
        historyNowMs={null}
        autoFocusSearch
      />
    </div>
  );
}
