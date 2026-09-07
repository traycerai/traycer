import { EpicsList } from "@/components/epics/epics-list";
import type { HistorySearchState } from "@/lib/history-search";

/** Auth gating lives in the route's `beforeLoad: requireSignedIn(...)`. */
export interface EpicsRouteProps {
  readonly routeSearch: HistorySearchState | null;
  readonly historyNowMs: number | null;
}

export function EpicsRoute(props: EpicsRouteProps) {
  return (
    <EpicsList
      routeSearch={props.routeSearch}
      historyNowMs={props.historyNowMs}
    />
  );
}
