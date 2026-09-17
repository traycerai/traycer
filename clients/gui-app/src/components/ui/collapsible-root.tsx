import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

// Two shapes the app draws a disclosure as, each written out at four or five
// call sites before this variant existed:
//
//   - `panel` — a chat dock strip (accumulated changes, active agents,
//     background items, the pinned stack, the queue). A tinted band that is
//     part of the dock's chrome rather than a thing sitting on it.
//   - `card` — a bordered block in the transcript (a segment card, a subagent
//     run, an image generation, the sign-in device-code fallback).
//
// Anything else a caller writes on the ROOT is placement, the quiet text
// colour the whole subtree inherits, or a rule against the sibling above or
// below it; the contract in `eslint.config.mjs` says so.
const collapsibleVariants = cva("", {
  variants: {
    variant: {
      default: "",
      // muted-fill-ok: the chat dock is bg-canvas, and --canvas never equals
      // --muted.
      panel: "bg-muted/30",
      // muted-fill-ok: the transcript is bg-background, and the explicit
      // border survives a --muted/--background collapse anyway.
      card: "rounded-md border border-border/60 bg-muted/20 text-ui-sm transition-colors",
    },
  },
  defaultVariants: { variant: "default" },
});

function Collapsible({
  className,
  variant,
  ...props
}: ComponentProps<typeof CollapsiblePrimitive.Root> &
  VariantProps<typeof collapsibleVariants>) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="collapsible"
      className={cn(collapsibleVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Collapsible };
