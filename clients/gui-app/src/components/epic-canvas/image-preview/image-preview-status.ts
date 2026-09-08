import type { FileBytesState } from "@/lib/files/byte-source";
import type { ImagePreviewStatus } from "./image-preview";

/**
 * The byte core has ONE `loading` arm; this viewer distinguishes two, and the
 * difference is visible - `loading` paints a spinner, `header` an
 * aspect-ratio skeleton. A `loading` state that already carries a header IS
 * the asset stream's header phase, so that is what decides. Every settled
 * failure is the CALLER's branch (`ImagePreviewStatus`'s own doc), never a
 * status here.
 */
export function imagePreviewStatusOf(
  bytes: FileBytesState,
): ImagePreviewStatus {
  if (bytes.status === "ready") return "ready";
  return bytes.header === null ? "loading" : "header";
}
