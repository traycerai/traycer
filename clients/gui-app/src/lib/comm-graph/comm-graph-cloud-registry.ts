import {
  CommGraphCloudSubscriptionManager,
  type CommGraphCloudSubscriptionOpener,
} from "@/lib/comm-graph/comm-graph-cloud-subscription";
import { dropCommGraphRowOpenKeys } from "@/stores/epics/comm-graph-row-open-store";
import { reconcilePrunedCommGraphTimelineRows } from "@/stores/epics/comm-graph-timeline-store";

const DETACHED_CLOUD_MANAGER_LIMIT = 3;
export type CommGraphCloudSubscriptionClaim = object;

interface CloudRegistryEntry {
  readonly manager: CommGraphCloudSubscriptionManager;
  readonly openersByClaim: Map<
    CommGraphCloudSubscriptionClaim,
    CommGraphCloudSubscriptionOpener
  >;
  claimByRelayHostId: Map<string, CommGraphCloudSubscriptionClaim>;
}

const entriesByEpicId = new Map<string, CloudRegistryEntry>();
const detachedEpicIds: string[] = [];
const pendingEvictionsByEpicId = new Map<string, object>();

function newestLiveClaim(
  epicId: string,
  entry: CloudRegistryEntry,
): CommGraphCloudSubscriptionClaim {
  const claim = Array.from(entry.openersByClaim.keys()).at(-1);
  if (claim === undefined) {
    throw new Error(
      `comm-graph cloud subscription for "${epicId}" dialed with no live claim`,
    );
  }
  return claim;
}

export function getCommGraphCloudSubscriptionManager(
  epicId: string,
): CommGraphCloudSubscriptionManager {
  const existing = entriesByEpicId.get(epicId);
  if (existing !== undefined) return existing.manager;
  const entry: CloudRegistryEntry = {
    manager: new CommGraphCloudSubscriptionManager(
      epicId,
      (request) => {
        const claim = newestLiveClaim(epicId, entry);
        entry.claimByRelayHostId.set(request.hostId, claim);
        const opener = entry.openersByClaim.get(claim);
        if (opener === undefined) {
          throw new Error(
            `comm-graph cloud subscription for "${epicId}" lost its claim mid-dial`,
          );
        }
        return opener(request);
      },
      (rowKeys) => {
        dropCommGraphRowOpenKeys(epicId, rowKeys);
        reconcilePrunedCommGraphTimelineRows(epicId, rowKeys);
      },
    ),
    openersByClaim: new Map(),
    claimByRelayHostId: new Map(),
  };
  entriesByEpicId.set(epicId, entry);
  return entry.manager;
}

export function acquireCommGraphCloudSubscription(
  epicId: string,
  claim: CommGraphCloudSubscriptionClaim,
  opener: CommGraphCloudSubscriptionOpener,
  relayHostIds: ReadonlyArray<string>,
): void {
  const entry = entriesByEpicId.get(epicId);
  if (entry === undefined) return;
  pendingEvictionsByEpicId.delete(epicId);
  const detachedIndex = detachedEpicIds.indexOf(epicId);
  if (detachedIndex >= 0) detachedEpicIds.splice(detachedIndex, 1);
  entry.openersByClaim.set(claim, opener);
  entry.manager.setRelayHostIds(relayHostIds);
  entry.manager.attach();
}

export function releaseCommGraphCloudSubscription(
  epicId: string,
  claim: CommGraphCloudSubscriptionClaim,
): void {
  const entry = entriesByEpicId.get(epicId);
  if (entry === undefined) return;
  entry.openersByClaim.delete(claim);
  if (entry.openersByClaim.size > 0) {
    const orphaned = Array.from(entry.claimByRelayHostId.entries()).flatMap(
      ([hostId, owner]) => (owner === claim ? [hostId] : []),
    );
    for (const hostId of orphaned) entry.claimByRelayHostId.delete(hostId);
    entry.manager.redialHosts(orphaned);
    return;
  }
  entry.manager.detach();
  entry.claimByRelayHostId.clear();
  detachedEpicIds.push(epicId);
  while (detachedEpicIds.length > DETACHED_CLOUD_MANAGER_LIMIT) {
    const evictedEpicId = detachedEpicIds.shift();
    if (evictedEpicId === undefined) break;
    const evictionToken = {};
    pendingEvictionsByEpicId.set(evictedEpicId, evictionToken);
    queueMicrotask(() => {
      if (pendingEvictionsByEpicId.get(evictedEpicId) !== evictionToken) {
        return;
      }
      pendingEvictionsByEpicId.delete(evictedEpicId);
      const evicted = entriesByEpicId.get(evictedEpicId);
      if (evicted === undefined || evicted.openersByClaim.size > 0) return;
      evicted.manager.dispose();
      entriesByEpicId.delete(evictedEpicId);
    });
  }
}

export function __resetCommGraphCloudRegistryForTests(): void {
  for (const entry of entriesByEpicId.values()) entry.manager.dispose();
  entriesByEpicId.clear();
  detachedEpicIds.length = 0;
  pendingEvictionsByEpicId.clear();
}
