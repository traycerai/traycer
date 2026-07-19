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
}

// Transparent wrapper: when `label` is empty/null, behaves as a Radix Slot so
// any props/ref injected by an outer `asChild` trigger (e.g.
// `DropdownMenuTrigger asChild`) flow through to the inner child. Otherwise
// renders the tooltip stack with the same forwarding via
// `TooltipTrigger asChild`.
//
// We deliberately keep `TooltipWrapperProps` narrow at the call-site, but the
// runtime `props` object also carries whatever `React.cloneElement` injects
// when this component is the immediate child of an outer `asChild` slot
// (`onClick`, `onPointerDown`, `ref`, etc.). The rest-spread forwards those
// to the inner Slot/TooltipTrigger so they reach the real interactive element.
export function TooltipWrapper(props: TooltipWrapperProps) {
  const {
    children,
    label,
    side,
    sideOffset,
    align,
    open,
    onOpenChange,
    ...rest
  } = props;
  if (label === null || (typeof label === "string" && label.length === 0)) {
    return <Slot.Root {...rest}>{children}</Slot.Root>;
  }
  return (
    <Tooltip open={open} onOpenChange={onOpenChange}>
      <TooltipTrigger asChild {...rest}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={sideOffset} align={align}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
