import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys";

/**
 * The renderer-local ceiling on a deferred create's binding-seed hold.
 *
 * Named against the host's own `WORKTREE_ADD_TIMEOUT_MS = 120_000`
 * (`worktree-service.ts:97`), which gui-app cannot import - it is module-private
 * there - plus headroom for the round trip, the session open and the hydrated
 * drain that runs the add. The timer is the cover for a tile closed before the
 * setup outcome and for a host that never comes back: with the create's success
 * invalidation held, the seeded rows stay fresh under the app's global
 * `staleTime` and a remount inside 60 s does not refetch, so without a backstop
 * an abandoned window would hold the epic's listing forever.
 *
 * It is NOT a bound on the add: under a live shutdown claim the host defers the
 * drain for up to the claim TTL (five minutes), so the hold can expire before
 * the add even starts. The chip then shows the session's Local heal until the
 * driver's own release lands the worktree row. Accepted.
 */
export const EPIC_CREATE_SEED_HOLD_TIMEOUT_MS = 150_000;

/**
 * What one landing/modal create registers while its epic's binding listing is
 * not yet host truth.
 *
 * Two independent facts, because two consumers ask different questions
 * (`seedRows` for the `worktree.changed` burst guard, `heldForDeferredCreate`
 * for the create-path refetch hold) and a deferred create can be either:
 *
 * - `seedRows` - this create wrote optimistic rows into the epic's binding
 *   query. True for today's landing mark, deferred or not; false for the modal,
 *   which seeds nothing, and for a landing create whose picked folder produced
 *   no rows.
 * - `heldForDeferredCreate` - this create carried `deferWorktreeProvisioning`
 *   AND owns the seed the host will not be able to answer for until the add
 *   lands. Only the LANDING create sets it: the modal defers but holds nothing,
 *   because it has no seed to protect.
 *
 * `hostId` is the PLACEMENT host captured at the mark. The create-path helper's
 * scope is one host while an epic's chats can be placed on several, so a hold on
 * host A must never suppress host B's listing of the same epic - B's listing
 * shares nothing with A's seed.
 *
 * `release` is ONLY the captured epic-key invalidate the marking surface built
 * from its own `queryClient` and `hostId`. Callers never invoke it directly;
 * {@link releaseEpicCreateSeed} is the one definition of when it runs.
 */
export interface EpicCreateSeedEntry {
  readonly hostId: string;
  /**
   * The initial message's id, when this create seeded one. The tile-level
   * driver looks the queued row and the setup card up by it. `null` for the
   * terminal-agent landing create (`chat: null`), whose pair the driver never
   * owns anyway.
   */
  readonly seededMessageId: string | null;
  readonly seedRows: boolean;
  readonly heldForDeferredCreate: boolean;
  readonly release: () => void;
}

interface TimedEpicCreateSeedEntry extends EpicCreateSeedEntry {
  /** `window.setTimeout` handle for this pair's backstop; `null` until armed. */
  timer: number | null;
}

/**
 * Epics whose create-path binding state is still the renderer's rather than the
 * host's, keyed `epicId` -> `chatId` -> entry.
 *
 * Per PAIR and not per epic because two creates can be live in one epic at
 * once: a landing create still holding its seed, and a modal create into that
 * same epic. Each owns its own lifetime, its own timer and its own release.
 * The terminal-agent landing create files under `chatId: null`.
 */
const entriesByEpic = new Map<
  string,
  Map<string | null, TimedEpicCreateSeedEntry>
>();

export function markEpicCreateSeedPending(
  epicId: string,
  chatId: string | null,
  entry: EpicCreateSeedEntry,
): void {
  const byChat =
    entriesByEpic.get(epicId) ??
    new Map<string | null, TimedEpicCreateSeedEntry>();
  // A re-mark on the same pair would strand an armed timer, which then fires
  // against the NEW entry. Neither surface can reach it (both mint a fresh
  // `chatId` per submit), but the invariant is cheap to keep here rather than
  // to argue at every call site.
  cancelTimer(byChat.get(chatId));
  byChat.set(chatId, { ...entry, timer: null });
  entriesByEpic.set(epicId, byChat);
}

/**
 * Unconditional per-pair delete, timer included.
 *
 * The arm every path that will never produce a setup outcome uses: the landing
 * refusal and rejection arms, and `epic.createChat`'s `onError`. Nothing else
 * would ever remove those entries - `onSuccess` returns at a refusal before any
 * hold or timer, and `onError` never touches the marker - and a lifecycle throw
 * inside `onSuccess` AFTER the timer arm rejects into the same rejection arm, so
 * the cancel is load-bearing rather than defensive.
 */
export function clearEpicCreateSeedPending(
  epicId: string,
  chatId: string | null,
): void {
  takeEntry(epicId, chatId);
}

/**
 * The success arm's clear: deletes the pair only when it is NOT held.
 *
 * A held entry has to survive its own create's response. The mark established
 * the hold at submit and `onSuccess` armed its timer before this runs, so an
 * unconditional delete here would leave nothing that ever invalidates the
 * epic's key - the chip would sit on the seeded folders until something
 * unrelated refetched it.
 *
 * The timer is cancelled only when this call actually deletes, so a held entry
 * keeps the backstop `onSuccess` just armed.
 */
export function clearUnheldEpicCreateSeed(
  epicId: string,
  chatId: string | null,
): void {
  const entry = entriesByEpic.get(epicId)?.get(chatId);
  if (entry === undefined || entry.heldForDeferredCreate) return;
  takeEntry(epicId, chatId);
}

/**
 * Arm this pair's backstop at its own create's RESPONSE. A no-op for a pair
 * with no entry, which is what makes it safe to call unconditionally from
 * `onSuccess` on both lines (the fork dialog, the tile side-chat and
 * clone-on-host-switch all register nothing).
 *
 * Per pair rather than per epic: the modal's entry is unheld by construction
 * and still needs a timer, and an epic-wide arm from `epic.createChat`'s
 * `onSuccess` would let any fork or side-chat into a held landing epic push the
 * landing hold past its ceiling.
 */
export function armEpicCreateSeedHoldTimer(
  epicId: string,
  chatId: string | null,
): void {
  const entry = entriesByEpic.get(epicId)?.get(chatId);
  if (entry === undefined) return;
  cancelTimer(entry);
  entry.timer = window.setTimeout(() => {
    releaseEpicCreateSeed(epicId, chatId);
  }, EPIC_CREATE_SEED_HOLD_TIMEOUT_MS);
}

/**
 * Give up this pair's claim on the epic's binding listing and, if it was the
 * LAST holder on its host, refetch that listing.
 *
 * The last-releaser rule is what keeps a deferred modal create out of a live
 * landing hold. The landing flow places its tab at the response while the hold
 * runs on to the add, so the epic the user is sitting in can be the landing
 * epic still under hold; a deferred modal create into it registers an unheld
 * entry whose driver or timer can fire on the modal chat's own setup outcome
 * well before the landing add finishes. Without the rule that release would
 * refetch straight through the landing seed. With it, the modal's release
 * clears its own entry and invalidates nothing, and the landing release then
 * lands both rows.
 *
 * Idempotent once the pair is gone - a timer firing for a pair a clear already
 * removed does nothing.
 */
export function releaseEpicCreateSeed(
  epicId: string,
  chatId: string | null,
): void {
  const entry = takeEntry(epicId, chatId);
  if (entry === null) return;
  if (isEpicCreateHeld(entry.hostId, epicId)) return;
  entry.release();
}

/** The entry this pair owns, or `null`. The driver's lookup. */
export function readEpicCreateSeed(
  epicId: string,
  chatId: string | null,
): EpicCreateSeedEntry | null {
  return entriesByEpic.get(epicId)?.get(chatId) ?? null;
}

/**
 * Whether an optimistic binding seed written by a create on THIS host is still
 * authoritative for this epic - the `worktree.changed` burst guard's question.
 *
 * Host-aware because a deferred create's mark now outlives the response for the
 * whole hold: a host-blind read would downgrade another host's listing of the
 * same epic to mark-only for the entire window, where today's blindness lasts
 * one round trip.
 */
export function isEpicCreateSeedPending(
  hostId: string,
  epicId: string,
): boolean {
  return anyEntry(epicId, (entry) => entry.hostId === hostId && entry.seedRows);
}

/**
 * Whether a deferred create on THIS host still holds this epic's binding
 * listing against the create-path refetch.
 */
export function isEpicCreateHeld(hostId: string, epicId: string): boolean {
  return anyEntry(
    epicId,
    (entry) => entry.hostId === hostId && entry.heldForDeferredCreate,
  );
}

/**
 * The create-path refetch of `worktree.listBindingsForEpic`, minus the epics a
 * deferred create is still holding on this host.
 *
 * THE HOLD IS A PROPERTY OF THE QUERY KEY, not of one call site: both
 * create-path invalidations (`epic.create`'s `onSuccess` and `epic.createChat`'s
 * `invalidateBindingsForEpic`) go through here, so a modal create anywhere on
 * the host - and a second landing create that seeded nothing - still refetches
 * every other epic's listing at the response exactly as today and leaves a live
 * hold alone.
 *
 * A held query is neither refetched NOR marked. Marking is not the softer
 * option: an invalidated query refetches on its next observer mount regardless
 * of `staleTime`, which is precisely the freshness the hold depends on. The
 * epic's own release invalidates it later.
 *
 * Deliberately NOT routed through here, and accepted: the binding-mutation
 * hooks on `WORKTREE_BINDING_INVALIDATIONS`, retry-setup's hand-rolled loop,
 * and the post-delete `invalidateWorktreeListingAndBindingCaches` slice all
 * reach this same scope with no predicate. One of those running in another tab
 * during a window refetches the held epic too - the chip then stays empty until
 * the entry's own release (before the session's Local heal) or shows the heal's
 * folders in Local mode (after it), and the release still lands the worktree
 * row.
 */
export function invalidateBindingListingsExceptHeld(
  queryClient: QueryClient,
  hostId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "worktree.listBindingsForEpic"),
    refetchType: "active",
    predicate: (query) => !isHeldBindingsQuery(hostId, query.queryKey),
  });
}

/**
 * The `{ epicId }` a `worktree.listBindingsForEpic` query key ends in (see
 * `hostQueryKeys.method`), or `null` for any other shape.
 *
 * Shared by this module's own hold predicate and the `worktree.changed` burst
 * handler's seed predicate so the two readings of the key can never drift.
 */
export function bindingsQueryEpicId(queryKey: QueryKey): string | null {
  const params: unknown = queryKey[queryKey.length - 1];
  if (params === null || typeof params !== "object") return null;
  if (!("epicId" in params)) return null;
  const epicId: unknown = params.epicId;
  return typeof epicId === "string" ? epicId : null;
}

function isHeldBindingsQuery(hostId: string, queryKey: QueryKey): boolean {
  const epicId = bindingsQueryEpicId(queryKey);
  return epicId !== null && isEpicCreateHeld(hostId, epicId);
}

function anyEntry(
  epicId: string,
  predicate: (entry: TimedEpicCreateSeedEntry) => boolean,
): boolean {
  const byChat = entriesByEpic.get(epicId);
  if (byChat === undefined) return false;
  for (const entry of byChat.values()) {
    if (predicate(entry)) return true;
  }
  return false;
}

/** Remove the pair, cancelling its timer, and hand back what was there. */
function takeEntry(
  epicId: string,
  chatId: string | null,
): TimedEpicCreateSeedEntry | null {
  const byChat = entriesByEpic.get(epicId);
  if (byChat === undefined) return null;
  const entry = byChat.get(chatId);
  if (entry === undefined) return null;
  cancelTimer(entry);
  byChat.delete(chatId);
  if (byChat.size === 0) entriesByEpic.delete(epicId);
  return entry;
}

function cancelTimer(entry: TimedEpicCreateSeedEntry | undefined): void {
  if (entry === undefined || entry.timer === null) return;
  window.clearTimeout(entry.timer);
  entry.timer = null;
}
