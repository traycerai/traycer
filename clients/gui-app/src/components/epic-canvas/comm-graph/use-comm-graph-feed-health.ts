/**
 * Health of the communication-graph FEED for the Epic header's status dot.
 *
 * The graph keeps one subscription per host (or one cloud relay stamped onto
 * every origin host), and each carries a socket status. That status used to be
 * captioned onto every agent node on the canvas - so one wobbly relay socket
 * read "Reconnecting…" under every agent at once, as if each agent were the
 * problem. It is a fact about the feed, not about an agent, so it now rolls up
 * here: the header dot goes amber and the tooltip says what is degraded.
 *
 * CLAIM-FREE, BUT OWNED. Reading through the registries opens no socket - the
 * dot only ever reports a subscription some OPEN surface (the graph tile) is
 * holding, and `isAttached` is the gate, because a detached manager retains the
 * last statuses it saw and reporting those would show a stale warning for a
 * tile that is closed.
 *
 * Resolving a manager nevertheless CREATES a registry entry, and only a claim's
 * release ever removes one - so a header that merely resolved would strand an
 * entry for every epic the user visited, whether or not its graph was ever
 * opened. This registers as an OBSERVER instead: an owner with no opener, whose
 * release disposes the entry when nothing else ever wanted it. See
 * `releaseCommGraphObserver`.
 *
 * The authority choice mirrors `useCommGraphSnapshot` exactly - cloud hosts
 * while the cloud feed is available, local hosts otherwise - so the dot and the
 * canvas can never describe two different subscriptions.
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
import {
  getCommGraphSubscriptionManager,
  observeCommGraphSubscription,
  releaseCommGraphObserver,
} from "@/lib/comm-graph/comm-graph-registry";
import { selectCommGraphAuthoritativeSnapshot } from "@/lib/comm-graph/comm-graph-cloud-subscription";

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
  // An older host does not advertise the optional stream method, so its agents
  // have no edges to show - say so rather than implying silence.
  unsupported: "host has no edge data (update the host)",
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
  // Resolving during render is what `useSyncExternalStore` needs, and both
  // getters are idempotent, so a StrictMode double render cannot double-own.
  // The EFFECT below is what takes ownership, so its cleanup balances it.
  const manager = useMemo(
    () => getCommGraphSubscriptionManager(epicId),
    [epicId],
  );
  const cloudManager = useMemo(
    () => getCommGraphCloudSubscriptionManager(epicId),
    [epicId],
  );
  useEffect(() => {
    observeCommGraphSubscription(epicId, observer);
    observeCommGraphCloudSubscription(epicId, observer);
    return () => {
      releaseCommGraphObserver(epicId, observer);
      releaseCommGraphCloudObserver(epicId, observer);
    };
  }, [epicId, observer]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribeLocal = manager.subscribe(listener);
      const unsubscribeCloud = cloudManager.subscribe(listener);
      return () => {
        unsubscribeLocal();
        unsubscribeCloud();
      };
    },
    [cloudManager, manager],
  );
  const read = useCallback((): {
    readonly attached: boolean;
    readonly hosts: ReadonlyArray<CommGraphHostState>;
  } => {
    const snapshot = selectCommGraphAuthoritativeSnapshot(
      cloudManager.getAvailability(),
      cloudManager.getSnapshot(),
      manager.getSnapshot(),
    );
    return {
      attached: manager.isAttached() || cloudManager.isAttached(),
      hosts: snapshot.hosts,
    };
  }, [cloudManager, manager]);
  const key = useSyncExternalStore(
    subscribe,
    () => {
      const { attached, hosts } = read();
      return feedHealthKey(attached, hosts);
    },
    () => "",
  );
  return useMemo(() => {
    // `key` is the dependency that matters; `read` is stable per manager pair
    // and re-reading it here is what turns the key back into host states.
    if (key === "") return null;
    const { attached, hosts } = read();
    return deriveCommGraphFeedHealth(attached, hosts);
  }, [key, read]);
}
