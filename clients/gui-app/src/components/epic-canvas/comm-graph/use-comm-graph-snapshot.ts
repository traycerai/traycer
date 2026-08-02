/**
 * React binding for the comm-graph per-host fan-in.
 *
 * The manager is a plain object rather than a hook-per-host because the host set
 * is data-driven (one subscription per host the epic's agents live on) and hooks
 * cannot be opened in a loop.
 *
 * It is also SHARED, not owned by this hook: the Communication panel and the
 * graph tile both call this, and both must see the same event array. The
 * registry hands back the epic's single manager and counts claims, so one
 * surface open means one subscription and both open still means one. Releasing
 * DETACHES rather than disposes, which keeps events, cursors and the per-host
 * snapshot boundaries - so reopening a surface resumes instead of re-pulling,
 * and history does not re-flash as if it had just arrived.
 *
 * THE CLAIM CARRIES THIS SURFACE'S OPENER. `useDurableStreamTransportFactory`
 * reads its dependencies through a ref that THIS component's effect refreshes,
 * so the opener goes stale the moment this component unmounts. Handing it over
 * with the claim - and taking it back on release - is what stops a retained
 * manager from redialing through a dead surface's frozen refs.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import {
  EMPTY_COMM_GRAPH_SNAPSHOT,
  type CommGraphSnapshot,
} from "@/lib/comm-graph/comm-graph-events";
import {
  acquireCommGraphSubscription,
  getCommGraphSubscriptionManager,
  releaseCommGraphSubscription,
} from "@/lib/comm-graph/comm-graph-registry";
import { createCommGraphSubscriptionOpener } from "@/lib/comm-graph/comm-graph-stream-opener";
import { getCommGraphSubscriptionOpenerOverride } from "@/lib/comm-graph/comm-graph-opener-override";

export function useCommGraphSnapshot(
  epicId: string,
  hostIds: ReadonlyArray<string>,
): CommGraphSnapshot {
  // Stable for this component's lifetime, and reads every host dependency live
  // on each dial - but only while this component is mounted to keep refreshing
  // them, which is why the claim below hands it back on unmount.
  const openTransport = useDurableStreamTransportFactory();

  const opener = useMemo(
    () =>
      getCommGraphSubscriptionOpenerOverride() ??
      createCommGraphSubscriptionOpener(openTransport),
    [openTransport],
  );

  // This surface's claim identity, stable for its lifetime. An object rather
  // than the opener itself: a test override hands every surface the SAME opener
  // function, and two surfaces must still count as two claims. Held in state
  // rather than a ref because the effect below closes over it, and a ref may
  // not be read during render.
  const [claim] = useState<object>(() => ({}));

  // Resolving the manager is claim-free and idempotent, so it is safe here:
  // `useSyncExternalStore` needs it during render, and a StrictMode double
  // render must not double-claim.
  const manager = useMemo(
    () => getCommGraphSubscriptionManager(epicId),
    [epicId],
  );

  // Read through a ref so acquiring does not re-run (and re-claim) every time
  // the host set changes - the claim only needs the set that is current at the
  // moment it attaches.
  const hostIdsRef = useRef(hostIds);
  useEffect(() => {
    hostIdsRef.current = hostIds;
  }, [hostIds]);

  // The CLAIM is an effect, so its cleanup balances a StrictMode double-invoke.
  // The host set goes in WITH it so a retained manager's stale desired set is
  // replaced BEFORE the sockets open, rather than dialing a departed host for a
  // beat. Later host-set changes are the effect below.
  useEffect(() => {
    acquireCommGraphSubscription(epicId, claim, opener, hostIdsRef.current);
    return () => {
      releaseCommGraphSubscription(epicId, claim);
    };
  }, [claim, epicId, manager, opener]);

  // `hostIds` is memoized by the caller and `setHostIds` is idempotent, so two
  // surfaces declaring the same set neither reopens a socket nor re-publishes.
  useEffect(() => {
    manager.setHostIds(hostIds);
  }, [manager, hostIds]);

  return useSyncExternalStore(
    (listener) => manager.subscribe(listener),
    () => manager.getSnapshot(),
    () => EMPTY_COMM_GRAPH_SNAPSHOT,
  );
}
