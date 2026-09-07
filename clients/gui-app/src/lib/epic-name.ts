import { formatSingleLine } from "@/lib/utils";

/**
 * Derive an epic name from a user prompt: a single-line, ellipsis-truncated slice of the prompt.
 * Returns the empty string when the prompt has no non-whitespace characters; the caller (display helper or create path) owns the "Untitled task" fallback.
 */
export function createEpicName(prompt: string): string {
  return formatSingleLine(prompt, {
    maxLength: 72,
    ellipsis: "...",
  });
}
