/**
 * Cloud feed health for the Epic header. Observing owns retained state without
 * opening a stream. Only an attached cloud feed reports a warning, so closing
 * the graph cannot leave a stale warning in the header. Transport availability
 * never selects a different history source.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  CommGraphHostState,
  CommGraphHostStatus,
} from "@/lib/comm-graph/comm-graph-events";
import {
  getCommGraphCloudSubscriptionManager,
  observeCommGraphCloudSubscription,
  releaseCommGraphCloudObserver,
} from "@/lib/comm-graph/comm-graph-cloud-registry";
export interface CommGraphFeedHealth {
  readonly severity: "warning";
  readonly tooltip: string;
  readonly ariaLabel: string;
}

/**
 * Statuses worth an amber dot. `connecting` is a first dial, not a problem, and
 * a host that never answers is promoted to `unreachable` by the manager after
 * its failed-dial threshold - so it reports here through that, not on its own.
 */
const DEGRADED_STATUSES: ReadonlyArray<
  Exclude<CommGraphHostStatus, "live" | "connecting">
> = ["reconnecting", "unreachable", "failed", "unsupported"];

const STATUS_COPY: Record<(typeof DEGRADED_STATUSES)[number], string> = {
  reconnecting: "reconnecting…",
  unreachable: "host unreachable",
  // The transport could not be BUILT - nothing is retrying underneath except
  // the client's own bounded redial - so this must not read as "away".
  failed: "connection failed",
  unsupported: "cloud communication feed unsupported",
};

/**
 * Pure derivation, so the copy is testable on values. Returns `null` when there
 * is nothing to report: no surface holds the feed open, or every host is
 * healthy.
 */
export function deriveCommGraphFeedHealth(
  attached: boolean,
  hosts: ReadonlyArray<CommGraphHostState>,
): CommGraphFeedHealth | null {
  if (!attached || hosts.length === 0) return null;
  const counts = new Map<(typeof DEGRADED_STATUSES)[number], number>();
  for (const host of hosts) {
    if (host.status === "live" || host.status === "connecting") continue;
    counts.set(host.status, (counts.get(host.status) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  // Stable order so the text does not shuffle as statuses flip.
  const parts = DEGRADED_STATUSES.filter((status) => counts.has(status)).map(
    (status) => {
      const count = counts.get(status) ?? 0;
      const phrase = STATUS_COPY[status];
      // A single-host epic, or every host in the same state, needs no tally -
      // and the cloud relay stamps one status onto every origin host, so a
      // tally there would only ever say "N of N".
      if (hosts.length === 1 || count === hosts.length) return phrase;
      return `${phrase} (${String(count)} of ${String(hosts.length)} hosts)`;
    },
  );
  const tooltip = `Communication graph feed: ${parts.join("; ")}`;
  return { severity: "warning", tooltip, ariaLabel: tooltip };
}

/**
 * A primitive key for `useSyncExternalStore`, so the hook re-renders only when
 * the REPORT would change - not on every event frame the feed delivers.
 */
function feedHealthKey(
  attached: boolean,
  hosts: ReadonlyArray<CommGraphHostState>,
): string {
  if (!attached) return "";
  return hosts.map((host) => `${host.hostId}=${host.status}`).join("|");
}

export function useCommGraphFeedHealth(
  epicId: string,
): CommGraphFeedHealth | null {
  // This surface's ownership identity, stable for its lifetime - the same
  // convention the graph tile's claim uses, and for the same reason: two
  // headers must count as two owners.
  const [observer] = useState<object>(() => ({}));
  const cloudManager = useMemo(
    () => getCommGraphCloudSubscriptionManager(epicId),
    [epicId],
  );
  useEffect(() => {
    observeCommGraphCloudSubscription(epicId, observer);
    return () => {
      releaseCommGraphCloudObserver(epicId, observer);
    };
  }, [epicId, observer]);
  const subscribe = useCallback(
    (listener: () => void) => cloudManager.subscribe(listener),
    [cloudManager],
  );
  const read = useCallback((): {
    readonly attached: boolean;
    readonly hosts: ReadonlyArray<CommGraphHostState>;
  } => {
    return {
      attached: cloudManager.isAttached(),
      hosts: cloudManager.getSnapshot().hosts,
    };
  }, [cloudManager]);
  const key = useSyncExternalStore(
    subscribe,
    () => {
      const { attached, hosts } = read();
      return feedHealthKey(attached, hosts);
    },
    () => "",
  );
  return useMemo(() => {
    // `key` is the dependency that matters; `read` is stable per manager
    // and re-reading it here is what turns the key back into host states.
    if (key === "") return null;
    const { attached, hosts } = read();
    return deriveCommGraphFeedHealth(attached, hosts);
  }, [key, read]);
}
