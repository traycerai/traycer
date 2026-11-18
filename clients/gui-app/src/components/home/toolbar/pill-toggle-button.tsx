import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
interface PillToggleButtonProps {
  active: boolean;
  onClick: () => void;
  /** Hover label. Named `tooltip`, not `title`: a `title` prop on a
   *  DOM-spreading component is indistinguishable from the native attribute. */
  tooltip: string;
  children: ReactNode;
}

export function PillToggleButton(props: PillToggleButtonProps) {
  const { active, onClick, tooltip, children } = props;
  return (
    <TooltipWrapper
      label={tooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "rounded-sm px-2 py-0.5 transition-colors",
          active
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {children}
      </button>
    </TooltipWrapper>
  );
}
