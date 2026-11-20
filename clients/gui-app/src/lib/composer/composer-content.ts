import type { JsonContent } from "@traycer/protocol/common/registry";

import { containsFileAttachments } from "@/lib/composer/file-attachments";
import { containsImageAtoms } from "@/lib/composer/image-atoms";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";

/**
 * Whether composer content can be sent: any non-whitespace text, or at least
 * one image or file atom. Shared by every composer surface (landing, New
 * Conversation modal, …) so the "is this submittable" rule stays in lockstep.
 * A file still uploading is content all the same; the composer's pending gate
 * is what holds it back.
 */
export function contentIsSubmittable(content: JsonContent): boolean {
  if (extractPlainTextFromComposerJSONContent(content).trim().length > 0) {
    return true;
  }
  return containsImageAtoms(content) || containsFileAttachments(content);
}
