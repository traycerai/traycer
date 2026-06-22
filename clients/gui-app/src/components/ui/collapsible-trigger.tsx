import type { ComponentProps } from "react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";

function CollapsibleTrigger({
  ...props
}: ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      {...props}
    />
  );
}

export { CollapsibleTrigger };
