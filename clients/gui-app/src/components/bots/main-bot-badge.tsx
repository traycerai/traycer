import type { ReactNode } from "react";
import { Star } from "lucide-react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

/**
 * The mark of an environment's main bot (decisions 30, 104): a small star
 * beside its name on Home, in the channel sidebar and in its channel's header.
 * Muted, or in its row's own colour (`current`) where the row is filled.
 * The tooltip opens from a plain wrapper, so the labelled star is not also
 * described by a tooltip repeating its name.
 */
export function MainBotBadge(props: {
  readonly testId: string;
  readonly tone: "muted" | "current";
}): ReactNode {
  return (
    <TooltipWrapper
      label="Main bot"
      side="top"
      sideOffset={6}
      align={undefined}
    >
      <span className="inline-flex shrink-0">
        <Star
          role="img"
          aria-label="Main bot"
          data-testid={props.testId}
          className={cn(
            "size-3 fill-current",
            props.tone === "muted" ? "text-muted-foreground" : "text-current",
          )}
        />
      </span>
    </TooltipWrapper>
  );
}
