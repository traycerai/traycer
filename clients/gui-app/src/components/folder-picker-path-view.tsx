import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
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
        className="font-semibold text-primary underline decoration-primary/40 underline-offset-2"
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
 * A path that loses its FRONT when it will not fit, never its end: the leaf
 * is the identity of the row and the prefix is the noise, so the end is what
 * has to survive.
 *
 * CSS truncation always eats the end of the line, so the line is laid out
 * right-to-left — which moves the overflow, and the ellipsis with it, to the
 * start — while the text inside is isolated back to left-to-right so the path
 * itself still reads normally. Doing it in CSS rather than by counting
 * characters means the cut lands exactly at the available width, at whatever
 * size the row happens to be.
 */
export function TailAnchoredPath(props: {
  readonly path: string;
  readonly className: string | undefined;
}): ReactNode {
  return (
    <span dir="rtl" className={cn("block truncate text-left", props.className)}>
      <bdi dir="ltr">{props.path}</bdi>
    </span>
  );
}

/**
 * Long-press recognizer for a row whose tap already means something else.
 *
 * Cancels on movement (the press was the start of a scroll) and on release
 * before the threshold, and reports whether it fired so the row's click
 * handler can stand down — otherwise revealing the path would also pick the
 * folder.
 */
export function useLongPress(onLongPress: () => void): {
  readonly handlers: {
    readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    readonly onPointerUp: () => void;
    readonly onPointerCancel: () => void;
  };
  readonly consumeFired: () => boolean;
} {
  const timerRef = useRef<number | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const clear = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    originRef.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  return {
    handlers: {
      onPointerDown: (event) => {
        firedRef.current = false;
        originRef.current = { x: event.clientX, y: event.clientY };
        timerRef.current = window.setTimeout(() => {
          firedRef.current = true;
          timerRef.current = null;
          onLongPress();
        }, 450);
      },
      onPointerMove: (event) => {
        const origin = originRef.current;
        if (origin === null) return;
        const moved =
          Math.abs(event.clientX - origin.x) > 10 ||
          Math.abs(event.clientY - origin.y) > 10;
        if (moved) clear();
      },
      onPointerUp: clear,
      onPointerCancel: clear,
    },
    // Read once per click: a press that fired suppresses exactly the click it
    // produced, and the next tap starts clean.
    consumeFired: () => {
      const fired = firedRef.current;
      firedRef.current = false;
      return fired;
    },
  };
}

/**
 * The escape hatch for every abbreviation above: the untouched absolute path,
 * selectable, one long-press away. Abbreviating is safe precisely because
 * this exists.
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
