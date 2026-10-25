import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

export function FrameCommentsToolbar(props: {
  readonly active: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <TooltipWrapper
      label="Comments"
      side="bottom"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        size="icon-sm"
        variant={props.active ? "secondary" : "ghost"}
        aria-label="Comments"
        aria-pressed={props.active}
        onClick={props.onToggle}
      >
        <MessageSquare />
      </Button>
    </TooltipWrapper>
  );
}
