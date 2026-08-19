import { StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

export function NotesButton(props: {
  readonly disabled: boolean;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <TooltipWrapper label="Notes" side="top" sideOffset={6} align={undefined}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={props.disabled}
        aria-label="Notes"
        aria-haspopup="dialog"
        data-testid="notes-button"
        onClick={props.onClick}
        className={cn(
          "text-muted-foreground hover:text-foreground",
          props.active && "bg-accent text-foreground hover:text-foreground",
        )}
      >
        <StickyNote className="size-4" />
      </Button>
    </TooltipWrapper>
  );
}
