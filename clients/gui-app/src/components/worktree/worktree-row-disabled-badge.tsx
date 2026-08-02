import type { ReactNode } from "react";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";

/**
 * The non-selectable-row badge shared by every worktree picker (git-diff
 * switcher, file-tree, terminal). `pending` rows - whose git-eligibility is an
 * unverified placeholder the host is still resolving - render muted with a
 * spinner ("checking"); a real disabled reason (setup state, missing worktree)
 * renders destructive. One component so the two surfaces can't drift.
 */
export function WorktreeRowDisabledBadge(props: {
  readonly label: string;
  readonly pending: boolean;
}): ReactNode {
  if (props.pending) {
    return (
      <Badge variant="outline" className="shrink-0 gap-1">
        <MutedAgentSpinner />
        {props.label}
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="shrink-0">
      {props.label}
    </Badge>
  );
}
