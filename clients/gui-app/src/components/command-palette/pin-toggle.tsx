/**
 * Pin icon shown next to a palette row's title. Hidden via
 * `display: none` when the row is not pinned, not hovered, and not
 * selected so it reserves zero layout width - `opacity-0`
 * would still leave a ~24px gap between the title and the trailing
 * shortcut.
 *
 * Keyboard users reach pin via the palette's arrow-key selection, which
 * sets `data-selected` on the row; that's the second reveal
 * trigger below.
 *
 * The host row passes `pinned` + `onToggle`; host reads
 * `command-palette-store` and calls `togglePin`.
 */
import { Pin, PinOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCommandContext } from "@/components/ui/command-context";

export interface PinToggleProps {
  readonly itemId: string;
  readonly pinned: boolean;
  readonly onToggle: () => void;
}

export function PinToggle(props: PinToggleProps) {
  const { itemId, pinned, onToggle } = props;
  const { highlight } = useCommandContext();
  return (
    <button
      type="button"
      aria-pressed={pinned}
      aria-label={pinned ? "Unpin command" : "Pin command"}
      data-testid={`command-palette-pin-${itemId}`}
      onPointerDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const button = event.currentTarget;
        if (button.ownerDocument.activeElement === button) {
          const row = button.closest('[data-slot="command-item"]');
          const input = button
            .closest('[data-slot="command"]')
            ?.querySelector<HTMLInputElement>('[data-slot="command-input"]');
          // Pinning remounts the row in another group. Keep its value while
          // returning keyboard focus to the palette's persistent input.
          if (row) highlight(row.id);
          if (button.ownerDocument.activeElement === button) input?.focus();
        }
        onToggle();
      }}
      className={cn(
        "size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground group-data-[selected=true]/command-item:text-primary",
        pinned
          ? "inline-flex text-foreground"
          : "hidden group-hover/command-item:inline-flex group-data-[selected=true]/command-item:inline-flex",
      )}
    >
      {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
    </button>
  );
}
