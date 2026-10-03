import type { ComponentProps } from "react";
import { Collapsible as CollapsiblePrimitive, Slot } from "radix-ui";
import { useCollapsibleState } from "@/components/ui/collapsible-context";

function CollapsibleContent({
  asChild,
  forceMount,
  children,
  ...props
}: ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  const { open, disabled, contentId } = useCollapsibleState();
  const present = open || forceMount === true;
  const Component = asChild ? Slot.Root : "div";
  // No caller animates disclosure height or exit. Radix's Content measures
  // even its hidden div at mount; a native body needs neither Presence nor
  // animation geometry. Keep the hidden shell and unmount closed children.
  return (
    <Component
      data-slot="collapsible-content"
      data-state={open ? "open" : "closed"}
      data-disabled={disabled ? "" : undefined}
      id={contentId}
      hidden={!present}
      {...props}
    >
      {present ? children : null}
    </Component>
  );
}

export { CollapsibleContent };
