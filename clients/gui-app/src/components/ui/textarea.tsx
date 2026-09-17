import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// The same three axes as `Input`, and for the same measured reasons - see the
// note at the top of `input.tsx`. `bare` additionally cancels the resize grip
// and carries the `py-2` an embedded control needs to sit on the group's
// centre line, because a bare textarea only ever appears inside a box drawn by
// something else.
const textareaVariants = cva(
  "field-sizing-content flex min-h-16 w-full rounded-md border border-input bg-transparent transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      variant: {
        default: "",
        bare: "resize-none rounded-none border-0 bg-transparent py-2 ring-0 focus-visible:ring-0 disabled:bg-transparent aria-invalid:ring-0 dark:bg-transparent dark:disabled:bg-transparent",
      },
      size: {
        default: "px-2.5 py-2 text-ui md:text-ui-sm",
        sm: "px-2.5 py-2 text-ui-sm",
        xs: "px-2 py-1.5 text-ui-xs",
        /**
         * The CODE type scale, which tracks the user's Appearance ▸ Code font
         * size (`--text-code-sm` is `var(--code-font-size, 12px)`).
         *
         * For a long-form mono DOCUMENT - a policy the user writes and reads
         * at length - as distinct from the short mono fields (a branch prefix,
         * an args line, a header pair) that take `sm` or `xs` and are chrome
         * rather than prose. The sibling long-form editor
         * (`markdown-edit-preview`) reads the same preference directly, and
         * these two should not disagree about how big the user's code is.
         *
         * Deliberately NOT folded into `font: "mono"`: every existing
         * `font="mono"` call site is one of those short fields and pairs a `ui`
         * size with it, so carrying the code scale on the font axis would
         * resize all of them. Opting in is the point.
         */
        code: "px-2.5 py-2 text-code-sm",
      },
      font: {
        sans: "",
        mono: "font-mono",
      },
    },
    defaultVariants: { variant: "default", size: "default", font: "sans" },
  },
);

function Textarea({
  className,
  variant,
  size,
  font,
  ...props
}: React.ComponentProps<"textarea"> & VariantProps<typeof textareaVariants>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(textareaVariants({ variant, size, font }), className)}
      {...props}
    />
  );
}

export { Textarea };
