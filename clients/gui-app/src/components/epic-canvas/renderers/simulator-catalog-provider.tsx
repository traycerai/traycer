import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useSimulatorCatalogInventory } from "@/hooks/simulator/use-simulator-catalog-inventory";
import { simulatorPendingOpenVerdict } from "@/lib/simulator-view/simulator-pending-open-verdict";
import { useSimulatorSessionsForHost } from "@/lib/simulator-view/use-simulator-sessions";
import { makeSimulatorTileRef } from "@/stores/epics/canvas/tile-schema/simulator-tile";
import {
  placeSimulatorPendingOpenTile,
  removeSimulatorPendingOpen,
  simulatorPendingOpensForEpic,
  updateSimulatorPendingOpen,
  useSimulatorPendingOpensStore,
} from "@/stores/epics/simulator-pending-opens-store";
import { SimulatorCatalogContext } from "./simulator-catalog-context";

/**
 * The task's simulator catalog for every surface of one canvas, and the
 * bookkeeping that ends the person's pending opens: one watcher per machine
 * an open is pending on, and the drop once the catalog lists the session.
 */
export function SimulatorCatalogProvider(props: {
  readonly epicId: string;
  readonly children: ReactNode;
}) {
  const { epicId } = props;
  const readerClient = useEpicSessionHostClient();
  const catalog = useSimulatorCatalogInventory({ epicId, readerClient });
  const byRequestId = useSimulatorPendingOpensStore(
    (state) => state.byRequestId,
  );
  const pending = useMemo(
    () => simulatorPendingOpensForEpic(byRequestId, epicId),
    [byRequestId, epicId],
  );
  const { records } = catalog;
  useEffect(() => {
    // The row is the catalog's from here on: a session it lists is no longer
    // pending, and the pending row would be its duplicate.
    for (const open of pending) {
      if (open.sessionId === null) continue;
      if (
        records.some(
          (record) =>
            record.hostId === open.hostId &&
            record.sessionId === open.sessionId,
        )
      )
        removeSimulatorPendingOpen(open.requestId);
    }
  }, [pending, records]);
  const hostIds = useMemo(
    () => [...new Set(pending.map((open) => open.hostId))],
    [pending],
  );
  return (
    <SimulatorCatalogContext.Provider value={catalog}>
      {hostIds.map((hostId) => (
        <SimulatorPendingOpensWatcher
          key={hostId}
          epicId={epicId}
          hostId={hostId}
        />
      ))}
      {props.children}
    </SimulatorCatalogContext.Provider>
  );
}

/**
 * Follows one machine's sessions stream for the opens pending there: a
 * session carrying an open's `requestId` gives it its `sessionId` and places
 * its tile, which is how an open whose answer outlived the wait still lands;
 * an open the host stopped running with no session to show for it failed.
 */
function SimulatorPendingOpensWatcher(props: {
  readonly epicId: string;
  readonly hostId: string;
}) {
  const { epicId, hostId } = props;
  const sessions = useSimulatorSessionsForHost({ hostId, epicId });
  const byRequestId = useSimulatorPendingOpensStore(
    (state) => state.byRequestId,
  );
  // The revision each lost answer was first judged against: a stream that
  // has not moved since may not have heard of the open yet.
  const lostAtRevision = useRef(new Map<string, number>());
  const { lifecycle, state } = sessions;
  useEffect(() => {
    if (lifecycle !== "live" || state === null) return;
    for (const open of simulatorPendingOpensForEpic(byRequestId, epicId)) {
      if (open.hostId !== hostId) continue;
      const verdict = simulatorPendingOpenVerdict(open, state);
      if (verdict.kind === "session") {
        lostAtRevision.current.delete(open.requestId);
        const { session } = verdict;
        if (open.sessionId === null && session.sessionId !== undefined)
          updateSimulatorPendingOpen(open.requestId, {
            sessionId: session.sessionId,
          });
        placeSimulatorPendingOpenTile(
          open.requestId,
          makeSimulatorTileRef({
            hostId,
            simulatorId: session.simulatorId,
            platform: session.platform,
            name: open.name,
          }),
        );
        continue;
      }
      if (verdict.kind === "opening") {
        if (!open.seenOpening)
          updateSimulatorPendingOpen(open.requestId, { seenOpening: true });
        continue;
      }
      if (open.sessionId !== null) continue;
      if (!open.seenOpening) {
        if (!open.answerLost) continue;
        const judged = lostAtRevision.current.get(open.requestId);
        if (judged === undefined || judged >= state.revision) {
          lostAtRevision.current.set(open.requestId, judged ?? state.revision);
          continue;
        }
      }
      lostAtRevision.current.delete(open.requestId);
      removeSimulatorPendingOpen(open.requestId);
      toast.error(`Couldn't open ${open.name}.`);
    }
  }, [byRequestId, epicId, hostId, lifecycle, state]);
  return null;
}
