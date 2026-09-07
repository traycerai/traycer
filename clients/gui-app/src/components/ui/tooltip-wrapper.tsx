import type * as React from "react";
import { Slot } from "radix-ui";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface TooltipWrapperProps {
  readonly children: React.ReactNode;
  readonly label: React.ReactNode;
  readonly side: "top" | "right" | "bottom" | "left";
  readonly sideOffset: number | undefined;
  readonly align: "start" | "center" | "end" | undefined;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** Element the tooltip must stay inside, normally the surrounding `[data-slot="dialog-content"]`. */
  readonly collisionBoundary?: Element | null;
  readonly collisionPadding?: number;
}

// We deliberately keep `TooltipWrapperProps` narrow at the call-site.
export function TooltipWrapper(props: TooltipWrapperProps) {
  const {
    children,
    label,
    side,
    sideOffset,
    align,
    open,
    onOpenChange,
    collisionBoundary,
    collisionPadding,
    ...rest
  } = props;
  // `undefined` degrades exactly like `null`.
  if (
    label === null ||
    label === undefined ||
    (typeof label === "string" && label.length === 0)
  ) {
    return <Slot.Root {...rest}>{children}</Slot.Root>;
  }
  return (
    <Tooltip open={open} onOpenChange={onOpenChange}>
      <TooltipTrigger asChild {...rest}>
        {children}
      </TooltipTrigger>
      <TooltipContent
        side={side}
        sideOffset={sideOffset}
        align={align}
        collisionBoundary={collisionBoundary ?? undefined}
        collisionPadding={collisionPadding}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
