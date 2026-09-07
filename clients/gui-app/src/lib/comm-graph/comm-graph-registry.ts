/**
 * One `epic.communicationGraph.subscribe` fan-in per epic.
 * A claim carries its own opener; last release detaches (keeps cursors).
 */
import { CommGraphSubscriptionManager } from "@/lib/comm-graph/comm-graph-subscription";
import type { CommGraphSubscriptionOpener } from "@/lib/comm-graph/comm-graph-subscription";

/**
 * How many DETACHED epics keep their manager (and therefore their log and cursors).
 * Small on purpose: the point is to make flipping between the handful of epics in a session's working set free, not to cache history.
 */
export const DETACHED_MANAGER_LIMIT = 3;

/**
 * Identity for one surface's claim.
 * The surface supplies a stable per-instance object, so two surfaces are two claims even when a test override hands them the same opener function.
 */
export type CommGraphSubscriptionClaim = object;

interface CommGraphRegistryEntry {
  readonly manager: CommGraphSubscriptionManager;
  /** Live claims, each with the opener of a currently-mounted surface. */
  readonly openersByClaim: Map<
    CommGraphSubscriptionClaim,
    CommGraphSubscriptionOpener
  >;
  /** Which claim's opener produced the transport currently OPEN for each host. */
  readonly claimByHostId: Map<string, CommGraphSubscriptionClaim>;
  /** READ-ONLY watchers, which hold no opener and never dial. */
  readonly observers: Set<object>;
}

const entriesByEpicId = new Map<string, CommGraphRegistryEntry>();
/** Detached epic ids, oldest first. */
const detachedEpicIds: string[] = [];

function newestLiveClaim(
  epicId: string,
  entry: CommGraphRegistryEntry,
): CommGraphSubscriptionClaim {
  // Newest live claim: a surface that mounted more recently is the one whose
  // transport refs are certain to still be refreshing.
  const claim = Array.from(entry.openersByClaim.keys()).at(-1);
  if (claim === undefined) {
    // Unreachable by construction - the manager only dials while attached, and it is attached only while a claim is held.
    // Loud rather than silent, because the silent version is a dial into a dead runtime.
    throw new Error(
      `comm-graph subscription for "${epicId}" dialed with no live claim`,
    );
  }
  return claim;
}

/**
 * The epic's manager, created on first ask.
 * IDEMPOTENT and claim-free, so it is safe to call while resolving a render (a `useMemo`) - which is where a consumer needs it, because `useSyncExternalStore` subscribes during render.
 */
export function getCommGraphSubscriptionManager(
  epicId: string,
): CommGraphSubscriptionManager {
  const existing = entriesByEpicId.get(epicId);
  if (existing !== undefined) return existing.manager;
  const entry: CommGraphRegistryEntry = {
    manager: new CommGraphSubscriptionManager(epicId, (request) => {
      const claim = newestLiveClaim(epicId, entry);
      // Tag the transport with the claim that produced it, so releasing that
      // claim can find and replace it.
      entry.claimByHostId.set(request.hostId, claim);
      const opener = entry.openersByClaim.get(claim);
      if (opener === undefined) {
        throw new Error(
          `comm-graph subscription for "${epicId}" lost its claim mid-dial`,
        );
      }
      return opener(request);
    }),
    openersByClaim: new Map(),
    claimByHostId: new Map(),
    observers: new Set(),
  };
  entriesByEpicId.set(epicId, entry);
  return entry.manager;
}

/** Registers a claim-free READER of this epic's manager and returns it. */
export function observeCommGraphSubscription(
  epicId: string,
  observer: object,
): CommGraphSubscriptionManager {
  const manager = getCommGraphSubscriptionManager(epicId);
  entriesByEpicId.get(epicId)?.observers.add(observer);
  return manager;
}

/** Drops a read-only watcher, disposing the entry when it was ONLY ever watched. */
export function releaseCommGraphObserver(
  epicId: string,
  observer: object,
): void {
  const entry = entriesByEpicId.get(epicId);
  if (entry === undefined) return;
  entry.observers.delete(observer);
  if (entry.observers.size > 0) return;
  if (entry.openersByClaim.size > 0) return;
  if (detachedEpicIds.includes(epicId)) return;
  entry.manager.dispose();
  entriesByEpicId.delete(epicId);
}

/** Registers one surface's claim and attaches. */
export function acquireCommGraphSubscription(
  epicId: string,
  claim: CommGraphSubscriptionClaim,
  opener: CommGraphSubscriptionOpener,
  hostIds: ReadonlyArray<string>,
): void {
  const entry = entriesByEpicId.get(epicId);
  if (entry === undefined) return;
  // TRANSACTIONAL, for CLAIM AND ATTACH BOOKKEEPING.
  // If anything throws after the claim is inserted, React never runs the cleanup that would release it - so the claim would be held forever by a component that never mounted, keeping the epic's sockets and history out of both detach and the MRU.
  const hadClaim = entry.openersByClaim.has(claim);
  const previousOpener = entry.openersByClaim.get(claim);
  const wasAttached = entry.openersByClaim.size > 0;
  const detachedIndex = detachedEpicIds.indexOf(epicId);
  if (detachedIndex >= 0) detachedEpicIds.splice(detachedIndex, 1);
  entry.openersByClaim.set(claim, opener);
  try {
    entry.manager.setHostIds(hostIds);
    entry.manager.attach();
  } catch (error) {
    if (hadClaim && previousOpener !== undefined) {
      entry.openersByClaim.set(claim, previousOpener);
    } else {
      entry.openersByClaim.delete(claim);
    }
    // Only undo the attach this call was responsible for; surfaces that were
    // already watching keep their subscription.
    if (!wasAttached) {
      entry.manager.detach();
      entry.claimByHostId.clear();
      if (detachedIndex >= 0) detachedEpicIds.splice(detachedIndex, 0, epicId);
    }
    throw error;
  }
}

export function releaseCommGraphSubscription(
  epicId: string,
  claim: CommGraphSubscriptionClaim,
): void {
  const entry = entriesByEpicId.get(epicId);
  if (entry === undefined) return;
  entry.openersByClaim.delete(claim);
  if (entry.openersByClaim.size > 0) {
    redialOrphanedHosts(entry, claim);
    return;
  }
  entry.manager.detach();
  entry.claimByHostId.clear();
  detachedEpicIds.push(epicId);
  while (detachedEpicIds.length > DETACHED_MANAGER_LIMIT) {
    const evictedEpicId = detachedEpicIds.shift();
    if (evictedEpicId === undefined) break;
    const evicted = entriesByEpicId.get(evictedEpicId);
    if (evicted === undefined) continue;
    // An OBSERVED entry is still live.
    // Disposing it here would strand the header's feed-health dot on a dead manager: the entry would be gone, so the tile's next open would build a second one, and the dot would keep reading the corpse forever.
    if (evicted.observers.size > 0) continue;
    evicted.manager.dispose();
    entriesByEpicId.delete(evictedEpicId);
  }
}

/** Replaces the transports the departing claim opened, when other surfaces are still watching. */
function redialOrphanedHosts(
  entry: CommGraphRegistryEntry,
  departingClaim: CommGraphSubscriptionClaim,
): void {
  const orphaned = Array.from(entry.claimByHostId.entries()).flatMap(
    ([hostId, claim]) => (claim === departingClaim ? [hostId] : []),
  );
  if (orphaned.length === 0) return;
  // Cleared first so the redial's own dials re-tag them with the live claim.
  for (const hostId of orphaned) entry.claimByHostId.delete(hostId);
  entry.manager.redialHosts(orphaned);
}

/** Live claims held for an epic. Tests only. */
export function __commGraphSubscriptionRefCountForTests(
  epicId: string,
): number {
  return entriesByEpicId.get(epicId)?.openersByClaim.size ?? 0;
}

/** Whether this epic still has a retained manager. Tests only. */
export function __commGraphSubscriptionRetainedForTests(
  epicId: string,
): boolean {
  return entriesByEpicId.has(epicId);
}

/**
 * Drops every entry.
 * Tests only - a leaked manager would carry one test's events and boundaries into the next.
 */
export function __resetCommGraphRegistryForTests(): void {
  for (const entry of entriesByEpicId.values()) entry.manager.dispose();
  entriesByEpicId.clear();
  detachedEpicIds.length = 0;
}
