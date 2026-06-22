/**
 * `/epics` route screen - canonical surface for browsing every epic, plus
 * legacy phases that still need to open through the Epic view.
 *
 * Thin wrapper around `<EpicsListPanel variant="page" />`; the same panel
 * renders embedded on the home page (`variant="embedded"`) so home and
 * `/epics` stay in lockstep.
 */
import { EpicsListPanel } from "@/components/epics/epics-list-panel";
import type { HistorySearchState } from "@/lib/history-search";

export interface EpicsListProps {
  readonly routeSearch: HistorySearchState | null;
  readonly historyNowMs: number | null;
}

export function EpicsList(props: EpicsListProps) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="epics-list-screen"
    >
      <EpicsListPanel
        variant="page"
        onSelectEpic={null}
        routeSearch={props.routeSearch}
        historyNowMs={props.historyNowMs}
        autoFocusSearch={false}
      />
    </div>
  );
}
