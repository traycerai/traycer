import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Three independent axes, each one a treatment call sites were writing by hand
// before `shadcn/no-restyle` counted them:
//
//   - `variant="bare"` — the field is drawn by something ELSE (an
//     `<InputGroup>`, a find bar's own chrome), so the input contributes the
//     caret and nothing visual. It is the exact class set `input-group-input`
//     and the two find bars were repeating.
//   - `size` — this app's fields come in one HEIGHT and three type steps. The
//     base is `text-ui md:text-ui-sm`, which is the 16px-on-mobile rule that
//     stops iOS zooming a focused field; `sm` opts out of it deliberately
//     (a dialog whose whole form is compact), and `xs` is the toolbar field.
//   - `font="mono"` — the VALUE is code: a path, an env var, a branch name, an
//     API key. Orthogonal to both of the above, which is why it is its own
//     axis rather than a `mono` variant.
const inputVariants = cva(
  "w-full min-w-0 rounded-md border border-input bg-transparent transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-ui-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      variant: {
        default: "",
        bare: "rounded-none border-0 bg-transparent ring-0 focus-visible:ring-0 disabled:bg-transparent aria-invalid:ring-0 dark:bg-transparent dark:disabled:bg-transparent",
      },
      size: {
        default: "h-8 px-2.5 py-1 text-ui md:text-ui-sm",
        sm: "h-8 px-2.5 py-1 text-ui-sm",
        xs: "h-7 px-1.5 py-1 text-ui-xs",
      },
      font: {
        sans: "",
        mono: "font-mono",
      },
    },
    defaultVariants: { variant: "default", size: "default", font: "sans" },
  },
);

function Input({
  className,
  type,
  variant,
  size,
  font,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(inputVariants({ variant, size, font }), className)}
      {...props}
    />
  );
}

export { Input };
