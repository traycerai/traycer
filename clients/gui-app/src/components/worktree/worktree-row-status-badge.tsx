import type { ReactNode } from "react";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Shared status badge for worktree-picker rows. Pending verification renders
 * muted with a spinner; incomplete setup renders as a warning, and an unusable
 * path renders destructive. Row selectability is owned by the picker model,
 * independently from whether status is visible.
 */
export function WorktreeRowStatusBadge(props: {
  readonly label: string;
  readonly pending: boolean;
  readonly tone: "neutral" | "warning" | "error";
  readonly detail: string;
}): ReactNode {
  const badge = (
    <Badge
      variant={props.tone === "error" ? "destructive" : "outline"}
      data-status-tone={props.tone}
      aria-label={`${props.label}. ${props.detail}`}
      className={cn(
        "shrink-0",
        props.pending && "gap-1",
        props.tone === "warning" &&
          "border-warning/30 bg-warning/10 text-warning-foreground",
      )}
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
