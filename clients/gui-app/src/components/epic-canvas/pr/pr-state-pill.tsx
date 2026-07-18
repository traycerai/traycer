import type { ReactNode } from "react";
import type { PrState } from "@traycer/protocol/host/pr-schemas";
import { Badge } from "@/components/ui/badge";
import { PR_PILL_CLASS } from "@/components/worktree/worktree-pr-metadata-model";
import { formatPrStateLabel } from "@/lib/pr/pr-list-projection";
import { cn } from "@/lib/utils";

export function PrStatePill(props: {
  readonly state: PrState;
  readonly className: string | undefined;
}): ReactNode {
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 font-medium",
        PR_PILL_CLASS[props.state],
        props.state === "closed" && "opacity-70",
        props.className,
      )}
      data-testid="pr-state-pill"
      data-pr-state={props.state}
    >
      {formatPrStateLabel(props.state)}
    </Badge>
  );
}
