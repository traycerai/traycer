import { EpicsList } from "@/components/epics/epics-list";
import type { HistorySearchState } from "@/lib/history-search";

/**
 * Renders the `/epics` surface. Auth gating lives in the route's
 * `beforeLoad: requireSignedIn(...)`; `bindAuthInvalidation` (see
 * `src/router.tsx`) re-invalidates the router on auth-status change,
 * so `beforeLoad` re-runs and redirects mid-session sign-outs without
 * needing a component-level effect here.
 */
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
