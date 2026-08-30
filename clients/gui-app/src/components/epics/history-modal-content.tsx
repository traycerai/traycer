import type { ReactNode } from "react";
import { EpicsListPanel } from "@/components/epics/epics-list-panel";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";

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
  // No autofocus on a touch pointer: focusing the search input raises the
  // on-screen keyboard over half the just-opened sheet. The pointer is what
  // decides, not the width - a desktop window snapped narrow still types with
  // hardware, and a tablet at desktop width still summons a keyboard.
  const coarsePointer = useCoarsePointer();
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
        className={undefined}
        onSelectEpic={props.onSelectEpic}
        onOpenItem={null}
        routeSearch={null}
        historyNowMs={null}
        autoFocusSearch={!coarsePointer}
      />
    </div>
  );
}
