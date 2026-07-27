import type { ReactNode } from "react";
import type { PrState } from "@traycer/protocol/host/pr-schemas";
import { Badge } from "@/components/ui/badge";
import { formatPrStateLabel } from "@/lib/pr/pr-list-projection";
import { cn } from "@/lib/utils";

/**
 * The outlined, labelled PR pill this panel renders — deliberately its own
 * palette, not the worktree hover card's. That surface dropped its label and
 * moved state onto a leading glyph (`worktree-pr-state-palette.ts`), which
 * suits a chip sitting beside a PR number; a PR list needs the word.
 *
 * The light text is `-800`, not `-700`: over the pill's own 10% tint, `-700`
 * drops to 3.23:1 (green) on Tokyo Night light, whose surfaces are the darkest
 * of the light presets. `-800` clears 4.5:1 across every preset and surface;
 * dark `-300` already does.
 */
const PR_PILL_CLASS: Record<PrState, string> = {
  open: "border-green-600/30 bg-green-500/10 text-green-800 dark:border-green-400/30 dark:text-green-300",
  closed:
    "border-red-600/25 bg-red-500/10 text-red-800 dark:border-red-400/25 dark:text-red-300",
  merged:
    "border-purple-600/30 bg-purple-500/10 text-purple-800 dark:border-purple-400/30 dark:text-purple-300",
};

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
