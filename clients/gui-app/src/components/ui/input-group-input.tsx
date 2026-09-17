import type { ComponentProps } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// `size="sm"` by default: every search field in the app was writing
// `text-ui-sm` back on at the call site. A group is always desktop chrome
// (a search box, an address bar, a path picker), so the mobile 16px step the
// bare `Input` default carries has nothing to protect here.
function InputGroupInput({
  className,
  size,
  ...props
}: Omit<ComponentProps<typeof Input>, "variant">) {
  return (
    <Input
      data-slot="input-group-control"
      variant="bare"
      size={size ?? "sm"}
      className={cn("flex-1", className)}
      {...props}
    />
  );
}

export { InputGroupInput };
