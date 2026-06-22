import type { ReactNode } from "react";
import type { HighlightRanges } from "@/lib/git/path-highlight";

export interface HighlightedTextProps {
  readonly text: string;
  /** Inclusive `[start, end]` ranges into `text` to emphasize. */
  readonly ranges: HighlightRanges;
}

// Subtle filled highlight so matched characters read as hits in both the
// foreground filename span and the muted directory span.
const MATCH_CLASS_NAME = "rounded-[2px] bg-primary/25 text-foreground";

/**
 * Renders `text` with the given ranges wrapped in highlight `<mark>`s. Empty
 * ranges render the plain string, so callers can always use this component
 * regardless of whether a filter is active.
 */
export function HighlightedText(props: HighlightedTextProps): ReactNode {
  const { text, ranges } = props;
  if (ranges.length === 0) return text;

  const ordered = [...ranges].sort((left, right) => left[0] - right[0]);
  const segments: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ordered) {
    // Clamp and skip ranges that overlap an already-emitted segment so
    // out-of-order or overlapping match indices never duplicate characters.
    const safeStart = Math.max(start, cursor);
    const safeEnd = Math.min(end, text.length - 1);
    if (safeEnd < safeStart) continue;
    if (safeStart > cursor) {
      segments.push(text.slice(cursor, safeStart));
    }
    // Key by text position: marks never overlap after clamping, so the start
    // offset is unique and stable across renders.
    segments.push(
      <mark key={`m${safeStart}`} className={MATCH_CLASS_NAME}>
        {text.slice(safeStart, safeEnd + 1)}
      </mark>,
    );
    cursor = safeEnd + 1;
  }
  if (cursor < text.length) {
    segments.push(text.slice(cursor));
  }
  return segments;
}
