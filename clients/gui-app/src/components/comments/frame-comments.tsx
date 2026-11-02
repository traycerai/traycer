import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

/**
 * The comments toggle where comments cannot be left right now, kept in its
 * place so the controls around it do not move, with the reason as its tooltip.
 */
export function FrameCommentsUnavailable(props: { readonly reason: string }) {
  return (
    <TooltipWrapper
      label={props.reason}
      side="bottom"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">
        <Button size="icon-sm" variant="ghost" aria-label="Comments" disabled>
          <MessageSquare />
        </Button>
      </span>
    </TooltipWrapper>
  );
}

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
