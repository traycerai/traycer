/**
 * The background job that turns ONE pending base64 image node — already in the
 * document, carrying its `id` — into a hash-only node: prepare the bytes, hash
 * and store THOSE, then flip the node's payload in place.
 *
 * The pending node IS the work token. That is what makes the model survive a
 * remount, a navigate-away-and-back and a mid-ingest unmount: whichever editor
 * instance owns the node restarts its ingest, `putImage` is content-addressed
 * and single-flight, and the rewrite is keyed by node id — so re-ingesting a
 * node an aborted prior job already stored just re-roots the same hash.
 *
 * Every branch that ends without a rewrite schedules the orphan sweep, because
 * bytes that reached the store with no node to root them are exactly what the
 * reconcile exists to reclaim.
 */
import type { ImageAttachmentRewrite } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import {
  prepareComposerImageBytesOrRefuse,
  type ImagePreparationSession,
} from "@/lib/composer/composer-image-preparation";
import { putImage } from "@/lib/composer/composer-image-store";
import {
  reserveLandingImageBudget,
  type LandingImageBudgetReservation,
} from "@/lib/composer/landing-image-budget";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

/** The slice of a composer editor handle this job drives. */
export interface PendingImageIngestEditor {
  readonly isReady: () => boolean;
  readonly removeImageAttachmentById: (id: string) => void;
  readonly rewriteImageAttachmentHashById: (
    id: string,
    rewrite: ImageAttachmentRewrite,
  ) => boolean;
}

export interface PendingImageIngestOptions {
  readonly fileName: string;
  readonly mimeType: string;
  /**
   * Releases a reservation the CALLER already holds for these bytes, called
   * exactly once: after every other branch below, or — on ABORT — the moment
   * the signal fires, whichever comes first. `undefined` when the caller holds
   * none (the remount re-entry, which reserves after the store instead).
   */
  readonly onSettled: (() => void) | undefined;
  /**
   * Reserve budget AFTER `putImage` has settled, against the now-known hash and
   * the measured prepared length. The remount re-entry takes this path: its
   * predecessor's ANONYMOUS charge cannot dedupe against a hash-keyed one, so
   * re-reserving by hash is what keeps the successor admissible near the cap.
   */
  readonly reserveAfterStore: boolean;
}

export interface PendingImageIngestArgs {
  readonly id: string;
  readonly bytes: ImageBytes;
  readonly signal: AbortSignal;
  readonly session: ImagePreparationSession;
  /**
   * Whose budget this charges against, for the refusal copy only — a landing
   * draft id, a chat id, or `null` for a surface with no row of its own. The
   * byte budget itself is per-window, not per-owner.
   */
  readonly budgetOwnerId: string | null;
  /** Read live: the editor may be replaced or torn down while this runs. */
  readonly editor: () => PendingImageIngestEditor | null;
  /**
   * How a preparation REFUSAL becomes visible to the user — an image over the
   * output ceiling that the preparer could not shrink far enough.
   *
   * Explicit, with no default, because it is the one thing a surface adopting
   * this job genuinely has to decide: the refusal is the only outcome a user
   * must be told about, and a surface that silently passed `undefined` here
   * would drop the pending node with no explanation at all. Today both callers
   * pass `showImageTooLargeToast`, and that agreement is the point — it is
   * asserted by each surface's own tests rather than assumed by this module.
   */
  readonly showRefusal: (fileName: string) => void;
  readonly options: PendingImageIngestOptions;
}

export async function runPendingImageIngest(
  args: PendingImageIngestArgs,
): Promise<void> {
  const { id, bytes, signal, session, editor, options } = args;
  let postStoreReservation: LandingImageBudgetReservation | null = null;
  let callerReservationReleased = false;
  const releaseCallerReservation = (): void => {
    if (callerReservationReleased) return;
    callerReservationReleased = true;
    options.onSettled?.();
  };
  // The abort release is what keeps a successor mount admissible. An aborted
  // job can no longer commit — every branch below returns without rewriting
  // once `signal.aborted` — so it would otherwise hold an ANONYMOUS charge for
  // bytes it will never root, and anonymous bytes cannot dedupe against the
  // successor's hash-keyed charge the way two hash-keyed reservations do. Near
  // the cap that is the difference between the remount re-rooting the image and
  // being refused, which removes a node the user already had.
  signal.addEventListener("abort", releaseCallerReservation, { once: true });
  try {
    const preparation = await prepareComposerImageBytesOrRefuse(
      session,
      bytes,
      options.fileName,
      options.mimeType,
    );
    if (preparation.kind === "refused") {
      // Over the output ceiling and not resizable. Toast once here (the shared
      // refusal copy) and drop the pending node. This job stored nothing, but
      // an earlier aborted attempt on the same node may have, so the sweep
      // still runs.
      if (!signal.aborted) {
        args.showRefusal(options.fileName);
        editor()?.removeImageAttachmentById(id);
      }
      scheduleLandingImageReconcile();
      return;
    }
    const prepared = preparation.image;
    const hash = await putImage(prepared.bytes);
    const handle = editor();
    if (signal.aborted || handle === null || !handle.isReady()) {
      // Editor unmounted mid-ingest: the pending node is gone from THIS mount,
      // so reclaim the just-stored bytes on the next sweep. (If a remount kept
      // the b64 node, its own re-entry re-ingests and re-roots this hash before
      // the debounced sweep runs.)
      scheduleLandingImageReconcile();
      return;
    }
    if (options.reserveAfterStore) {
      postStoreReservation = reserveLandingImageBudget(args.budgetOwnerId, [
        { hash, bytes: prepared.byteLength },
      ]);
      if (postStoreReservation === null) {
        handle.removeImageAttachmentById(id);
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
      // The pending node was removed (the user deleted it before the write
      // settled), so the just-stored bytes are unrooted — reclaim them.
      scheduleLandingImageReconcile();
    }
  } catch {
    if (signal.aborted) {
      // The editor unmounted mid-ingest; a successor mount (if any) re-ingests
      // this node. Don't toast for a surface the user already left (matching
      // the shared file-paste path's abort handling) — just reclaim the bytes.
      scheduleLandingImageReconcile();
      return;
    }
    // Hashing / IndexedDB write failed: drop the pending node and reclaim.
    editor()?.removeImageAttachmentById(id);
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
