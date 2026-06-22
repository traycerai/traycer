/**
 * Pin icon shown next to a palette row's title. Hidden via
 * `display: none` when the row is not pinned, not hovered, and not
 * cmdk-selected so it reserves zero layout width - `opacity-0`
 * would still leave a ~24px gap between the title and the trailing
 * shortcut.
 *
 * Keyboard users reach pin via cmdk's arrow-key selection, which
 * sets `data-selected` on the row; that's the second reveal
 * trigger below.
 *
 * The host row passes `pinned` + `onToggle`; host reads
 * `command-palette-store` and calls `togglePin`.
 */
import { Pin, PinOff } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PinToggleProps {
  readonly itemId: string;
  readonly pinned: boolean;
  readonly onToggle: () => void;
}

export function PinToggle(props: PinToggleProps) {
  const { itemId, pinned, onToggle } = props;
  return (
    <button
      type="button"
      aria-pressed={pinned}
      aria-label={pinned ? "Unpin command" : "Pin command"}
      data-testid={`command-palette-pin-${itemId}`}
      onPointerDown={(event) => {
        // cmdk intercepts clicks on rows to fire `onSelect`; run
        // the toggle on pointerdown before that handler + stop
        // propagation so pin actions don't also dispatch the
        // command.
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        "size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground group-data-selected/command-item:text-primary",
        pinned
          ? "inline-flex text-foreground"
          : "hidden group-hover/command-item:inline-flex group-data-selected/command-item:inline-flex",
      )}
    >
      {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
    </button>
  );
}
