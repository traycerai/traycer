import type { ReactNode } from "react";
import type { StatusBadgeStyle } from "@/lib/git/status-icon";
import { cn } from "@/lib/utils";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
const toneClass: Record<StatusBadgeStyle["tone"], string> = {
  success: "bg-success/10 text-success",
  destructive: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  warning: "bg-warning/10 text-warning",
};

interface GitStatusBadgeBaseProps {
  readonly letter: string;
  readonly tone: StatusBadgeStyle["tone"];
  readonly label: string;
  /** Off where something above already owns the hover for this area - the
   *  dense panel row, which has no room for a second hover target. Named for
   *  the tooltip, not the old native `title` it used to toggle. */
  readonly withTooltip: boolean;
}

interface GitStatusBadgeClassNameProps extends GitStatusBadgeBaseProps {
  readonly className: string;
}

type GitStatusBadgeProps =
  GitStatusBadgeBaseProps | GitStatusBadgeClassNameProps;

export function GitStatusBadge(props: GitStatusBadgeProps): ReactNode {
  const className = "className" in props ? props.className : undefined;
  return (
    <TooltipWrapper
      label={props.withTooltip ? props.label : undefined}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        className={cn(
          "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded px-1 text-[10px] font-bold",
          toneClass[props.tone],
          className,
        )}
        aria-label={props.label}
      >
        {props.letter}
      </span>
    </TooltipWrapper>
  );
}
