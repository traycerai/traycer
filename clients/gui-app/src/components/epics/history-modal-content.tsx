import type { ReactNode } from "react";
import { EpicsListPanel } from "@/components/epics/epics-list-panel";
import { useIsMobile } from "@/hooks/ui/use-mobile";

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
  // No autofocus on phones: focusing the search input raises the on-screen
  // keyboard over half the just-opened sheet.
  const isMobile = useIsMobile();
  // `variant="page"` keeps the chrome (header + search + filters)
  // identical to the `/epics` strip-tab view so the modal and tab
  // forms read as the same surface, just framed differently.
  //
  // `min-w-0`: this div is a flex item of the frame's row-direction body,
  // so without it `min-width: auto` sizes it to the list's content
  // min-width - wider than the frame once titles outgrow the viewport,
  // clipping the toolbar and row metadata past the right edge.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EpicsListPanel
        variant="page"
        onSelectEpic={props.onSelectEpic}
        routeSearch={null}
        historyNowMs={null}
        autoFocusSearch={!isMobile}
      />
    </div>
  );
}
