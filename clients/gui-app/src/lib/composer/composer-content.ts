import type { JsonContent } from "@traycer/protocol/common/registry";

import { containsImageAtoms } from "@/lib/composer/image-atoms";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";

/**
 * Whether composer content can be sent: any non-whitespace text, or at least
 * one image atom. Shared by every composer surface (landing, New Conversation
 * modal, …) so the "is this submittable" rule stays in lockstep.
 */
export function contentIsSubmittable(content: JsonContent): boolean {
  if (extractPlainTextFromComposerJSONContent(content).trim().length > 0) {
    return true;
  }
  return containsImageAtoms(content);
}
