import type { ReactNode } from "react";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Shared status badge for worktree-picker rows. Pending verification renders
 * muted with a spinner; incomplete setup renders as a warning, and an unusable
 * path renders destructive. Row selectability is owned by the picker model,
 * independently from whether status is visible.
 */
const STATUS_BADGE_VARIANT = {
  neutral: "outline",
  warning: "warning",
  error: "destructive",
} as const;

export function WorktreeRowStatusBadge(props: {
  readonly label: string;
  readonly pending: boolean;
  readonly tone: "neutral" | "warning" | "error";
  readonly detail: string;
}): ReactNode {
  const badge = (
    <Badge
      variant={STATUS_BADGE_VARIANT[props.tone]}
      data-status-tone={props.tone}
      aria-label={`${props.label}. ${props.detail}`}
      className="shrink-0"
    >
      {props.pending ? <MutedAgentSpinner /> : null}
      {props.label}
    </Badge>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-80 whitespace-normal">
        {props.detail}
      </TooltipContent>
    </Tooltip>
  );
}
