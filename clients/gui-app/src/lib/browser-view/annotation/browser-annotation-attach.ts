import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import type { BrowserAnnotationAttachPayload } from "@traycer-clients/shared/platform/browser-annotation";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import {
  createComposerImagePreparationSession,
  prepareComposerImageBytesOrRefuse,
} from "@/lib/composer/composer-image-preparation";
import { putImage } from "@/lib/composer/composer-image-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

type AttachBrowserAnnotationResult =
  | { readonly status: "attached" }
  | { readonly status: "store-failed" };

/**
 * Prepare the crop under the composer's universal policy, store THOSE bytes in
 * the existing hash-backed composer image store, mint the record (hash +
 * filename only), and append it to the target chat's draft. A card is never
 * created without its crop.
 *
 * Preparation happens here rather than at submit because `imageHash` is the
 * crop's identity everywhere downstream: the attachment gallery keys off it,
 * and `omitImageAtomsByHash` uses it to stop a sent message rendering the crop
 * twice. Preparing after the record was minted would leave the record pointing
 * at bytes nobody sends. A retina full-page crop really can exceed 2000 px, so
 * this is not a theoretical pass-through — it is where the crop is made to fit.
 */
export async function attachBrowserAnnotation(input: {
  readonly chatId: string;
  readonly payload: BrowserAnnotationAttachPayload;
  readonly png: ImageBytes;
}): Promise<AttachBrowserAnnotationResult> {
  const session = createComposerImagePreparationSession();
  const prepared = await prepareComposerImageBytesOrRefuse(
    session,
    input.png,
    `browser-annotation-${input.payload.annotationId}.png`,
    "image/png",
  );
  // A crop that cannot be made to fit reports as a store failure: the caller
  // already surfaces exactly one toast for "the crop did not make it", and the
  // user's next move is the same either way.
  if (prepared.kind === "refused") return { status: "store-failed" };
  let imageHash: string;
  try {
    imageHash = await putImage(prepared.image.bytes);
  } catch {
    return { status: "store-failed" };
  }
  const record: BrowserAnnotationRecord = {
    kind: "browser-annotation",
    ...input.payload,
    imageFileName: prepared.image.fileName,
    imageHash,
  };
  useComposerDraftStore.getState().addBrowserAnnotation(input.chatId, record);
  return { status: "attached" };
}
