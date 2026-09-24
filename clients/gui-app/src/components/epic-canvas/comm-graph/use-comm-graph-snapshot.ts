/**
 * Shared cloud history for the Communication panel and graph/office tiles.
 *
 * A registry claim owns one relay for the epic, regardless of how many
 * surfaces read it. Relay availability governs transport health, never history
 * authority: pending, unsupported, disconnected, and unverified sessions all
 * keep the cloud snapshot. Local-only history requires a future explicit mode.
 *
 * Each claim supplies its mounted surface's opener so retained managers never
 * redial through an unmounted component's stale transport dependencies.
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
import { createCommGraphCloudSubscriptionOpener } from "@/lib/comm-graph/comm-graph-cloud-stream-opener";
import {
  acquireCommGraphCloudSubscription,
  getCommGraphCloudSubscriptionManager,
  releaseCommGraphCloudSubscription,
  observeCommGraphCloudSubscription,
  releaseCommGraphCloudObserver,
} from "@/lib/comm-graph/comm-graph-cloud-registry";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { getCommGraphCloudSubscriptionOpenerOverride } from "@/lib/comm-graph/comm-graph-opener-override";
import {
  dialableHostEndpointFor,
  hostTransportKeyFor,
} from "@/lib/host/transport-key";
import {
  hostUnavailability,
  isRemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useRemoteSessionsPollReadiness } from "@/hooks/host/use-remote-sessions-poll-readiness";
import { reconcileCommGraphCloudAuthorityCursor } from "@/stores/epics/comm-graph-timeline-store";

export function useCommGraphSnapshot(
  epicId: string,
  hostIds: ReadonlyArray<string>,
  tabHostId: string | null,
): CommGraphSnapshot {
  const hostDirectory = useHostDirectoryList();
  // Stable for this component's lifetime, and reads every host dependency live
  // on each dial - but only while this component is mounted to keep refreshing
  // them, which is why the claim below hands it back on unmount.
  const openTransport = useDurableStreamTransportFactory();

  const cloudOpenerOverride = getCommGraphCloudSubscriptionOpenerOverride();
  const cloudOpener = useMemo(
    () =>
      cloudOpenerOverride ??
      createCommGraphCloudSubscriptionOpener(openTransport),
    [cloudOpenerOverride, openTransport],
  );

  // This surface's claim identity, stable for its lifetime. An object rather
  // than the opener itself: a test override hands every surface the SAME opener
  // function, and two surfaces must still count as two claims. Held in state
  // rather than a ref because the effect below closes over it, and a ref may
  // not be read during render.
  const [cloudClaim] = useState<object>(() => ({}));

  // Resolving the manager is claim-free and idempotent, so it is safe here:
  // `useSyncExternalStore` needs it during render, and a StrictMode double
  // render must not double-claim.
  const cloudManager = useMemo(
    () => getCommGraphCloudSubscriptionManager(epicId),
    [epicId],
  );

  // Any signed-in host may relay the cloud feed. Origin hosts can all be
  // offline (or absent for legacy agents), but the cloud view remains
  // available through another host in the user's directory. Relay choice
  // never becomes row identity or changes the source of history.
  // Relay dialability depends on the pull-only session cache, so the
  // directory query alone cannot see a session dying or appearing under an
  // `offline`/plan-restricted entry. This subscription re-renders on a readiness
  // flip, which recomputes the two memos below and reconciles the new relay
  // set and readiness keys into the cloud manager as one update.
  const directoryHostIdsForReadiness = useMemo(
    () => (hostDirectory.data ?? []).map((entry) => entry.hostId),
    [hostDirectory.data],
  );
  const hasReadySessionFor = useRemoteSessionsPollReadiness(
    directoryHostIdsForReadiness,
  );
  // The TAB's host relays the feed, then everyone else in ID order as failover.
  //
  // Every dialable host relays the same rows, so the choice decides only which
  // link the epic's whole cloud feed rides - and the epic tab is already riding
  // one. Sorting by ID alone handed the feed to whichever host ID sorted first,
  // which on an account with several hosts is an unrelated machine. Preferring
  // the LOCAL host was rejected for the same reason in reverse: on mobile there
  // is no local host at all, and the feed has to work through the remote host
  // the tab was opened on like any other.
  //
  // `tabHostId` is the Epic SESSION's host (`useEpicSessionHostId`), not the
  // tile's own `hostId` - this tile is the one kind with no host binding, and
  // its ref carries an inert placeholder. `null` (no session host yet), or a
  // tab host the directory cannot dial, leaves the plain ID order below; a tab
  // host that arrives later just reorders, and a reorder never closes a healthy
  // incumbent (`reconcileRelays`).
  const relayHostIds = useMemo(() => {
    const dialableHostIds = hostDirectory.data
      ?.filter(
        (entry) =>
          dialableHostEndpointFor(entry, hasReadySessionFor(entry.hostId)) !==
          null,
      )
      .map((entry) => entry.hostId);
    if (dialableHostIds === undefined || dialableHostIds.length === 0) {
      return Array.from(new Set(hostIds)).sort();
    }
    const orderedHostIds = Array.from(new Set(dialableHostIds)).sort();
    if (tabHostId === null || !orderedHostIds.includes(tabHostId)) {
      return orderedHostIds;
    }
    return [
      tabHostId,
      ...orderedHostIds.filter((hostId) => hostId !== tabHostId),
    ];
  }, [hasReadySessionFor, hostDirectory.data, hostIds, tabHostId]);
  // The ID set does not change when a host publishes its endpoint late or
  // upgrades in place. Keep that transport identity separately so a retained
  // cloud manager can retry a prior dial/compatibility failure for the same
  // host ID, without reopening on an equivalent directory re-emit.
  const relayReadinessKeys = useMemo(() => {
    const entriesByHostId = new Map(
      hostDirectory.data?.map((entry) => [entry.hostId, entry]),
    );
    return new Map(
      relayHostIds.map((hostId) => {
        const entry = entriesByHostId.get(hostId);
        if (entry === undefined) {
          return [hostId, "directory-pending"] as const;
        }
        return [
          hostId,
          [
            hostTransportKeyFor(entry, hasReadySessionFor(hostId)) ??
              [
                entry.hostId,
                // Derivation, not the coarse bit. This arm runs only when the
                // transport refuses the entry, so the coarse bit is constant
                // here and carries no information; the REASON does. A relay
                // that goes `plan-restricted` → confirmed `offline` must clear
                // the dial/compatibility verdict it retained under the other
                // reason, and comparing the coarse bit would not notice.
                hostUnavailability(entry) ?? "",
                entry.version ?? "",
                entry.websocketUrl ?? "",
              ].join("\u0000"),
            // A remote host can be re-enrolled without changing its ID,
            // endpoint, or version. That rotates its Noise key and must clear
            // this relay's retained verdict without redialing other relays.
            isRemoteHostDirectoryEntry(entry) ? entry.publicKey : "",
          ].join("\u0000"),
        ] as const;
      }),
    );
  }, [hasReadySessionFor, hostDirectory.data, relayHostIds]);

  // Read through a ref so acquiring does not re-run (and re-claim) every time
  // the host set changes - the claim only needs the set that is current at the
  // moment it attaches.
  const relayHostIdsRef = useRef(relayHostIds);
  useEffect(() => {
    relayHostIdsRef.current = relayHostIds;
  }, [relayHostIds]);

  // ONE effect for both halves of a directory update, and BEFORE the claim
  // below, so a manager never opens against half-installed state. The two
  // memos are recomputed by the same render and describe the same directory;
  // pushing them through separate setters let each one dial on the other
  // half's stale value.
  useEffect(() => {
    cloudManager.reconcileRelays({
      hostIds: relayHostIds,
      readinessKeys: relayReadinessKeys,
    });
  }, [cloudManager, relayHostIds, relayReadinessKeys]);

  // `host.communicationGraph.subscribe` is a Traycer Cloud-sourced feed, read
  // through whichever host relays it on a bearer the cloud must still vouch
  // for - and the host connection carries no renderer verdict of its own. So
  // the cloud claim is held only while the session holds a cloud verdict,
  // read reactively: a demotion while the tile stays mounted releases the
  // claim (the manager detaches, closing the relay stream, and retains its
  // rows for a later re-attach), and re-verification claims it again. The
  // retained cloud rows remain the view's history while authorization recovers.
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );

  // A mounted surface still owns its retained snapshot while authorization
  // is unavailable. Observer ownership also releases an entry that was never
  // authorized to open a transport at all.
  useEffect(() => {
    observeCommGraphCloudSubscription(epicId, cloudClaim);
    return () => {
      releaseCommGraphCloudObserver(epicId, cloudClaim);
    };
  }, [cloudClaim, cloudManager, epicId]);

  useEffect(() => {
    if (!cloudAuthorized) return;
    acquireCommGraphCloudSubscription(
      epicId,
      cloudClaim,
      cloudOpener,
      relayHostIdsRef.current,
    );
    return () => {
      releaseCommGraphCloudSubscription(epicId, cloudClaim);
    };
  }, [cloudAuthorized, cloudClaim, cloudManager, cloudOpener, epicId]);

  useEffect(() => {
    cloudManager.setOriginHostIds(hostIds);
  }, [cloudManager, hostIds]);

  const cloudSnapshot = useSyncExternalStore(
    (listener) => cloudManager.subscribe(listener),
    () => cloudManager.getSnapshot(),
    () => EMPTY_COMM_GRAPH_SNAPSHOT,
  );
  useEffect(() => {
    // Old persisted local cursors may still exist after upgrading. Reconcile
    // them only after the cloud relay has accounted for its initial history;
    // never reinterpret a local row id as a cloud cursor.
    if (!cloudAuthorized || !cloudSnapshot.initialHistoryCaughtUp) return;
    reconcileCommGraphCloudAuthorityCursor(epicId, cloudSnapshot.events);
  }, [
    cloudAuthorized,
    cloudSnapshot.events,
    cloudSnapshot.initialHistoryCaughtUp,
    epicId,
  ]);

  return cloudSnapshot;
}
