/**
 * ONE `epic.communicationGraph.subscribe` fan-in per epic, shared by however
 * many surfaces are looking at it.
 *
 * The Communication sidebar panel and the graph tile are independently mounted:
 * either can be open alone, both at once, or neither. A manager owned by one of
 * them would mean the other silently has no data (or, worse, a second set of
 * sockets pulling the same log twice and two event arrays that can disagree).
 * So the manager lives here and the surfaces CLAIM it:
 *
 *   first claim:      `attach` (open the sockets)
 *   second claim:     nothing - it reads the same snapshot
 *   last release:     `detach`
 *
 * A CLAIM CARRIES ITS OWN OPENER, and the manager dials through whichever claim
 * is still live. That is not bookkeeping for its own sake:
 * `useDurableStreamTransportFactory` reads its dependencies (host directory,
 * runner host, auth revalidator, credentials) through a ref that the CREATING
 * COMPONENT's effect refreshes. The moment that component unmounts the ref
 * stops being updated and freezes - so an opener retained from a dead surface
 * redials into a disposed runtime. Pinning "the first opener wins", or even
 * "the last acquirer wins", both leave that hole: the surface whose opener is
 * pinned can be the one that went away. Keying openers by claim closes it by
 * construction - a released opener is gone, so a dial can only ever pick one
 * belonging to a mounted surface.
 *
 * Detach, NOT dispose, on the last release. The manager's detach deliberately
 * keeps the accumulated events and per-host cursors, so closing the panel and
 * reopening it resumes from the cursor instead of re-pulling the log - and, just
 * as importantly, the per-host snapshot boundaries survive, so reopening does
 * not re-flash the history as if it had just arrived.
 *
 * RETENTION: detached managers are kept in a bounded MRU. Each one holds that
 * epic's whole log - uncapped `messageText`, up to 50k rows per host - so
 * keeping every epic ever visited would grow without limit until reload. The
 * newest {@link DETACHED_MANAGER_LIMIT} are retained (which is what preserves
 * the close/reopen resume for the epics a user is actually moving between);
 * older ones are disposed. A disposed epic simply re-pulls from `sinceCursor:
 * null` next time, which is correct, just not free.
 */
import { CommGraphSubscriptionManager } from "@/lib/comm-graph/comm-graph-subscription";
import type { CommGraphSubscriptionOpener } from "@/lib/comm-graph/comm-graph-subscription";

/**
 * How many DETACHED epics keep their manager (and therefore their log and
 * cursors). Small on purpose: the point is to make flipping between the handful
 * of epics in a session's working set free, not to cache history.
 */
export const DETACHED_MANAGER_LIMIT = 3;

/**
 * Identity for one surface's claim. The surface supplies a stable per-instance
 * object, so two surfaces are two claims even when a test override hands them
 * the same opener function.
 */
export type CommGraphSubscriptionClaim = object;

interface CommGraphRegistryEntry {
  readonly manager: CommGraphSubscriptionManager;
  /** Live claims, each with the opener of a currently-mounted surface. */
  readonly openersByClaim: Map<
    CommGraphSubscriptionClaim,
    CommGraphSubscriptionOpener
  >;
  /**
   * Which claim's opener produced the transport currently OPEN for each host.
   *
   * Claim-carried openers only decide FUTURE dials; a socket already open keeps
   * reading the refs of whichever surface opened it. This is the map that makes
   * those live transports recoverable when their surface leaves.
   */
  readonly claimByHostId: Map<string, CommGraphSubscriptionClaim>;
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
    // Unreachable by construction - the manager only dials while attached, and
    // it is attached only while a claim is held. Loud rather than silent,
    // because the silent version is a dial into a dead runtime.
    throw new Error(
      `comm-graph subscription for "${epicId}" dialed with no live claim`,
    );
  }
  return claim;
}

/**
 * The epic's manager, created on first ask. IDEMPOTENT and claim-free, so it is
 * safe to call while resolving a render (a `useMemo`) - which is where a
 * consumer needs it, because `useSyncExternalStore` subscribes during render.
 *
 * Takes no opener: the manager dials through whichever claim is live at the
 * time, and at construction there are none yet (nothing dials until `attach`,
 * which only happens once a claim exists).
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
  };
  entriesByEpicId.set(epicId, entry);
  return entry.manager;
}

/**
 * Registers one surface's claim and attaches.
 *
 * `hostIds` is taken HERE rather than left to a separate effect so the host set
 * is current BEFORE the sockets open. A retained manager still holds the
 * previous surface's desired set, and attaching first would dial that stale set
 * for one beat - generation gating keeps those frames from being applied, but
 * the dial itself is wrong and wasteful.
 *
 * Paired with {@link releaseCommGraphSubscription} in an EFFECT, never in
 * render: a StrictMode double-invoke runs the cleanup too, so the claims
 * balance.
 */
export function acquireCommGraphSubscription(
  epicId: string,
  claim: CommGraphSubscriptionClaim,
  opener: CommGraphSubscriptionOpener,
  hostIds: ReadonlyArray<string>,
): void {
  const entry = entriesByEpicId.get(epicId);
  if (entry === undefined) return;
  // TRANSACTIONAL, for CLAIM AND ATTACH BOOKKEEPING. If anything throws after
  // the claim is inserted, React never runs the cleanup that would release it -
  // so the claim would be held forever by a component that never mounted,
  // keeping the epic's sockets and history out of both detach and the MRU. On
  // failure this rolls back to exactly the pre-acquire state and rethrows.
  //
  // DIAL failures do not reach here: the manager contains them per host and
  // degrades to `failed` + a bounded retry, because `setHostIds` is also called
  // from a plain effect where an escaping throw would have no owner. So this
  // guards the bookkeeping around the dial, not the dial itself.
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
    evicted.manager.dispose();
    entriesByEpicId.delete(evictedEpicId);
  }
}

/**
 * Replaces the transports the departing claim opened, when other surfaces are
 * still watching.
 *
 * A live socket keeps reading the refs of the surface that opened it, and those
 * stop being refreshed the moment that surface unmounts - so a host left on the
 * departing claim's transport is one runtime change away from talking to a
 * disposed runtime. Redialing through a live claim is lossless (each host
 * resumes from its own cursor), so the safe move is simply to replace them.
 *
 * Hosts opened through a SURVIVING claim are untouched: nothing is wrong with
 * them, and needlessly cycling a healthy socket would drop frames for no reason.
 */
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
 * Drops every entry. Tests only - a leaked manager would carry one test's
 * events and boundaries into the next.
 */
export function __resetCommGraphRegistryForTests(): void {
  for (const entry of entriesByEpicId.values()) entry.manager.dispose();
  entriesByEpicId.clear();
  detachedEpicIds.length = 0;
}
