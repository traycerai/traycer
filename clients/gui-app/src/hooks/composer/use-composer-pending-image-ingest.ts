/**
 * The in-place b64 -> prepare + hash rewrite, for the three chat surfaces.
 *
 * The job PREPARES before it stores (≤ 2000 px longest edge, ≤ 3.75 MiB,
 * animation preserved), so what the hash addresses is what the node describes
 * and what the send carries. That is why the rewrite takes the whole
 * `ImageAttachmentRewrite` and not a bare hash, and why a node's `size` and
 * `mimeType` can differ from the bytes that were pasted.
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
import { useCallback, useMemo, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type {
  PastedComposerImage,
  PastedComposerImageOutcome,
} from "@/components/chat/composer/editor/extensions/chat-paste-handler";
import type { ImageAttachmentRewrite } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import {
  createComposerImagePreparationSession,
  prepareComposerImageBytesOrRefuse,
  showImageTooLargeToast,
  type ImagePreparationSession,
} from "@/lib/composer/composer-image-preparation";
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
  /**
   * Takes the whole rewrite, not a bare hash: this job PREPARES before it
   * stores, so the bytes the hash addresses may be a different format and a
   * different length than the ones the node was stamped with. The node's
   * `mimeType`, `fileName`, `size` and `byHashEligible` all have to move with
   * the hash or the node describes bytes nobody holds.
   */
  readonly rewriteImageAttachmentHashById: (
    id: string,
    rewrite: ImageAttachmentRewrite,
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
  /**
   * EDGE-TRIGGERED re-ingest, safe to call on every content change.
   *
   * Paste is not the only way a b64 image node enters the document. The
   * mention extension appends a browser-preview screenshot asynchronously,
   * long after mount (`commitBrowserTabPreviewInsertion`), and mount-time
   * re-entry cannot see a node that does not exist yet. Without an on-change
   * caller such a node travels inline until the next mount.
   *
   * Idempotent per node for the life of the mount, so calling it per keystroke
   * costs a scan and nothing else: a node whose job has been started is never
   * started again, which covers the one that settled, the one still in flight,
   * and - the case that would otherwise be a per-keystroke prepare + budget
   * reservation - the one preparation REFUSED, which by the migration
   * invariant stays inline on purpose.
   */
  readonly noteContentImages: (content: JsonContent) => void;
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
  /** The node's own name and type: what preparation declares against. */
  readonly fileName: string;
  readonly mimeType: string;
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
  readonly preparationSession: ImagePreparationSession;
}): Promise<void> {
  const { signal, id, bytes, options, editorRef, draftId, preparationSession } =
    args;
  let postStoreReservation: LandingImageBudgetReservation | null = null;
  // The caller's reservation is released when this job can no longer commit -
  // which on ABORT is the moment the signal fires, not whenever preparation
  // and the store happen to settle. An aborted job returns without rewriting
  // from every branch below, so it is holding an ANONYMOUS charge for bytes it
  // will never root, and anonymous bytes cannot dedupe against the successor
  // mount's hash-keyed charge the way two hash-keyed reservations do. Near the
  // cap that is the difference between a remount re-rooting the image and
  // being refused, which removes a node the user already had. It is also what
  // the reservation contract asks: release once the caller "discovers it will
  // not be committed". Every other branch still releases in `finally`.
  let callerReservationReleased = false;
  const releaseCallerReservation = (): void => {
    if (callerReservationReleased) return;
    callerReservationReleased = true;
    options.onSettled?.();
  };
  signal.addEventListener("abort", releaseCallerReservation, { once: true });
  try {
    // PREPARE before storing: ≤ 2000 px longest edge, ≤ 3.75 MiB, animation
    // preserved. The store, the node and the send then all describe the same
    // bytes. Preparation runs on this mount's single session, so the jobs this
    // hook launches in one tick - a multi-image paste, or mount-time re-entry
    // over a draft holding several - decode one at a time instead of holding
    // one bitmap each.
    const preparation = await prepareComposerImageBytesOrRefuse(
      preparationSession,
      bytes,
      options.fileName,
      options.mimeType,
    );
    if (preparation.kind === "refused") {
      // Same split as every other failure here: a fresh paste never had the
      // image in the draft, so dropping the placeholder (with the one refusal
      // toast) is honest; a MIGRATION's inline bytes are the draft's durable
      // copy and are sendable as they are, so it leaves the node alone and
      // stays quiet - the user did not just act.
      if (!options.reserveAfterStore && !signal.aborted) {
        showImageTooLargeToast(options.fileName);
        editorRef.current?.removeImageAttachmentById(id);
      }
      scheduleLandingImageReconcile();
      return;
    }
    const prepared = preparation.image;
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
    const storing = putImage(prepared.bytes);
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
      // The PREPARED length, which is what `putImage` just stored and what the
      // node's `size` will report back to the budget's steady-state accounting
      // - charging the source length would bill capacity nothing holds.
      postStoreReservation = reserveLandingImageBudget(draftId, [
        { hash, bytes: prepared.byteLength },
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
    if (
      !handle.rewriteImageAttachmentHashById(id, {
        hash,
        fileName: prepared.fileName,
        mimeType: prepared.mimeType,
        size: prepared.byteLength > 0 ? prepared.byteLength : null,
        byHashEligible: prepared.byHashEligible,
      })
    ) {
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
    signal.removeEventListener("abort", releaseCallerReservation);
    postStoreReservation?.release();
    releaseCallerReservation();
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
  /**
   * Node ids this MOUNT has started a job for. The guard that makes re-ingest
   * safe to call on every content change.
   *
   * Recorded at job START, synchronously and before any await, because two
   * content changes in one tick would otherwise both see the node unstarted.
   * Never cleared while the mount lives, and never consulted across mounts:
   * that scoping is deliberate, because upstream's budget-refusal branch
   * leaves the node inline on the stated grounds that a full budget is
   * recoverable and "every mount retries". A mount-scoped guard keeps exactly
   * that - retried on the next mount, never on the next keystroke.
   *
   * A hash-only node is not keyed at all; it is skipped by the `b64content`
   * filter, which is the same reason a node whose job settled never returns.
   */
  const startedNodeIdsRef = useRef<Set<string>>(new Set());
  // One session per MOUNT, not per job: `prepare` calls on a session are
  // serialized, and these jobs are launched synchronously one per image and
  // never await each other, so the session is the only thing that can order
  // them. Deliberately not process-wide - neither `createImageBitmap` nor
  // `toBlob` takes a timeout, so a wedged decode would otherwise block image
  // paste in every composer in the window instead of the one it wedged.
  const preparationSession = useMemo(
    () => createComposerImagePreparationSession(),
    [],
  );

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
          preparationSession,
        }),
      );
    },
    [draftId, editorRef, preparationSession, runPendingImageJob],
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
        fileName: image.fileName,
        mimeType: image.mimeType,
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
        //
        // Recorded all the same, so the on-change scan does not re-decode it
        // on every keystroke only to skip it again at the format check.
        if (!plan.storable) {
          const inlineId = uuidv4();
          startedNodeIdsRef.current.add(inlineId);
          return { kind: "accepted", id: inlineId };
        }
        const reservation = reservationByIndex.get(index);
        if (reservation === undefined) return { kind: "rejected" };
        const id = uuidv4();
        // Recorded BEFORE the node reaches the document. A paste and an
        // on-change scan can land in the same tick, and the node is inline
        // b64 from insertion until the rewrite settles - so without this the
        // scan would see an unstarted node and run a SECOND job for the image
        // that was just pasted.
        startedNodeIdsRef.current.add(id);
        startPendingImageIngest(id, plan.bytes, {
          onSettled: () => reservation.release(),
          reserveAfterStore: false,
          fileName: plan.fileName,
          mimeType: plan.mimeType,
        });
        return { kind: "accepted", id };
      });
      if (corruptedCount > 0) showPastedImageToast(corruptedCount);
      return outcomes;
    },
    [draftId, startPendingImageIngest],
  );

  const noteContentImages = useCallback(
    (content: JsonContent) => {
      const handle = editorRef.current;
      if (handle === null || !handle.isReady()) return;
      const started = startedNodeIdsRef.current;
      const pending = collectImageAtoms(content).filter(
        (atom): atom is ComposerImageAtom & { readonly b64content: string } =>
          atom.b64content !== null && !started.has(atom.id),
      );
      if (pending.length === 0) return;
      let corruptedCount = 0;
      for (const atom of pending) {
        // Before the decode, not after: a node recorded here is one this mount
        // will not look at again, which is what keeps a per-keystroke caller
        // from re-running a base64 decode (let alone a prepare) on every node
        // in the document for every character typed.
        started.add(atom.id);
        const bytes = decodeValidatedPastedImage({
          fileName: atom.fileName,
          mimeType: atom.mimeType,
          b64content: atom.b64content,
        });
        if (bytes === null) {
          // Only reachable from a corrupted or hand-edited restore: it can
          // never be ingested, so drop it rather than leave a node nothing can
          // resolve.
          handle.removeImageAttachmentById(atom.id);
          corruptedCount += 1;
          continue;
        }
        // Left inline on purpose by the file ingest, so leave it inline here
        // too. This runs on EVERY editor mount, so without the guard a BMP the
        // paste path kept inline would be silently hashed the next time the
        // composer opened - the format decision undone one mount later.
        if (!isHostStorableImageMimeType(atom.mimeType)) continue;
        startPendingImageIngest(atom.id, bytes, {
          onSettled: undefined,
          reserveAfterStore: true,
          fileName: atom.fileName,
          mimeType: atom.mimeType,
        });
      }
      if (corruptedCount > 0) showPastedImageToast(corruptedCount);
    },
    [editorRef, startPendingImageIngest],
  );

  /**
   * Mount-time restart. Reads the document itself and goes through the same
   * guard, so the on-ready call and an on-change call that arrive together
   * cannot both start a job for the same node.
   */
  const reingestPendingImages = useCallback(() => {
    const handle = editorRef.current;
    if (handle === null || !handle.isReady()) return;
    noteContentImages(handle.getJSON());
  }, [editorRef, noteContentImages]);

  return {
    ingestPastedComposerImages,
    reingestPendingImages,
    noteContentImages,
  };
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
