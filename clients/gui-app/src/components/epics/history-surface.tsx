import { useState } from "react";
import { useMatch } from "@tanstack/react-router";
import { EpicsListPanel } from "@/components/epics/epics-list-panel";
import { parseHistorySearch } from "@/lib/history-search";

/** Route-independent History body retained by the top-level surface host. */
export function HistorySurface() {
  const route = useMatch({
    from: "/epics/",
    shouldThrow: false,
    select: (match) => ({
      routeSearch: parseHistorySearch(match.search),
      historyNowMs: match.loaderData?.historyNowMs ?? null,
    }),
    structuralSharing: true,
  });
  const [lastRoute, setLastRoute] = useState(route ?? null);

  if (route !== undefined && route !== lastRoute) {
    setLastRoute(route);
  }

  const history = route ?? lastRoute;
  const routeSearch = history?.routeSearch ?? parseHistorySearch({});

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="history-surface">
      <EpicsListPanel
        variant="page"
        onSelectEpic={null}
        routeSearch={routeSearch}
        historyNowMs={history?.historyNowMs ?? null}
        autoFocusSearch={false}
      />
    </div>
  );
}
