/**
 * The in-place b64 -> hash rewrite, for the three chat surfaces.
 *
 * Two channels reach the same job. A FILE paste/drop/pick is converted before
 * insertion (`useComposerHashPasteAdapter`), so it arrives already hashed. A
 * RICH-CLIPBOARD paste (`data-b64content` in the pasted HTML) cannot be: the
 * paste handler must keep those nodes in document order, at their positions,
 * and can only stamp them with fresh ids. So the node goes in carrying its
 * bytes and a background job flips it to a hash IN PLACE.
 *
 * ## The b64 node IS the work token
 *
 * That is the whole model, and it is what makes this recoverable rather than
 * merely careful. The document is the queue: a node still carrying
 * `b64content` is a job that has not finished, wherever it came from and
 * however the app got here. So `reingestPendingImages` on mount restarts them
 * all - covering a draft written by a version that had no rewrite at all
 * (every existing large draft on upgrade), an editor torn down mid-job, and a
 * navigate-away-and-back.
 *
 * Idempotent by construction: `putImage` is content-addressed and
 * single-flight, and the rewrite is by node id - so re-ingesting a node whose
 * bytes an aborted earlier job already stored just re-roots the same hash.
 *
 * ## Why this is a shared hook rather than four copies
 *
 * `landing-composer.tsx` grew this logic first and kept a private copy while
 * this hook was extracted, because it was the control the three new callers
 * were compared against. It is repointed here, and the copy is gone.
 *
 * The note this replaces said the two differed by "one argument (`draftId`)".
 * That was true when it was written and false by the time it was acted on: the
 * review that hardened this hook gave it FIVE behaviours the private copy never
 * received - a deadline on the store write, a reconcile for a write that lands
 * after that deadline, the format verdict running before budget admission,
 * reservations keyed by image index rather than a running counter, and leaving
 * a format the host refuses INLINE rather than hashing it. A pasted BMP on the
 * landing composer was hashed, refused by the host's writer, and left its
 * budget reservation held.
 *
 * The general point, recorded because the next extraction will face it: a
 * duplicate left in place as a "reference" stops being one the moment its twin
 * is fixed, and nothing tells you when that happened. The claim that two copies
 * differ by one argument is a fact with a shelf life - re-derive it, do not
 * carry it forward.
 */
import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type {
  PastedComposerImage,
  PastedComposerImageOutcome,
} from "@/components/chat/composer/editor/extensions/chat-paste-handler";
import { decodeValidatedPastedImage } from "@/hooks/composer/use-landing-composer-paste";
import { isHostStorableImageMimeType } from "@/lib/composer/host-storable-image-formats";
import {
  IMAGE_READ_TIMEOUT_MS,
  withAbortableDeadline,
} from "@/hooks/composer/use-composer-paste";
import {
  collectImageAtoms,
  type ComposerImageAtom,
} from "@/lib/composer/image-atoms";
import { putImage } from "@/lib/composer/landing-image-store";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import {
  reserveLandingImageBudget,
  type LandingImageBudgetReservation,
} from "@/lib/composer/landing-image-budget";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

/**
 * Exactly what this hook needs of an editor, named as a port rather than taken
 * as the whole `ComposerPromptEditorHandle`: a fake for a four-method contract
 * is honest, whereas a fake for the full handle is a cast pretending to be one.
 * `ComposerPromptEditorHandle` satisfies this structurally.
 */
export interface PendingImageIngestEditorHandle {
  readonly isReady: () => boolean;
  readonly getJSON: () => JsonContent;
  readonly removeImageAttachmentById: (id: string) => void;
  readonly rewriteImageAttachmentHashById: (
    id: string,
    hash: string,
  ) => boolean;
}

export interface ComposerPendingImageIngest {
  /**
   * Validate a rich paste's inline images, mint an id and start a background
   * job per accepted one, and report a verdict per image so the paste handler
   * can keep the accepted nodes in place and drop the rejected ones.
   */
  readonly ingestPastedComposerImages: (
    images: ReadonlyArray<PastedComposerImage>,
  ) => ReadonlyArray<PastedComposerImageOutcome>;
  /** Mount-time restart for every node still carrying bytes. */
  readonly reingestPendingImages: () => void;
}

interface PendingImageIngestOptions {
  readonly onSettled: (() => void) | undefined;
  /**
   * Reserve capacity AFTER the store settles, using the now-known hash.
   * Mount-time re-entry does this: the bytes may already be stored and rooted,
   * so charging them anonymously up front would double-count against a
   * reservation that an aborted earlier job is still holding.
   *
   * It also says something the failure paths depend on: this node is ALREADY
   * in the document, carrying its own `b64content`. A fresh paste has nothing
   * to lose when ingest fails - the image was never in the draft, and removing
   * the placeholder is the honest outcome. A re-entry does: the inline bytes
   * are the draft's durable copy and are sendable exactly as they are, so a
   * failed MIGRATION must leave them alone - both failure paths below
   * return without touching the node when this is set.
   */
  readonly reserveAfterStore: boolean;
}

/**
 * The whole ingest job, at MODULE level rather than inside the hook.
 *
 * Not a style choice: a `try` in a hook body is syntax the React Compiler
 * does not support, so it silently drops memoization for the entire hook -
 * and this job needs `try/catch/finally` (the reservation must be released on
 * every exit, and a stalled store now rejects at a deadline). Batch 1 hit the
 * same wall and resolved it the same way: the hook stays a thin `useCallback`
 * and the control flow lives out here.
 */
async function runPendingImageIngestJob(args: {
  readonly signal: AbortSignal;
  readonly id: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly options: PendingImageIngestOptions;
  readonly editorRef: {
    readonly current: PendingImageIngestEditorHandle | null;
  };
  readonly draftId: string | null;
}): Promise<void> {
  const { signal, id, bytes, options, editorRef, draftId } = args;
  let postStoreReservation: LandingImageBudgetReservation | null = null;
  try {
    // Bounded and abort-responsive, for the same reason the file
    // converter's awaits are: a stalled store otherwise leaves this
    // node inline forever, and with the collector's pending-node guard
    // that withholds the whole draft indefinitely.
    // Hoisted so the WRITE is observed independently of the WAIT, exactly as
    // the paste path does. The deadline (or an abort) ends this job; it cannot
    // cancel an IndexedDB write already issued, so a stalled `putImage` that
    // later succeeds seeds the store with bytes no node references - and the
    // failure path's own reconcile can run BEFORE that write lands, with
    // nothing scheduling another. Repeated stalled migrations accumulate.
    const storing = putImage(bytes);
    void storing.then(
      () => {
        scheduleLandingImageReconcile();
      },
      () => undefined,
    );
    const hash = await withAbortableDeadline(
      storing,
      IMAGE_READ_TIMEOUT_MS,
      signal,
      () => "Storing the pasted image timed out",
    );
    const handle = editorRef.current;
    if (signal.aborted || handle === null || !handle.isReady()) {
      // The editor went away mid-job, so the pending node is gone from
      // THIS mount and the just-stored bytes have no root. A remount that
      // still holds the b64 node re-ingests and re-roots the same hash
      // before the debounced sweep runs.
      scheduleLandingImageReconcile();
      return;
    }
    if (options.reserveAfterStore) {
      postStoreReservation = reserveLandingImageBudget(draftId, [
        { hash, bytes: bytes.byteLength },
      ]);
      if (postStoreReservation === null) {
        // The node STAYS. This is a migration of bytes the draft already
        // holds inline, not a new paste being refused: `b64content` is the
        // durable copy, so removing the node discarded the user's attachment
        // for no reason other than opening a draft while the budget was full.
        //
        // The cost is real and bounded, and it is why this branch differs from
        // the `putImage` rejection below. An inline node keeps the draft out of
        // `collectDirtyWrites` (see `containsPendingInlineImageNode`), so the
        // row does not SYNC until a later re-entry migrates it - the draft is
        // still local, still edited, still sent. A full budget is a recoverable,
        // user-relievable condition and every mount retries. A broken store is
        // not: there the node could never migrate, so withholding the row
        // forever is worse than saying so and dropping it.
        scheduleLandingImageReconcile();
        return;
      }
    }
    if (!handle.rewriteImageAttachmentHashById(id, hash)) {
      // The user deleted the pending node before the write settled, so
      // the stored bytes are unrooted - reclaim them.
      scheduleLandingImageReconcile();
    }
  } catch {
    if (signal.aborted) {
      // The surface was left mid-job; a successor mount re-ingests. No
      // toast for a composer the user has already navigated away from.
      scheduleLandingImageReconcile();
      return;
    }
    editorRef.current?.removeImageAttachmentById(id);
    reportableErrorToast(
      "Couldn't attach the image.",
      { description: "Please try adding it again." },
      {
        title: "Could not attach image",
        message: null,
        code: null,
        source: "Chat composer",
      },
    );
    scheduleLandingImageReconcile();
  } finally {
    postStoreReservation?.release();
    options.onSettled?.();
  }
}

export function useComposerPendingImageIngest(args: {
  readonly editorRef: {
    readonly current: PendingImageIngestEditorHandle | null;
  };
  readonly runPendingImageJob: (
    job: (signal: AbortSignal) => Promise<void>,
  ) => void;
  /**
   * Names the budget toast's wording only. `null` on every chat surface -
   * none of them is a landing draft the user could close to free capacity.
   */
  readonly draftId: string | null;
}): ComposerPendingImageIngest {
  const { editorRef, runPendingImageJob, draftId } = args;

  const startPendingImageIngest = useCallback(
    (
      id: string,
      bytes: Uint8Array<ArrayBuffer>,
      options: PendingImageIngestOptions,
    ) => {
      runPendingImageJob((signal) =>
        runPendingImageIngestJob({
          signal,
          id,
          bytes,
          options,
          editorRef,
          draftId,
        }),
      );
    },
    [draftId, editorRef, runPendingImageJob],
  );

  const ingestPastedComposerImages = useCallback(
    (
      images: ReadonlyArray<PastedComposerImage>,
    ): ReadonlyArray<PastedComposerImageOutcome> => {
      // The format verdict runs BEFORE budget admission, and that order is the
      // fix: reserving for every decoded image charged capacity for fallback
      // images that then started no job, so nothing ever released their
      // handles. Repeated BMP pastes drained the 64 MiB ledger with no bytes
      // stored, and near the cap a fallback node could consume the very
      // reservation its storable sibling needed.
      const plans = images.map((image) => ({
        bytes: decodeValidatedPastedImage(image),
        storable: isHostStorableImageMimeType(image.mimeType),
      }));
      // Reservation per STORABLE decoded image, kept attached to that image by
      // index rather than by a running counter - a counter advanced only for
      // storable images and so lost the association in a mixed batch, releasing
      // one image's handle from another image's job.
      const reservationByIndex = new Map<
        number,
        LandingImageBudgetReservation
      >();
      // `for...of`, not `forEach`: oxlint's `no-unnecessary-condition` cannot
      // see a `let` mutated inside an arrow callback and calls the later read
      // of it always-falsy.
      let admitted = true;
      for (const [index, plan] of plans.entries()) {
        if (plan.bytes === null || !plan.storable) continue;
        const reservation = reserveLandingImageBudget(draftId, [
          { hash: null, bytes: plan.bytes.byteLength },
        ]);
        if (reservation === null) {
          admitted = false;
          break;
        }
        reservationByIndex.set(index, reservation);
      }
      if (!admitted) {
        for (const reservation of reservationByIndex.values()) {
          reservation.release();
        }
        reservationByIndex.clear();
        scheduleLandingImageReconcile();
      }
      // Only UNDECODABLE images count toward the generic toast. One blocked
      // solely by the budget already got `reserveLandingImageBudget`'s own
      // accurate message, and adding this one would state a false cause.
      let corruptedCount = 0;
      const outcomes = plans.map((plan, index): PastedComposerImageOutcome => {
        if (plan.bytes === null) {
          corruptedCount += 1;
          return { kind: "rejected" };
        }
        // A format the host's writer refuses stays INLINE, exactly as the file
        // path leaves it: "accepted" with a fresh id keeps the node and its
        // bytes in place, and starting no job is what leaves it inline. It
        // reserved nothing, so there is nothing to release either.
        if (!plan.storable) return { kind: "accepted", id: uuidv4() };
        const reservation = reservationByIndex.get(index);
        if (reservation === undefined) return { kind: "rejected" };
        const id = uuidv4();
        startPendingImageIngest(id, plan.bytes, {
          onSettled: () => reservation.release(),
          reserveAfterStore: false,
        });
        return { kind: "accepted", id };
      });
      if (corruptedCount > 0) showPastedImageToast(corruptedCount);
      return outcomes;
    },
    [draftId, startPendingImageIngest],
  );

  const reingestPendingImages = useCallback(() => {
    const handle = editorRef.current;
    if (handle === null || !handle.isReady()) return;
    const pending = collectImageAtoms(handle.getJSON()).filter(
      (atom): atom is ComposerImageAtom & { readonly b64content: string } =>
        atom.b64content !== null,
    );
    if (pending.length === 0) return;
    let corruptedCount = 0;
    for (const atom of pending) {
      const bytes = decodeValidatedPastedImage({
        fileName: atom.fileName,
        mimeType: atom.mimeType,
        b64content: atom.b64content,
      });
      if (bytes === null) {
        // Only reachable from a corrupted or hand-edited restore: it can never
        // be ingested, so drop it rather than leave a node nothing can resolve.
        handle.removeImageAttachmentById(atom.id);
        corruptedCount += 1;
        continue;
      }
      // Left inline on purpose by the file ingest, so leave it inline here too.
      // This runs on EVERY editor mount, so without the guard a BMP the paste
      // path kept inline would be silently hashed the next time the composer
      // opened - the format decision undone one mount later.
      if (!isHostStorableImageMimeType(atom.mimeType)) continue;
      startPendingImageIngest(atom.id, bytes, {
        onSettled: undefined,
        reserveAfterStore: true,
      });
    }
    if (corruptedCount > 0) showPastedImageToast(corruptedCount);
  }, [editorRef, startPendingImageIngest]);

  return { ingestPastedComposerImages, reingestPendingImages };
}

function showPastedImageToast(corruptedCount: number): void {
  reportableErrorToast(
    corruptedCount === 1
      ? "Couldn't attach a pasted image."
      : "Couldn't attach some pasted images.",
    { description: "The image was corrupted or too large." },
    {
      title: "Could not attach image",
      message: null,
      code: null,
      source: "Chat composer",
    },
  );
}
