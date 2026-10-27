import type { ReactNode } from "react";
import { Star } from "lucide-react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

/**
 * The mark of an environment's main bot (decisions 30, 104): a small star
 * beside its name on Home, in the channel sidebar and in its channel's header.
 */
export function MainBotBadge(props: { readonly testId: string }): ReactNode {
  return (
    <TooltipWrapper
      label="Main bot"
      side="top"
      sideOffset={6}
      align={undefined}
    >
      <Star
        role="img"
        aria-label="Main bot"
        data-testid={props.testId}
        className="size-3 shrink-0 fill-current text-muted-foreground"
      />
    </TooltipWrapper>
  );
}
