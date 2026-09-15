import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

// Press feedback is the shared `active:press-scrim`, never a per-variant
// `active:bg-*` - see `Button` and the utility's definition in `index.css` for
// why a shared variant must not assert a press color, and why the scrim is
// opted into per variant rather than declared on the base.
const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent font-medium whitespace-nowrap transition-all aria-disabled:active:bg-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground active:press-scrim [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground active:press-scrim [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive active:press-scrim focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground active:press-scrim [a]:hover:bg-foreground/5 [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-foreground/5 hover:text-muted-foreground active:press-scrim",
        // No scrim, for the same reason as the Button link variant: no box to
        // tint, so the underline carries the press.
        link: "text-primary underline-offset-4 hover:underline active:underline",
        // The quiet tag: a metadata chip beside a name (a provider's auth
        // mode, a PR's owner, a worktree's origin). It is the single biggest
        // thing call sites were hand-writing - `font-normal` plus
        // `text-muted-foreground` plus a thinned border, 12 times over.
        muted:
          "border-border/60 text-muted-foreground font-normal active:press-scrim",
        // The three status roles `destructive` did not already cover, on the
        // recipe gui-app's AGENTS.md documents for all four:
        // `border-<role>/30 bg-<role>/10 text-<role>-foreground`. Added as a
        // family rather than one at a time, exactly as Button's status
        // variants were - a badge is where a status is most often stated, and
        // a role missing from the set is how a palette hue gets reached for.
        success:
          "border-success/30 bg-success/10 text-success-foreground active:press-scrim",
        warning:
          "border-warning/30 bg-warning/10 text-warning-foreground active:press-scrim",
        info: "border-info/30 bg-info/10 text-info-foreground active:press-scrim",
      },
      // One height, three type steps - the same shape `Input` takes. `xs` is
      // the dense metadata chip the settings panels and the pickers are full
      // of (and squares its corners, because a 16px pill reads as a button);
      // `sm` is the ALL-CAPS-ish overline tag on a list row.
      size: {
        default: "h-5 px-2 py-0.5 text-ui-xs",
        sm: "h-5 px-1.5 py-0 text-overline",
        xs: "h-4 rounded-sm px-1.5 py-0 text-micro leading-none",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      data-size={size}
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Badge };
