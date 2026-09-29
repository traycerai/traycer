import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one line every bar reading is drawn on: the strip's reading tiles (F6)
 * and the header's readings (G6), usage and resources alike.
 *
 * One row tall, and every reading keeps its whole width, so one that does not
 * fit beside the others wraps onto a clipped second row: the line shows whole
 * readings only, the first at half width and more as it widens, and the rest
 * are in the popover the button opens. Wrapping cannot decide the one case
 * left - a first reading wider than the whole line stays on the first row,
 * cut - so that case is measured: when no reading fits whole, the line hides
 * its readings and draws `fallback` in their place. The readings stay laid
 * out while hidden, so the measurement does not change with its own answer.
 *
 * `lead` rides at the head of the line (the resource chip) and is not a
 * reading: a line holding only its lead has nothing to read.
 */
export function ReadingsLine(props: {
  readonly align: "start" | "center";
  /** The resource line reads muted, as its status bar segment does. */
  readonly tone: "default" | "muted";
  readonly lead: ReactNode;
  readonly fallback: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const { align, tone, lead, fallback, children } = props;
  const lineRef = useRef<HTMLSpanElement | null>(null);
  const [fits, setFits] = useState(true);
  // Every commit, because the readings are the caller's children and any of
  // them can change width; the observer covers the line resizing between.
  useLayoutEffect(() => {
    const line = lineRef.current;
    if (line === null) return undefined;
    const measure = (): void => {
      setFits(anyReadingFits(line));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(line);
    for (const child of line.children) observer.observe(child);
    return () => {
      observer.disconnect();
    };
  });
  const justify = align === "center" ? "justify-center" : "justify-start";
  return (
    <span aria-hidden className="relative flex min-w-0 flex-1">
      <span
        ref={lineRef}
        className={cn(
          "flex h-4 min-w-0 flex-1 flex-wrap items-center gap-x-2 overflow-hidden text-ui-xs *:shrink-0",
          justify,
          tone === "muted" && "text-muted-foreground",
          !fits && "invisible",
        )}
      >
        {lead === null ? null : (
          <span data-readings-lead className="inline-flex text-foreground">
            {lead}
          </span>
        )}
        {children}
      </span>
      {/* Centred whatever the line's alignment: a fallback is one glyph in
          whatever box the readings were given. */}
      {fits ? null : (
        <span
          data-readings-fallback
          className="absolute inset-0 flex min-w-0 items-center justify-center gap-1 text-ui-xs"
        >
          {fallback}
        </span>
      )}
    </span>
  );
}

/** Whether any reading on the line sits whole inside its one row. */
function anyReadingFits(line: HTMLElement): boolean {
  const box = line.getBoundingClientRect();
  for (const child of line.children) {
    if (
      !(child instanceof HTMLElement) ||
      child.dataset.readingsLead !== undefined
    )
      continue;
    const r = child.getBoundingClientRect();
    if (
      r.left >= box.left - 0.5 &&
      r.right <= box.right + 0.5 &&
      r.top >= box.top - 0.5 &&
      r.bottom <= box.bottom + 0.5
    )
      return true;
  }
  return false;
}
