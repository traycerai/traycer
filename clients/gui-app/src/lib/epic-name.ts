import { formatSingleLine } from "@/lib/utils";

/**
 * Derive an epic name from a user prompt: a single-line, ellipsis-truncated
 * slice of the prompt. Returns the empty string when the prompt has no
 * non-whitespace characters; the caller (display helper or create path) owns
 * the "Untitled epic" fallback.
 *
 * Lives in a neutral lib module (rather than the epic-canvas store) so the
 * render-layer `display-title.ts` can reuse it without importing the store -
 * which would create an import cycle.
 */
export function createEpicName(prompt: string): string {
  return formatSingleLine(prompt, {
    maxLength: 72,
    ellipsis: "...",
  });
}
