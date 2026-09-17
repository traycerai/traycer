// Imported from its own module rather than through `@/lib/utils`'s re-export:
// this file is value-reachable from the epic runtime WORKER entry, and the
// re-export would drag the class merger and its compiled tables in behind one
// string helper - which is the coupling `lib/text/format-single-line.ts` was
// split out to avoid, and which `worker-graph-singletons.test.ts` fails on.
import { formatSingleLine } from "@/lib/text/format-single-line";

/**
 * Derive an epic name from a user prompt: a single-line, ellipsis-truncated
 * slice of the prompt. Returns the empty string when the prompt has no
 * non-whitespace characters; the caller (display helper or create path) owns
 * the "Untitled task" fallback.
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
