import { MessageSquareQuote, Split } from "lucide-react";
import type { ChatForkMode } from "@/components/chat/chat-message";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

interface InterviewForkActionsProps {
  readonly onFork: (mode: ChatForkMode) => void;
  readonly disabled: boolean;
  readonly display: "icons" | "labels";
}

/** Fork actions shared by pending questions and resolved Q&A rows. */
export function InterviewForkActions(props: InterviewForkActionsProps) {
  const iconOnly = props.display === "icons";
  return (
    <div className="flex shrink-0 items-center gap-1">
      <TooltipWrapper
        label="Fork on this agent's workspace from this Q&A checkpoint"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <Button
          type="button"
          size={iconOnly ? "icon-xs" : "sm"}
          variant="ghost"
          className="text-muted-foreground"
          aria-label="Cross Question"
          disabled={props.disabled}
          onClick={() => props.onFork("cross-question")}
        >
          <MessageSquareQuote className="size-3.5" aria-hidden />
          {iconOnly ? null : "Cross Question"}
        </Button>
      </TooltipWrapper>
      <TooltipWrapper
        label="Fork into new worktrees carrying your working tree from this Q&A checkpoint"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <Button
          type="button"
          size={iconOnly ? "icon-xs" : "sm"}
          variant="ghost"
          className="text-muted-foreground"
          aria-label="A/B Fork"
          disabled={props.disabled}
          onClick={() => props.onFork("ab-worktree")}
        >
          <Split className="size-3.5 rotate-90" aria-hidden />
          {iconOnly ? null : "A/B Fork"}
        </Button>
      </TooltipWrapper>
    </div>
  );
}
