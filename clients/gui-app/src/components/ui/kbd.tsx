import { cn } from "@/lib/utils";

// A key-cap glyph, and nothing more - it is equally the keybinding settings'
// rendering of a chord being edited. A `Kbd` that ADVERTISES a shortcut on
// some other control belongs inside `<ShortcutHint>`, which owns whether such
// a hint is worth showing at all.
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-md border border-border/60 bg-foreground/8 px-1 font-sans text-xs font-medium text-muted-foreground select-none in-data-[slot=tooltip-content]:border-background/20 in-data-[slot=tooltip-content]:bg-background/20 in-data-[slot=tooltip-content]:text-background dark:in-data-[slot=tooltip-content]:bg-background/10 [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
