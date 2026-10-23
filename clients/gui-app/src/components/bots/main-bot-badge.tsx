import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

/**
 * The mark of an environment's main bot (decision 30), beside its name on
 * Home and in its tab's header.
 */
export function MainBotBadge(props: { readonly testId: string }): ReactNode {
  return (
    <TooltipWrapper
      label="The main bot tidies the shared memory."
      side="top"
      sideOffset={6}
      align={undefined}
    >
      <Badge variant="info" size="xs" data-testid={props.testId}>
        Main
      </Badge>
    </TooltipWrapper>
  );
}
