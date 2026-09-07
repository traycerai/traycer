import { cn } from "@/lib/utils";

/** `bg-foreground/10`, not `bg-muted`: every preset theme's dark variant defines `--muted` identical to
 * `--popover` and `--card`, and the flat light presets (github, gruvbox, tokyo-night, nord. */
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
