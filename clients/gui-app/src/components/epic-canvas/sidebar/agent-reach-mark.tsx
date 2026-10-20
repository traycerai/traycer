import type { ReactNode } from "react";
import { Unlink } from "lucide-react";
import { LazySidebarTooltipWrapper } from "@/components/epic-canvas/sidebar/lazy-sidebar-hover";
import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";
import { useOwnerHostNotReachable } from "@/hooks/epic/use-task-host-reach";
import { TASK_HOST_UNREACHABLE_LINE } from "./task-host-groups-model";

/**
 * The reach mark on an Agents-tree row: the agent's host belongs to another
 * owner, so agents here cannot work with it. Decorative for assistive
 * technology, like the offline lock beside it: the row button's own
 * `aria-label` carries the same words, since a labelled button replaces its
 * subtree as the accessible name.
 */
export function AgentReachMark(props: {
  readonly testId: string;
  readonly side: "top" | "right" | "bottom" | "left";
  readonly align: "start" | "center" | "end" | undefined;
}): ReactNode {
  return (
    <LazySidebarTooltipWrapper
      label={TASK_HOST_UNREACHABLE_LINE}
      side={props.side}
      sideOffset={undefined}
      align={props.align}
    >
      <Unlink
        className="size-3 shrink-0 text-muted-foreground"
        data-testid={props.testId}
        aria-hidden
      />
    </LazySidebarTooltipWrapper>
  );
}

/**
 * The mark on one Agents-tree row, placed like the row's other glyph
 * tooltips, or nothing when the owner host is reachable or unknown.
 */
export function AgentReachRowMark(props: {
  readonly ownerHostId: string | null;
  readonly testId: string;
}): ReactNode {
  const notReachable = useOwnerHostNotReachable(props.ownerHostId);
  const placement = useColumnOverlayPlacement("row");
  if (!notReachable) return null;
  return (
    <AgentReachMark
      testId={props.testId}
      side={placement?.side ?? "right"}
      align={placement?.align}
    />
  );
}

/** The same fact as a line under the agent's hover card. */
export function AgentReachHoverLine(): ReactNode {
  return (
    <span
      className="text-ui-xs text-muted-foreground"
      data-testid="agent-hover-reach-line"
    >
      {TASK_HOST_UNREACHABLE_LINE}
    </span>
  );
}
