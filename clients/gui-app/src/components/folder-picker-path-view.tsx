import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { FuzzyRange } from "@/lib/fuzzy-folder-match";

/**
 * A folder name with the matched characters of the active filter marked.
 *
 * Highlight is a weight and colour change, never a background chip: rows are
 * already selectable, and a second filled rectangle inside a selected row
 * reads as a second selection.
 */
export function HighlightedName(props: {
  readonly name: string;
  readonly ranges: ReadonlyArray<FuzzyRange>;
  readonly className: string | undefined;
}): ReactNode {
  if (props.ranges.length === 0) {
    return <span className={props.className}>{props.name}</span>;
  }
  const pieces: ReactNode[] = [];
  let cursor = 0;
  props.ranges.forEach((range, index) => {
    if (range.start > cursor) {
      pieces.push(
        <span key={`gap-${String(index)}`}>
          {props.name.slice(cursor, range.start)}
        </span>,
      );
    }
    pieces.push(
      <span
        key={`hit-${String(index)}`}
        data-testid="folder-picker-name-hit"
        className="font-semibold text-primary underline decoration-primary/40 underline-offset-2 group-aria-selected/button:text-foreground group-aria-selected/button:decoration-current/40"
      >
        {props.name.slice(range.start, range.end)}
      </span>,
    );
    cursor = range.end;
  });
  if (cursor < props.name.length) {
    pieces.push(<span key="tail">{props.name.slice(cursor)}</span>);
  }
  return <span className={props.className}>{pieces}</span>;
}

/**
 * The escape hatch for every abbreviation above, on touch: the untouched
 * absolute path, selectable, one long-press away. A pointer reaches the same
 * path through the rows' hover tooltip. Abbreviating is safe precisely
 * because both exist.
 */
export function FullPathSheet(props: {
  readonly path: string | null;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <Sheet
      open={props.path !== null}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <SheetContent side="bottom" className="gap-0 pb-safe-bottom">
        <SheetTitle className="px-4 pt-4 text-ui-sm">Full path</SheetTitle>
        <p className="px-4 pt-2 pb-4 font-mono text-ui-sm break-all select-all">
          {props.path}
        </p>
      </SheetContent>
    </Sheet>
  );
}
