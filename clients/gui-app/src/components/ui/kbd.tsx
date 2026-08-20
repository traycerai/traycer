import { cn } from "@/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-md border border-border/60 bg-foreground/8 px-1 font-sans text-xs font-medium text-muted-foreground select-none in-data-[slot=tooltip-content]:border-background/20 in-data-[slot=tooltip-content]:bg-background/20 in-data-[slot=tooltip-content]:text-background dark:in-data-[slot=tooltip-content]:bg-background/10 [&_svg:not([class*='size-'])]:size-3",
        // A keycap's default fill and label are calibrated for the AMBIENT
        // surface: `bg-foreground/8` sits one step off the page/card behind
        // it, and `--muted-foreground` is that surface's own quiet text token.
        // A variant that paints an OPAQUE fill breaks both halves at once - a
        // foreground alpha over `bg-primary` washes the fill instead of
        // stepping off it, and `--muted-foreground` has no relationship to
        // `--primary-foreground`. `--muted-foreground` on `--primary` clears
        // 4.5:1 in NO preset, in either mode (best case 4.36 on amoled light,
        // worst 1.01 on traycer-green light), so on a primary button the caps
        // were unreadable everywhere, not just on the dark presets where it
        // looks worst.
        //
        // Riding the button's own foreground IMPROVES every preset and mode -
        // never worse, and at least 1.67x on `--primary` specifically (the
        // `--secondary` minimum is only 1.002x, on everforest light). It does
        // NOT make every preset readable: the cap lands at the action label's
        // own contrast, so the six accent-only presets stay where their
        // `--primary`/`--primary-foreground` pair already puts the LABEL
        // (orange 2.73, green 2.89 - both under 3:1). That residual is the
        // preset's, not the keycap's; `primary-action-shortcut-hint.test.tsx`
        // pins >= 4.5:1 for the full-palette presets only, for the same reason.
        //
        // The line is an OPAQUE fill, NOT "the variant sets a text color".
        // `destructive` also sets one, but paints `bg-destructive/10` - the
        // ambient surface still shows through, so the ambient calibration is
        // right there and `text-current` would make it WORSE (nord dark:
        // 5.96 -> 2.79). `outline` / `ghost` / `link` are ambient too.
        "in-[[data-slot=button]:is([data-variant=default],[data-variant=secondary])]:border-current",
        "in-[[data-slot=button]:is([data-variant=default],[data-variant=secondary])]:bg-transparent",
        "in-[[data-slot=button]:is([data-variant=default],[data-variant=secondary])]:text-current",
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
