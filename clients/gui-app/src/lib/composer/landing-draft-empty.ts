import type { JsonContent } from "@traycer/protocol/common/registry";
import { containsFileAttachments } from "@/lib/composer/file-attachments";
import { containsImageAtoms } from "@/lib/composer/image-atoms";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";

/**
 * A draft is still a blank Start Page only while it has no typed text and no
 * attached image or file. Attachment-only drafts are real drafts even though
 * their tab title falls back to "Start Page".
 */
export function isEmptyLandingDraftContent(content: JsonContent): boolean {
  return (
    extractPlainTextFromComposerJSONContent(content).trim().length === 0 &&
    !containsImageAtoms(content) &&
    !containsFileAttachments(content)
  );
}
