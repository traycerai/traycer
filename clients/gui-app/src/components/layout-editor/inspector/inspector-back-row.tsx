import { useEffect, useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

interface InspectorBackRowProps {
  /** "All regions" from a section, the parent's name from a deeper level (L-89). */
  readonly label: string;
  readonly onBack: () => void;
}

/**
 * The way back out of every level below the index (L-89): `.backrow` in the
 * prototype, drawn above whatever the level renders.
 *
 * One shared element rather than a row each level draws for itself, which is
 * how the section level came to have none at all: the provider level asked for
 * a breadcrumb and got one, and the level that did not ask was silently a dead
 * end (I-01).
 *
 * It takes focus as it mounts, which is the other half of that fix. Selecting
 * a region unmounts the index row the keyboard was on, so without this the
 * first key press after opening a section went to `<body>`.
 */
export function InspectorBackRow(props: InspectorBackRowProps): ReactNode {
  const ref = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // `preventScroll`: the row is already at the top of the level it belongs
    // to, and a scroll container that jumps as a level opens reads as the
    // panel moving under the pointer.
    ref.current?.focus({ preventScroll: true });
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      data-layout-inspector-back
      className="flex w-full items-center gap-1.5 border-b border-border px-3.5 py-2.5 text-left text-ui-sm text-muted-foreground transition-colors duration-120 hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
      onClick={props.onBack}
    >
      <ChevronRight aria-hidden className="size-3.5 rotate-180" />
      <span className="min-w-0 truncate">{props.label}</span>
    </button>
  );
}
