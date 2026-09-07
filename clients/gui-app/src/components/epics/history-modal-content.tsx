import type { ReactNode } from "react";
import { EpicsListPanel } from "@/components/epics/epics-list-panel";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";

export interface HistoryModalContentProps {
  /** Called immediately before navigation. */
  readonly onSelectEpic: () => void;
}

export function HistoryModalContent(
  props: HistoryModalContentProps,
): ReactNode {
  // The pointer is what decides, not the width - a desktop window snapped narrow still types with hardware, and
  // a tablet at desktop width still summons a keyboard.
  const coarsePointer = useCoarsePointer();
  // `min-w-0`: this div is a flex item of the frame's row-direction body, so without it `min-width: auto` sizes
  // it to the list's content min-width.
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
