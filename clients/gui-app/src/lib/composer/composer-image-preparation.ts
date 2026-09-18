/**
 * The composer's side of image preparation: the universal policy applied to
 * bytes a surface already holds, plus the one refusal message.
 *
 * Every composer surface goes through here — the shared paste core, the
 * landing composer's structured paste, and browser annotation crops — so the
 * bytes each one stores or sends have been through the same policy. The
 * preparer itself lives in `prompt-stash-image-preparation.ts`; this module
 * adds only what a composer needs on top of it: what to do when preparation
 * cannot run at all, and what to say when an image genuinely cannot fit.
 */
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import {
  createImagePreparationSession,
  PREPARED_IMAGE_MAX_BYTES,
  PREPARED_IMAGE_POLICY,
  type ImagePreparationSession,
} from "@/lib/composer/prompt-stash-image-preparation";
import type { ImageBytes } from "@/lib/attachments/image-bytes";

export type { ImagePreparationSession };

/**
 * One composer surface's preparation session: the WebP probe runs once per
 * session, and `prepare` calls on it are SERIALIZED — a second call does not
 * begin until the first has settled, so one decoded bitmap is alive at a time.
 *
 * The queue belongs here rather than at each call site because not every
 * caller is a loop that can await: the landing composer's structured paste
 * launches one independent background job per pending image node, and those
 * jobs all start in the same tick (on a paste, and again on a remount that
 * re-ingests a draft's pending nodes). Awaiting inside each job serializes
 * nothing, since the jobs do not await each other.
 *
 * It belongs to the SESSION rather than to the module for blast radius: a
 * preparation is not time-bounded (neither `createImageBitmap` nor `toBlob`
 * takes a timeout), so a process-wide queue would let one wedged decode block
 * image paste in every composer in the window. A session is owned by a
 * composer mount, which keeps a wedged decode confined to the surface whose
 * decode wedged.
 */
export function createComposerImagePreparationSession(): ImagePreparationSession {
  const session = createImagePreparationSession({
    policy: PREPARED_IMAGE_POLICY,
    codec: undefined,
  });
  let tail: Promise<void> = Promise.resolve();
  return {
    prepare: (args) => {
      const run = tail.then(() => session.prepare(args));
      // The tail tracks only SETTLEMENT: one caller's refusal or codec failure
      // must release the queue, never reject the next caller's turn. Each
      // caller still receives its own result from `run`.
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

export interface PreparedComposerImage {
  readonly bytes: ImageBytes;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteLength: number;
  /**
   * Whether these bytes may travel to the host BY HASH rather than inline.
   *
   * This is a FACT decided here, where preparation decides, not a rule a submit
   * site re-derives. The host's staging seam only models the four canonical
   * raster formats (PNG/JPEG/GIF/WebP) and refuses everything else, and the one
   * thing a submit site could key on - the node's `mimeType` - cannot answer the
   * question: the unmodelable fallback below keeps the SOURCE's declared type,
   * so a file announced as `image/png` whose bytes are actually AVIF would read
   * as eligible and be refused on the host after the reference was already
   * written. So: `true` exactly when the preparer produced the bytes (its output
   * MIME is one of the four by construction, and it sniffed the payload to get
   * there), `false` for the source-bytes fallback.
   *
   * An ineligible image is not a broken one - it attaches and sends exactly as
   * it does today, inline. This only says which of the two channels it may use.
   */
  readonly byHashEligible: boolean;
}

export type ComposerImagePreparation =
  | { readonly kind: "prepared"; readonly image: PreparedComposerImage }
  | { readonly kind: "refused" };

/**
 * Prepares one image under the universal policy without deciding how a refusal
 * is reported — the caller owns that, because the surfaces differ (a paste
 * toasts per image, an annotation crop reports through its own attach result).
 *
 * Preparation failing is not the same as the image being unusable: a format
 * this preparer does not model (AVIF, HEIC, BMP, SVG), bytes that disagree
 * with their declared type, or a codec that will not encode all land in the
 * catch, and every one of them attaches fine today. So a failure falls back to
 * the source bytes whenever they are already under the OUTPUT ceiling — the
 * only limit that is hard downstream — and refuses only when they are not.
 * Nothing that fits is ever dropped, and nothing over the ceiling is ever sent.
 *
 * That fallback is also the ONLY producer of `byHashEligible: false`, which is
 * what makes the flag decidable here and nowhere else: the preparer's success
 * path sniffed the payload and re-encoded (or passed through) one of the four
 * canonical raster formats, while the fallback carries bytes nothing has
 * classified under a MIME string the caller merely declared.
 */
export async function prepareComposerImageBytesOrRefuse(
  session: ImagePreparationSession,
  bytes: ImageBytes,
  fileName: string,
  mimeType: string,
): Promise<ComposerImagePreparation> {
  try {
    const prepared = await session.prepare({
      bytes,
      fileName,
      declaredMimeType: mimeType,
    });
    return {
      kind: "prepared",
      image: {
        bytes: prepared.bytes,
        fileName: prepared.fileName,
        mimeType: prepared.mimeType,
        byteLength: prepared.byteLength,
        // `PreparedImage.mimeType` is a `CanonicalImageMimeType`, so every
        // success here is one of the four formats the host models - the
        // eligibility list and the preparer's output alphabet are the same set,
        // by type, not by a literal repeated on both sides.
        byHashEligible: true,
      },
    };
  } catch {
    if (bytes.byteLength <= PREPARED_IMAGE_MAX_BYTES) {
      return {
        kind: "prepared",
        image: {
          bytes,
          fileName,
          mimeType,
          byteLength: bytes.byteLength,
          byHashEligible: false,
        },
      };
    }
    return { kind: "refused" };
  }
}

/** The single refusal copy for "this image cannot be made to fit". */
export function showImageTooLargeToast(fileName: string): void {
  reportableErrorToast(
    "Image too large even after resizing.",
    {
      description: fileName.length > 0 ? fileName : "Image",
    },
    {
      title: "Image exceeded the size limit",
      message: null,
      code: null,
      source: "Chat composer",
    },
  );
}
