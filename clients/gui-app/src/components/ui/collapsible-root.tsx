import type { ComponentProps } from "react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";

function Collapsible({
  ...props
}: ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

export { Collapsible };
