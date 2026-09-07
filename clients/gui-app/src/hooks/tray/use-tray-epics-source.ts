import { useEffect, useMemo, useState } from "react";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { useHistoryQuery } from "@/hooks/home/use-history-query";
import { DEFAULT_HISTORY_SEARCH } from "@/lib/history-search";
import type { TrayEpic } from "@traycer-clients/shared/platform/runner-host";
import { useTrayProjectionStore } from "@/stores/tray/tray-projection-store";

// Upper bound on epics shipped to the tray. The native menu shows the first
// few inline and folds the rest into a "More" submenu, so we send a slightly
// larger window than is shown inline; the full list stays in the in-app view.
const TRAY_EPIC_LIMIT = 20;

/**
 * Mount in `RunnerHostBridges` so the tray stays populated off-route. Signed out or host not ready leaves the list empty.
 */
export function useTrayEpicsSource(): void {
  // With a frozen `nowMs` they would be pinned to the value computed when this hook first mounted (it lives for the whole app session) and never refresh.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const { data } = useHistoryQuery({
    search: DEFAULT_HISTORY_SEARCH,
    nowMs,
  });
  const setEpics = useTrayProjectionStore((state) => state.setEpics);

  const epics = useMemo(
    () => projectTrayEpics(data?.items ?? []),
    [data?.items],
  );

  // Sync external (query) state into the projection store. The store dedupes
  // by content, so a refetch returning identical epics is a no-op and does
  // not re-fire the IPC projection.
  useEffect(() => {
    setEpics(epics);
  }, [setEpics, epics]);
}

function projectTrayEpics(
  items: ReadonlyArray<HistoryItem>,
): readonly TrayEpic[] {
  return items
    .filter((item) => item.taskType === "epic")
    .slice(0, TRAY_EPIC_LIMIT)
    .map((item) => ({
      epicId: item.epicId,
      title: item.title,
      subtitle: item.updatedLabel,
    }));
}
