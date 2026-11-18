import { cn } from "@/lib/utils";

/**
 * `bg-foreground/10`, NOT `bg-muted`: every preset theme's dark variant
 * defines `--muted` identical to `--popover` and `--card`, and the flat
 * light presets (github, gruvbox, tokyo-night, nord, everforest) collapse
 * it into `--background` too. A skeleton is mounted wherever its caller
 * lives - dialogs, popovers, cards, page chrome - and no call site can know
 * which of those its surface resolves to, so a surface-NAMING token is the
 * wrong tool. An alpha of the foreground contrasts with whatever it sits on
 * in every theme by construction (measured 1.13-1.36 across all 22 theme
 * blocks x both surface families, against 1.000 - literally invisible - for
 * `bg-muted` on a preset dark popover).
 *
 * Callers may still override the fill; `cn` keeps the later `bg-*` class.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-foreground/10", className)}
      {...props}
    />
  );
}

export { Skeleton };
