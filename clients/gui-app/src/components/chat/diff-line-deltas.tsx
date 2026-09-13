import type { ReactNode } from "react";
import type { DiffLineCounts } from "@/lib/file-change-diff-hunks";
import { cn } from "@/lib/utils";

/**
 * `+12 −4`, in the one pair of tones this app gives added and removed lines.
 *
 * Shared rather than repeated because the same two numbers are now drawn in
 * three places that must agree on sight - the accumulated-changes header, each
 * of its rows, and the compact chip standing in for the whole panel while the
 * row is folded away. A chip whose green differs from the header's, or which
 * prints a `−0`, reads as a different measurement rather than the same one.
 *
 * A zero side is omitted, never printed: `+12` alone says "nothing was
 * removed" more plainly than `+12 −0` does, and the count beside it is what
 * carries the case where both are zero.
 */
export function DiffLineDeltas(props: {
  readonly counts: DiffLineCounts;
  /** Layout only - the wrapper's own spacing and type are fixed here. */
  readonly className: string | undefined;
}): ReactNode {
  const { additions, deletions } = props.counts;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 font-mono text-code-xs",
        props.className,
      )}
    >
      {additions > 0 ? (
        <span className="text-emerald-600 dark:text-emerald-400">
          +{additions}
        </span>
      ) : null}
      {deletions > 0 ? (
        <span className="text-destructive">−{deletions}</span>
      ) : null}
    </span>
  );
}
