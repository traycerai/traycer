/**
 * GC roots for image bytes that are STORED but not yet referenced by any
 * document.
 *
 * There is a window nothing else covers. A paste of two files waits for BOTH
 * before inserting either: the converter gathers every result and hands the
 * whole batch to the insertion step. So when the first file's `putImage`
 * returns, its bytes are on disk and its hash exists - but no composer row, no
 * modal patch and no inline-edit document names it yet, and none will until the
 * slow sibling finishes.
 *
 * Neither of the two things that look like they cover it actually do:
 *
 *  - the **budget reservation** is capacity accounting, not a root.
 *    `landingLiveImageRootHashes` never consults the ledger.
 *  - the **session cache** is a delete-root, but `reconcile` RELEASES session
 *    entries that are absent from the live roots and then schedules a follow-up
 *    sweep - which deletes the persisted bytes. Two sweeps inside one slow read
 *    is all it takes.
 *
 * The observable failure is the worst shape available: the batch inserts
 * successfully, the node looks right, and the bytes behind its hash are gone.
 * The resolver then finds nothing locally, the mirror has nothing to upload,
 * and the send carries a hash no store can answer.
 *
 * So the hold starts the instant `putImage` returns and ends when the insertion
 * decision has been made - by which point a row or document root covers it, or
 * the batch failed and the bytes are meant to be reclaimed.
 */
import { registerExtraImageRootSource } from "@/lib/composer/landing-image-budget";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";

const hashesByHolder = new Map<string, Set<string>>();

let holderSequence = 0;

/**
 * Mint a holder id for ONE acquisition. `label` names the call site for
 * debugging; the sequence is what makes the id unique.
 *
 * The key must be per acquisition, never per surface, row or revision - the
 * same lesson `composer-content-image-roots.ts` records, and one this module
 * has now learned the hard way. Two acquisitions can legitimately overlap
 * under any value derived from what they are FOR: two applies of the same
 * draft whose revisions arrive while the first is still reading, two tiles
 * showing one row, a composer remounted mid-batch. Under a shared key the
 * second `hold` merges into the first's entry and the FIRST `finally` then
 * deletes the second's hashes - releasing a root while the work that needs
 * it is still running, which is the reap this module exists to prevent. The
 * shape is at its worst when the second acquisition's hash was a LOCAL hit:
 * no request was made for it, so nothing re-writes the bytes, and the apply
 * installs a document naming a digest the store cannot answer.
 *
 * Minting here rather than asking each caller for a unique value is
 * deliberate: there is no correct caller-supplied value, so there is nothing
 * for a caller to get wrong.
 */
export function mintPendingIngestHolderId(label: string): string {
  holderSequence += 1;
  return `${label}#${holderSequence}`;
}

/**
 * Root `hash` under `holderId` from now until that holder is released. Called
 * per hash as each completes, not once per batch, so an early finisher is
 * covered for the whole time its siblings are still running.
 *
 * `holderId` must come from `mintPendingIngestHolderId` - see its docs for
 * what a shared key costs.
 */
export function holdPendingIngestImageHash(
  holderId: string,
  hash: string,
): void {
  const existing = hashesByHolder.get(holderId);
  if (existing === undefined) {
    hashesByHolder.set(holderId, new Set([hash]));
    return;
  }
  existing.add(hash);
}

/**
 * Release every hash held under `holderId`.
 *
 * Must run on EVERY exit from the batch - inserted, not inserted, thrown,
 * aborted - or these bytes are pinned for the life of the renderer. The
 * insertion path releases only after insertion has happened, so custody passes
 * to the document's own root with no gap.
 */
export function releasePendingIngestImageHashes(holderId: string): void {
  if (!hashesByHolder.delete(holderId)) return;
  // Same edge as `releaseComposerContentImageRoots`: dropping the last root for
  // a hash is what MAKES it an orphan, and a sweep that ran while this hold
  // stood saw it as rooted and kept the bytes. Without a sweep on this edge the
  // reclaim waits on an unrelated later one. Debounced, so a burst costs one.
  scheduleLandingImageReconcile();
}

export function pendingIngestImageHashRoots(): ReadonlyArray<string> {
  const hashes: string[] = [];
  for (const held of hashesByHolder.values()) hashes.push(...held);
  return hashes;
}

export function __resetPendingIngestImageRootsForTests(): void {
  hashesByHolder.clear();
}

registerExtraImageRootSource({ hashes: pendingIngestImageHashRoots });
