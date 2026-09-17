/**
 * Which epics currently hold user-typed text that only exists in a mounted
 * editor - the renderer's own half of parking eligibility (plan C, decision
 * C1).
 *
 * ## Why this exists
 *
 * Parking releases the epic's session and the provider publishes a `null`
 * handle, which UNMOUNTS everything behind `EpicSessionGate`: the tile canvas
 * and the sidebar's live body. Plan C's contract is that a parked tab keeps
 * its UI state, and most of it does - the tab strip, the canvas layout, the
 * tile set and the chat composer's draft all live in stores that no unmount
 * touches (`stores/composer/composer-draft-store.ts` even persists), and an
 * artifact editor's text is in the Y.Doc, so it latches `isDirty` and the
 * cap's own `holdsNothingToLose` already refuses the park.
 *
 * What has no such home is text held in a Tiptap instance INSIDE that
 * subtree, or in a tile's own `useReducer`:
 *
 *  - `components/comments/comment-composer.tsx` - the reply, new-thread and
 *    edit composers, plus the floating draft popover. Nothing is written
 *    anywhere until Submit fires the host RPC, and the composer remounts with
 *    `initialContent: null`.
 *  - `components/epic-canvas/renderers/chat-tile.tsx` - an inline message
 *    edit, whose `currentContent` lives in `chatTileUiReducer`'s state.
 *
 * None of those touch the epic store, so `canPark`'s data-loss gate reads a
 * perfectly clean epic and the park destroys the text.
 *
 * ## Why a registry rather than a store projection
 *
 * A LEAF: this module imports nothing, which is what lets both
 * `stores/epics/open-epic/session-registry.ts` (the eligibility verdict) and
 * `lib/epics/epic-parking.ts` (the retry watch) read it. The parking module
 * documents why that matters - `lib/registries/chat-session-registry.ts`
 * imports it at module scope and is reached from anything that touches a
 * chat, so a heavy import here lands in the graph of half the app at import
 * time.
 *
 * The React binding lives next door in `lib/epics/use-epic-draft-guard.ts`
 * for the same reason: the verdict is read from a store module, which has no
 * business pulling React in behind it.
 *
 * ## What this reaches, and the one place it must NOT
 *
 * It protects text in a MOUNTED editor. Two other paths unmount the same
 * subtree and lose the same text, and the difference between them is not
 * scope, it is what a veto would cost:
 *
 *  - `TopLevelTabHost`'s `retainedTopLevelSurfaces` cap unmounts a hidden
 *    surface past the fifth. No park is involved, and by the time the question
 *    could be asked the editor is already gone - so there is nothing here to
 *    reach, by construction rather than by omission.
 *  - The `maxLiveEpics` prune evicts a warm session; the provider publishes
 *    null, the gate closes, and the subtree goes with it. This one COULD be
 *    vetoed - `eligibilityKeyFor` is one term away - and deliberately is not.
 *    Parking is optional, so refusing it costs only memory that stays
 *    resident a while longer; the CAP is not optional, and it has to be able
 *    to free something. A session made un-evictable by an open composer could
 *    leave the prune walk with no candidate at all, which trades one lost
 *    draft for unbounded growth - on the phone, where the cap exists because
 *    iOS jetsam does not negotiate. So the asymmetry between the two gates is
 *    a correctness decision. Do not "fix" it by adding a draft term to the
 *    cap's own predicates.
 *
 * ## Clearing is as load-bearing as registering
 *
 * A stale holder is not a small bug: an epic that keeps one parks NEVER, and
 * the memory reclaim parking exists for is silently off for that epic for the
 * life of the tab. So registration is keyed by a per-INSTANCE id rather than
 * by a name two composers could share, and the only writer is the hook's
 * effect - whose cleanup runs on unmount, on an epic change, and on the edit
 * going away. There is no path that registers without a matching cleanup.
 */

/**
 * Epic -> the ids of the editor instances currently holding unsaved text.
 * An epic with no holders has no entry, so the map is empty in the steady
 * state rather than accumulating a row per epic ever opened.
 */
const holdersByEpic = new Map<string, Set<string>>();
const listeners = new Set<(epicId: string) => void>();

function notify(epicId: string): void {
  // Over a COPY: a listener re-attempts the park, which unsubscribes itself
  // from inside this loop (`attemptPark` -> `stopWatchingEligibility`).
  for (const listener of Array.from(listeners)) {
    listener(epicId);
  }
}

/**
 * Record or withdraw one editor instance's claim that it holds text a remount
 * would not restore.
 *
 * Notifies only when the EPIC's answer changes, because that boolean is the
 * whole of what a subscriber can act on - a second composer starting a draft
 * on an epic already holding one has changed nothing about its eligibility.
 */
export function setEpicDraftHeld(
  epicId: string,
  draftId: string,
  held: boolean,
): void {
  const holders = holdersByEpic.get(epicId);
  if (held) {
    if (holders !== undefined) {
      holders.add(draftId);
      return;
    }
    holdersByEpic.set(epicId, new Set([draftId]));
    notify(epicId);
    return;
  }
  if (holders === undefined) return;
  if (!holders.delete(draftId)) return;
  if (holders.size > 0) return;
  holdersByEpic.delete(epicId);
  notify(epicId);
}

/** Whether any mounted editor of this epic holds unsaved user-typed text. */
export function epicHoldsUnsavedDraft(epicId: string): boolean {
  return holdersByEpic.has(epicId);
}

/**
 * Watch the per-epic answer. The listener is handed the epic whose answer
 * changed, so a park deferred for a draft re-attempts the moment that draft
 * is submitted, discarded or emptied - without waiting for a fresh hide edge,
 * which may never come.
 */
export function subscribeEpicDraftGuard(
  listener: (epicId: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Forget every holder.
 *
 * `listeners` is deliberately NOT cleared, for the reason
 * `__resetEpicParkingForTests` states about its own: subscribers here are
 * installed by live code (the parking module's eligibility watch), and
 * dropping them would disarm the retry for the rest of the file while every
 * assertion about the flag itself still passed.
 */
export function __resetEpicDraftGuardForTests(): void {
  holdersByEpic.clear();
}
