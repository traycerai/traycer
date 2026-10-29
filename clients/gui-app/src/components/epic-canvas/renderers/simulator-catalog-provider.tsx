import { useEffect, useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useRequestContextUserId } from "@/hooks/host/use-request-context-user-id";
import { useSimulatorCatalogInventory } from "@/hooks/simulator/use-simulator-catalog-inventory";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { simulatorPendingOpenVerdict } from "@/lib/simulator-view/simulator-pending-open-verdict";
import { useSimulatorSessionsForHost } from "@/lib/simulator-view/use-simulator-sessions";
import { makeSimulatorTileRef } from "@/stores/epics/canvas/tile-schema/simulator-tile";
import {
  placeSimulatorPendingOpenTile,
  removeSimulatorPendingOpen,
  simulatorPendingOpensForEpic,
  updateSimulatorPendingOpen,
  useSimulatorPendingOpensStore,
  type SimulatorPendingOpen,
} from "@/stores/epics/simulator-pending-opens-store";
import { SimulatorCatalogContext } from "./simulator-catalog-context";

/**
 * The task's simulator catalog for every surface of one canvas, and the
 * bookkeeping that ends the person's pending opens: one watcher per machine
 * an open is pending on, the drop once the catalog lists the session, and one
 * read per open whose answer was lost.
 */
export function SimulatorCatalogProvider(props: {
  readonly epicId: string;
  readonly children: ReactNode;
}) {
  const { epicId } = props;
  const readerClient = useEpicSessionHostClient();
  const catalog = useSimulatorCatalogInventory({ epicId, readerClient });
  // The person the opens are: the catalog is read per user, and a session of
  // theirs carries this id whichever machine it runs on.
  const viewerUserId = useRequestContextUserId(readerClient);
  const byRequestId = useSimulatorPendingOpensStore(
    (state) => state.byRequestId,
  );
  const pending = useMemo(
    () => simulatorPendingOpensForEpic(byRequestId, epicId),
    [byRequestId, epicId],
  );
  const { listsSessions, records } = catalog;
  useEffect(() => {
    // The row is the catalog's from here on: a session it lists is no longer
    // pending, and the pending row would be its duplicate. Where no catalog
    // lists this task's sessions there is no row to hand off to and none
    // coming, so the session the open produced ends the wait by itself.
    for (const open of pending) {
      if (open.sessionId === null) continue;
      if (
        !listsSessions ||
        records.some(
          (record) =>
            record.hostId === open.hostId &&
            record.sessionId === open.sessionId,
        )
      )
        removeSimulatorPendingOpen(open.requestId);
    }
  }, [listsSessions, pending, records]);
  const hostIds = useMemo(
    () => [...new Set(pending.map((open) => open.hostId))],
    [pending],
  );
  const lost = pending.filter(
    (open) => open.answerLost && !open.seenOpening && open.sessionId === null,
  );
  return (
    <SimulatorCatalogContext.Provider value={catalog}>
      {hostIds.map((hostId) => (
        <SimulatorPendingOpensWatcher
          key={hostId}
          epicId={epicId}
          hostId={hostId}
          viewerUserId={viewerUserId}
        />
      ))}
      {lost.map((open) => (
        <SimulatorLostOpenResolver
          key={open.requestId}
          epicId={epicId}
          open={open}
          viewerUserId={viewerUserId}
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
  readonly viewerUserId: string | null;
}) {
  const { epicId, hostId, viewerUserId } = props;
  const sessions = useSimulatorSessionsForHost({ hostId, epicId });
  const byRequestId = useSimulatorPendingOpensStore(
    (state) => state.byRequestId,
  );
  const { lifecycle, state } = sessions;
  useEffect(() => {
    if (lifecycle !== "live" || state === null) return;
    for (const open of simulatorPendingOpensForEpic(byRequestId, epicId)) {
      if (open.hostId !== hostId) continue;
      const verdict = simulatorPendingOpenVerdict(open, state, viewerUserId);
      if (verdict.kind === "session") {
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
      // Gone, having been seen running: the open failed. An open this stream
      // never carried in `opening` is judged by its own read instead - this
      // state may simply predate the host hearing of it.
      if (!open.seenOpening) continue;
      removeSimulatorPendingOpen(open.requestId);
      toast.error(`Couldn't open ${open.name}.`);
    }
  }, [byRequestId, epicId, hostId, lifecycle, state, viewerUserId]);
  return null;
}

/**
 * One lost answer's verdict, from a read of the host's own state.
 *
 * `simulator.sessions` publishes what CHANGED, so an open whose answer never
 * arrived and which the stream never carried in `opening` cannot be judged
 * from the published state at all: a host that never heard of the open
 * publishes nothing about it, and the row would wait for unrelated simulator
 * activity to arrive. `simulator.list` answers the same `opening` and
 * `sessions`, on demand, so the rule the stream applies - gone from
 * `opening` with no session carrying it - is decided here against a snapshot
 * taken AFTER the failure. The read is keyed by the `requestId`, so it is
 * this open's own answer and never one cached from before it was sent; a read
 * that itself fails leaves the row, since the GUI's inability to ask is not
 * the open having failed.
 *
 * A read that finds the open still in `opening` decides nothing yet: the host
 * is running it. So the read is keyed by the published state's revision too,
 * and the host is asked again every time that state moves - the only sign
 * that the open may have ended since the last answer. That is what ends a row
 * whose open was lost while the stream was away: the stream comes back on a
 * snapshot carrying neither the open nor a session, which it never saw run
 * and so cannot judge, and the read taken against that same move answers for
 * it.
 *
 * What this deliberately does NOT do is hand the stream an `opening` sighting
 * of its own to judge by. The stream's rule reads a FAILURE from the open's
 * absence, and a state the stream published BEFORE this read is missing the
 * open because the host had not heard of it yet - so the row of an open that
 * is merely still booting would end as a failure.
 */
function SimulatorLostOpenResolver(props: {
  readonly epicId: string;
  readonly open: SimulatorPendingOpen;
  readonly viewerUserId: string | null;
}) {
  const { epicId, open, viewerUserId } = props;
  const binding = useHostBinding();
  const client = resolveNamedHostClient(binding, open.hostId);
  const supported = useHostSupportsMethod(open.hostId, "simulator.list");
  // The same stream the watcher follows, shared through the coordinator. Its
  // revision keys the read, and is `none` until it has published anything.
  const sessions = useSimulatorSessionsForHost({ hostId: open.hostId, epicId });
  const streamRevision =
    sessions.state === null ? "none" : String(sessions.state.revision);
  const query = useHostQuery<HostRpcRegistry, "simulator.list">({
    client: supported ? client : null,
    method: "simulator.list",
    params: { epicId },
    cacheKeyIdentity: [open.requestId, streamRevision],
    // `opening` is a `@1.1` field: a `@1.0` answer would read as "gone" for
    // every open in flight.
    requiredHostMethodVersion: () => ({
      method: "simulator.list",
      version: { major: 1, minor: 1 },
    }),
    options: { retry: false },
  });
  const { data } = query;
  const { requestId } = open;
  useEffect(() => {
    if (data === undefined) return;
    const current =
      useSimulatorPendingOpensStore.getState().byRequestId[requestId];
    if (current === undefined) return;
    // The stream has spoken for this open since the read went out, and its
    // verdict is the stream's to finish.
    if (current.sessionId !== null || current.seenOpening) return;
    if (
      simulatorPendingOpenVerdict(current, data, viewerUserId).kind !== "gone"
    )
      return;
    removeSimulatorPendingOpen(requestId);
    toast.error(`Couldn't open ${current.name}.`);
  }, [data, requestId, viewerUserId]);
  return null;
}
