import type { ComponentProps, PointerEvent } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text items-center justify-center gap-2 py-1.5 text-ui-sm font-medium text-muted-foreground select-none group-data-[disabled=true]/input-group:opacity-50 [&>kbd]:rounded-xs [&>svg:not([class*='size-'])]:size-4",
  {
    variants: {
      align: {
        "inline-start":
          "order-first pl-2 has-[>button]:ml-[-0.3rem] has-[>kbd]:ml-[-0.15rem]",
        "inline-end":
          "order-last pr-2 has-[>button]:mr-[-0.3rem] has-[>kbd]:mr-[-0.15rem]",
        "block-start":
          "order-first w-full justify-start px-2.5 pt-2 group-has-[>input]/input-group:pt-2 [.border-b]:pb-2",
        "block-end":
          "order-last w-full justify-start px-2.5 pb-2 group-has-[>input]/input-group:pb-2 [.border-t]:pt-2",
      },
    },
    defaultVariants: {
      align: "inline-start",
    },
  },
);

function InputGroupAddon({
  className,
  align,
  onPointerDown,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  const resolvedAlign = align ?? "inline-start";

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    onPointerDown?.(event);

    if (event.defaultPrevented) {
      return;
    }

    if ((event.target as HTMLElement).closest("button")) {
      return;
    }

    event.currentTarget.parentElement?.querySelector("input")?.focus();
  }

  return (
    <div
      data-slot="input-group-addon"
      data-align={resolvedAlign}
      className={cn(
        inputGroupAddonVariants({ align: resolvedAlign }),
        className,
      )}
      onPointerDown={handlePointerDown}
      {...props}
    />
  );
}

export { InputGroupAddon };
