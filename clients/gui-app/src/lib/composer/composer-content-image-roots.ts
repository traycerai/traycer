/**
 * GC roots for image bytes referenced by composer content that lives NOWHERE
 * ELSE - not in a persisted draft row, not in a chat session store slice.
 *
 * `landing-image-gc.reconcile` deletes every stored hash outside the live
 * roots. Its root sources cover the persisted surfaces (composer-draft rows,
 * new-chat rows, stash entries) and the chat session's pending annotations.
 * Two kinds of content are outside all of them and would be reaped while still
 * needed:
 *
 *  - **The inline message editor's document.** `currentContent` lives in the
 *    tile's own `chatTileUiReducer` state (`chat-tile-session-state.ts`) and is
 *    written to no store until Submit. `epic-draft-guard.ts` already exists
 *    because of the same gap on the parking side - this is its byte-custody
 *    twin.
 *  - **Content captured for an in-flight submit preparation.** Between the
 *    capture and the send, the surface's own draft row may already have been
 *    replaced or cleared; the reconcile that runs in that window must not
 *    delete the bytes the send is on its way to inline.
 *
 * ## Shape
 *
 * A LEAF holding content, not hashes, and walking it on read. Holding the
 * content means a caller cannot forget to re-register when its document
 * changes: the inline editor's reducer produces a new `currentContent` object
 * per keystroke, and re-deriving hashes on every one of those to keep a hash
 * set current would be the expensive half of this done needlessly. Reconcile is
 * debounced and rare; a keystroke is not.
 *
 * ## Releasing is as load-bearing as registering
 *
 * A holder that is never released pins its bytes for the life of the renderer,
 * which is the quiet version of the leak this whole module exists to bound. So
 * every registration is keyed by a per-INSTANCE id, and each call site pairs it
 * with a release on the path that ends the hold - an effect cleanup for the
 * editor, a `finally` for the preparation.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";

import { registerExtraImageRootSource } from "@/lib/composer/landing-image-budget";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import { blobHashesFromContent } from "@/lib/drafts/draft-write-codec";

const contentByHolder = new Map<string, JsonContent>();

/**
 * Record (or update) one holder's content. Idempotent per key: a holder that
 * re-registers on every document change replaces its own entry rather than
 * accumulating.
 */
export function holdComposerContentImageRoots(
  holderId: string,
  content: JsonContent,
): void {
  contentByHolder.set(holderId, content);
}

/**
 * Withdraw one holder's claim. Safe to call for a key that never registered.
 *
 * Schedules a sweep, and that is not housekeeping - it closes a retention hole.
 * Dropping the last root for a hash makes it an orphan, and nothing else was
 * triggering a reconcile on this edge: a sweep that ran while this hold was
 * still standing saw the hash as ROOTED and kept the bytes, so the release that
 * made it an orphan left it to be reclaimed by some unrelated later sweep, or
 * never. The sweep is debounced, so a burst of releases costs one.
 */
export function releaseComposerContentImageRoots(holderId: string): void {
  if (!contentByHolder.delete(holderId)) return;
  scheduleLandingImageReconcile();
}

/** Every image hash any live holder still references. */
export function composerContentImageRootHashes(): ReadonlyArray<string> {
  const hashes: string[] = [];
  for (const content of contentByHolder.values()) {
    hashes.push(...blobHashesFromContent(content));
  }
  return hashes;
}

/**
 * Run one in-flight submit preparation with `content` held as a GC root for
 * exactly as long as it takes, then release and settle on EVERY path.
 *
 * The hold/release pair is a `try`/`finally`, and it lives HERE rather than in
 * each submit hook for a reason that is not style: the React Compiler cannot
 * lower a `try` without a `catch`, so a `try`/`finally` written inside a hook
 * body silently costs that whole hook its automatic memoization. Three submit
 * surfaces needed the same pair; keeping it in one module-level function buys
 * back the memoization at all three and leaves one place where the invariant
 * can be read.
 *
 * `onSettled` is the caller's own pending-flag reset. It is a parameter rather
 * than something the caller puts in its own `finally` for that same reason -
 * splitting them would put the `try` back in the hook.
 *
 * Deliberately NO `catch`: a rejection from `run` propagates exactly as it did
 * when each call site owned this inline. Swallowing one here would turn a
 * genuine submit fault into a silently dropped send, and rethrowing would only
 * be the compiler's box ticked at the cost of a stack frame.
 *
 * ## The key is per ACQUISITION, not per surface
 *
 * `label` names the call site for debugging; the registry key is that label
 * plus a fresh token. A caller's own identity is a poor key for a hold whose
 * lifetime is one async call, because two holds can legitimately overlap under
 * it: a composer remounted under the same `taskId` while the previous
 * preparation is still awaiting `run()`, or two canvas tiles showing the same
 * chat. The second `hold` would overwrite the first's entry and the FIRST
 * `finally` would then delete the second's - releasing a root while the
 * preparation that needs it is still running, which is the reap this module
 * exists to prevent. Minting the key here rather than asking each caller to is
 * deliberate: there is no correct caller-supplied value, so there is nothing
 * for a caller to get wrong.
 */
let scopedHolderSequence = 0;

export async function withHeldComposerContentImageRoots(
  label: string,
  content: JsonContent,
  run: () => Promise<void>,
  onSettled: () => void,
): Promise<void> {
  scopedHolderSequence += 1;
  const holderId = `${label}#${scopedHolderSequence}`;
  holdComposerContentImageRoots(holderId, content);
  try {
    await run();
  } finally {
    releaseComposerContentImageRoots(holderId);
    onSettled();
  }
}

export function __resetComposerContentImageRootsForTests(): void {
  contentByHolder.clear();
}

registerExtraImageRootSource({ hashes: composerContentImageRootHashes });
