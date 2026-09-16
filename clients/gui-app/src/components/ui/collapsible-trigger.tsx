import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

// Radix ships this trigger unstyled, so until `shadcn/no-restyle` counted them
// all 17 call sites dressed it by hand - and 8 of them wrote the SAME focus
// ring. A disclosure control has to show focus wherever it is, so that ring
// and the transition it fades over are the base, not a variant.
//
//   - `panel` — the header strip of a chat dock panel: a full-width row with a
//     hover fill. Five call sites had this character for character.
//   - `quiet` — a disclosure inside running text (an activity group, a
//     resolved interview): no box, a muted label that comes up to foreground
//     on hover and on focus. `px-1`, not the `pr-1` two of its three call
//     sites happened to carry: the inset is symmetric because the hover fill
//     is, and a glyph touching the left edge of a rounded fill reads as a
//     clipping bug.
const collapsibleTriggerVariants = cva(
  "gap-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
  {
    variants: {
      variant: {
        default: "",
        // muted-fill-ok: the five panels using this sit on the chat dock's
        // bg-canvas, and --canvas never equals --muted.
        panel: "px-3 py-1.5 hover:bg-muted/50",
        quiet:
          "rounded-sm px-1 py-1 text-muted-foreground hover:text-foreground focus-visible:text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function CollapsibleTrigger({
  className,
  variant,
  ...props
}: ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger> &
  VariantProps<typeof collapsibleTriggerVariants>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      className={cn(collapsibleTriggerVariants({ variant }), className)}
      {...props}
    />
  );
}

export { CollapsibleTrigger };
