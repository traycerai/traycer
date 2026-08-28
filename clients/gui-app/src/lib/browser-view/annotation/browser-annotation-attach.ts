import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import type { BrowserAnnotationAttachPayload } from "@traycer-clients/shared/platform/browser-annotation";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import { putImage } from "@/lib/composer/landing-image-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

type AttachBrowserAnnotationResult =
  | { readonly status: "attached" }
  | { readonly status: "store-failed" };

/**
 * Store crop bytes in the existing hash-backed composer image store, mint the
 * record (hash + filename only), and append it to the target chat's draft.
 * A card is never created without its crop.
 */
export async function attachBrowserAnnotation(input: {
  readonly chatId: string;
  readonly payload: BrowserAnnotationAttachPayload;
  readonly png: ImageBytes;
}): Promise<AttachBrowserAnnotationResult> {
  let imageHash: string;
  try {
    imageHash = await putImage(input.png);
  } catch {
    return { status: "store-failed" };
  }
  const record: BrowserAnnotationRecord = {
    kind: "browser-annotation",
    ...input.payload,
    imageFileName: `browser-annotation-${input.payload.annotationId}.png`,
    imageHash,
  };
  useComposerDraftStore.getState().addBrowserAnnotation(input.chatId, record);
  return { status: "attached" };
}
