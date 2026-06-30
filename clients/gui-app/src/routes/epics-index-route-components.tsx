import { getRouteApi } from "@tanstack/react-router";
import { EpicsRoute } from "@/components/epics/epics-route";
import { parseHistorySearch } from "@/lib/history-search";

const epicsIndexRouteApi = getRouteApi("/epics/");

export function EpicsIndexRoute() {
  const search = epicsIndexRouteApi.useSearch({
    select: (value) => parseHistorySearch(value),
    structuralSharing: true,
  });
  const { historyNowMs } = epicsIndexRouteApi.useLoaderData();
  return <EpicsRoute routeSearch={search} historyNowMs={historyNowMs} />;
}
