import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * One end of a route line: a model on an account, shown as a place.
 *
 * The STATIC half of a pair. The end a user can change is a `Button` with
 * `variant="route-chip" size="route-chip"`, which carries this same geometry,
 * so the two chips on one route line share a box and differ only in whether
 * they open anything. Routing cards draw "from → to" with one of each, and a
 * wait or a retry - which move nothing - with this chip alone.
 *
 * Slots, as on `Button`: a leading icon (the harness glyph) and a trailing
 * one marked `data-icon="inline-end"` (the waiting card's clock). The
 * segments inside set their own emphasis, so the chip itself stays at body
 * weight.
 *
 * It WRAPS rather than truncating. The part of a destination a truncation
 * would cut off is the account at the end - which is usually the part that
 * changed.
 */
function RouteChip({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="route-chip"
      className={cn(
        "inline-flex min-h-7 min-w-0 max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-border bg-foreground/3 px-2.5 py-1 text-ui-sm text-foreground has-data-[icon=inline-end]:pr-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export { RouteChip };
