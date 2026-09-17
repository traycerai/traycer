import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// `search` is the app's filter field, written out identically at seven call
// sites before this variant existed (the epic sidebar, the branch picker, the
// folder picker, the worktree form, the model picker, the repo switcher and
// the command palette's own input): a softer fill than a form field so it
// reads as chrome rather than as something to fill in, and a larger radius.
// Those call sites also carried `shadow-none!` and a `pl-2!` for the leading
// addon; both are dropped here rather than moved in, because the base carries
// no shadow at all and `InputGroupAddon`'s own `inline-start` already is
// `pl-2` - they were overriding values that already held.
const inputGroupVariants = cva(
  "group/input-group relative m-0 flex h-8 w-full min-w-0 items-center rounded-md border border-input p-0 transition-colors outline-none in-data-[slot=combobox-content]:focus-within:border-inherit in-data-[slot=combobox-content]:focus-within:ring-0 has-disabled:bg-input/50 has-disabled:opacity-50 has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-3 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50 has-[[data-slot][aria-invalid=true]]:border-destructive has-[[data-slot][aria-invalid=true]]:ring-3 has-[[data-slot][aria-invalid=true]]:ring-destructive/20 has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>textarea]:h-auto dark:bg-input/30 dark:has-disabled:bg-input/80 dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40 has-[>[data-align=block-end]]:[&>input]:pt-3 has-[>[data-align=block-start]]:[&>input]:pb-3 has-[>[data-align=inline-end]]:[&>input]:pr-1.5 has-[>[data-align=inline-start]]:[&>input]:pl-1.5",
  {
    variants: {
      variant: {
        default: "",
        search: "rounded-lg border-input/40 bg-input/25",
        // A filter box inside a panel HEADER: no border of its own, because
        // the header already has one, and a fill that comes up on focus. Both
        // git-diff views wrote this out character for character.
        filter:
          "border-transparent bg-muted/25 shadow-none focus-within:bg-muted/35",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function InputGroup({
  className,
  variant,
  ...props
}: ComponentProps<"fieldset"> & VariantProps<typeof inputGroupVariants>) {
  return (
    <fieldset
      data-slot="input-group"
      className={cn(inputGroupVariants({ variant }), className)}
      {...props}
    />
  );
}

export { InputGroup };
