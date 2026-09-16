import type { ComponentProps } from "react";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

function InputGroupTextarea({
  className,
  size,
  ...props
}: Omit<ComponentProps<typeof Textarea>, "variant">) {
  return (
    <Textarea
      data-slot="input-group-control"
      variant="bare"
      size={size}
      className={cn("flex-1", className)}
      {...props}
    />
  );
}

export { InputGroupTextarea };
