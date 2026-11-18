import type { ReactNode } from "react";
import { RollingNumber } from "@/components/ui/rolling-number";
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
  /**
   * Whether the two numbers ROLL their digits when they change.
   *
   * A per-call decision rather than a property of the component, because the
   * same two numbers are a summary in one place and a list in another. The
   * chip and the panel HEADER carry totals that move several times per turn
   * while nothing else on the row does, which is exactly what a roll is for.
   * A per-file ROW does not: a turn touching twelve files would roll twelve
   * rows at once, which is the same failure this repo already recorded and
   * fixed for the chip's pulse, so those pass `false` and print plain text.
   *
   * The `+` and the `−` are static text either way. They must not roll, and
   * the `−` is U+2212 MINUS SIGN rather than a hyphen.
   */
  readonly rolling: boolean;
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
        <span data-diff-additions className="text-success-foreground">
          +
          {props.rolling ? (
            <RollingNumber
              value={additions}
              className={undefined}
              testId={undefined}
            />
          ) : (
            additions
          )}
        </span>
      ) : null}
      {deletions > 0 ? (
        <span data-diff-deletions className="text-destructive">
          −
          {props.rolling ? (
            <RollingNumber
              value={deletions}
              className={undefined}
              testId={undefined}
            />
          ) : (
            deletions
          )}
        </span>
      ) : null}
    </span>
  );
}
