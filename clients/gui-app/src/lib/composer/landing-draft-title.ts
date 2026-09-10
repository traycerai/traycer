import type { JsonContent } from "@traycer/protocol/common/registry";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";

/** Tab strip and history list share this fallback for image-only / empty text. */
export const LANDING_DRAFT_TITLE_FALLBACK = "Start Page";

/**
 * Derived start-task draft label: first non-empty line of typed content, else
 * the Start Page fallback. Image-only drafts have no derived text.
 */
export function landingDraftDisplayTitle(content: JsonContent): string {
  const text = extractPlainTextFromComposerJSONContent(content).trim();
  if (text.length === 0) return LANDING_DRAFT_TITLE_FALLBACK;
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 0 ? firstLine : LANDING_DRAFT_TITLE_FALLBACK;
}
