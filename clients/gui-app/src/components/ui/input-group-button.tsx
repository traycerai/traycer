import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const inputGroupButtonVariants = cva(
  "flex items-center gap-2 text-ui-sm shadow-none",
  {
    variants: {
      size: {
        xs: "h-6 gap-1 rounded-xs px-1.5 [&>svg:not([class*='size-'])]:size-3.5",
        sm: "",
        "icon-xs": "size-6 rounded-xs p-0 has-[>svg]:p-0",
        "icon-sm": "size-8 p-0 has-[>svg]:p-0",
      },
    },
    defaultVariants: {
      size: "xs",
    },
  },
);

function InputGroupButton({
  className,
  type,
  variant,
  size,
  ...props
}: Omit<ComponentProps<typeof Button>, "size"> &
  VariantProps<typeof inputGroupButtonVariants>) {
  const resolvedType = type ?? "button";
  const resolvedVariant = variant ?? "ghost";
  const resolvedSize = size ?? "xs";

  return (
    <Button
      type={resolvedType}
      data-size={resolvedSize}
      variant={resolvedVariant}
      className={cn(
        inputGroupButtonVariants({ size: resolvedSize }),
        className,
      )}
      {...props}
    />
  );
}

export { InputGroupButton };
