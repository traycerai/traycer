import type { ReactNode } from "react";
import { splitForMiddleTruncation } from "@/lib/middle-truncation";
import { cn } from "@/lib/utils";

/**
 * One line of text that, squeezed, loses its MIDDLE: the end stays readable,
 * which is where file names and paths differ (`Q3-report…v12-final.pdf`). The
 * caller supplies the way to read it whole (a tooltip).
 */
export function MiddleTruncatedText(props: {
  readonly text: string;
  /** How many trailing characters never truncate. */
  readonly tailLength: number;
  readonly className: string | undefined;
}): ReactNode {
  // One line: `whitespace-pre` keeps the space at the split, so a line break
  // in agent-authored text must not reach it.
  const { head, tail } = splitForMiddleTruncation(
    props.text.replace(/\s+/gu, " "),
    props.tailLength,
  );
  return (
    // `auto`: a name in a right-to-left script reads from its own start.
    <span dir="auto" className={cn("flex min-w-0", props.className)}>
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-pre">
        {head}
      </span>
      <span className="shrink-0 whitespace-pre">{tail}</span>
    </span>
  );
}
