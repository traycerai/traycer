import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "@/lib/utils";

function Separator({
  className,
  orientation = "horizontal",
  role = "none",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      role={role}
      aria-orientation={role === "separator" ? orientation : undefined}
      orientation={orientation}
      className={(state) =>
        cn(
          "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export { Separator };
