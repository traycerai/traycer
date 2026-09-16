"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Label as LabelPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

// `font-medium` is the FIELD label - the thing above an input, which has to
// out-weigh the value under it. The two variants below are the other two jobs
// this component does, both of which call sites were writing by hand:
//
//   - `option` — the label OF a checkbox or radio, where the control carries
//     the emphasis and the text is a sentence to read (body weight).
//   - `muted` — a secondary caption on a form row.
//   - `row` — a label that IS the clickable row (the diff toolbar's filter
//     menu, the file tile's view menu): the whole strip highlights, so the
//     label owns the padding and the hover.
const labelVariants = cva(
  "flex items-center gap-2 leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "",
        option: "font-normal",
        muted: "text-muted-foreground",
        row: "gap-3 rounded-md px-2 py-1.5 font-normal transition-colors hover:bg-foreground/5",
      },
      size: {
        default: "text-ui-sm",
        xs: "text-ui-xs",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Label({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root> &
  VariantProps<typeof labelVariants>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(labelVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Label };
