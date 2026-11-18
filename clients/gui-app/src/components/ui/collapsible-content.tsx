import type { ComponentProps } from "react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";

function CollapsibleContent({
  ...props
}: ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      {...props}
    />
  );
}

export { CollapsibleContent };
