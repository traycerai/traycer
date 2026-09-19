import { useCallback, useState } from "react";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { EpicsListPanel } from "@/components/epics/epics-list-panel";
import {
  historyScopeToParams,
  parseHistoryScope,
  type HistoryScope,
} from "@/lib/history-scope";
import { parseHistorySearch } from "@/lib/history-search";

/** Route-independent History body retained by the top-level surface host. */
export function HistorySurface() {
  const navigate = useNavigate({ from: "/epics/" });
  const route = useMatch({
    from: "/epics/",
    shouldThrow: false,
    select: (match) => ({
      routeSearch: parseHistorySearch(match.search),
      scope: parseHistoryScope(match.search),
      historyNowMs: match.loaderData?.historyNowMs ?? null,
    }),
    structuralSharing: true,
  });
  const [lastRoute, setLastRoute] = useState(route ?? null);

  const onScopeChange = useCallback(
    (scope: HistoryScope) => {
      void navigate({
        to: "/epics",
        replace: true,
        search: (prev) => ({ ...prev, ...historyScopeToParams(scope) }),
      });
    },
    [navigate],
  );

  if (route !== undefined && route !== lastRoute) {
    setLastRoute(route);
  }

  const history = route ?? lastRoute;
  const routeSearch = history?.routeSearch ?? parseHistorySearch({});

  const scope = history?.scope ?? "all";

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="history-surface">
      <EpicsListPanel
        scope={scope}
        onScopeChange={onScopeChange}
        variant="page"
        className={undefined}
        onSelectEpic={null}
        onOpenItem={null}
        routeSearch={routeSearch}
        historyNowMs={history?.historyNowMs ?? null}
        autoFocusSearch={false}
      />
    </div>
  );
}
