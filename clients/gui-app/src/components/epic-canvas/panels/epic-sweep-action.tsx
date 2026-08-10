import { useMemo, useState, type ReactNode } from "react";
import { Paintbrush } from "lucide-react";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { SweepWorktreesDialog } from "@/components/epics/sweep-worktrees-dialog";
import { useTaskWorktreeMetadata } from "@/hooks/worktree/use-task-worktree-metadata-query";
import {
  computeTaskMergeRollup,
  taskMergeRollupLabel,
} from "@/lib/worktree/task-merge-rollup";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { StatusRowChromeBoundary } from "@/components/epic-canvas/panels/status-row-chrome-boundary";
import { cn } from "@/lib/utils";

const EMPTY_ENTRIES: readonly WorktreeHostEntryV12[] = [];

/**
 * Icon-only Sweep affordance in the Epic status row (top-right), next to the
 * sync pill. Always present - faded and non-actionable when the Task owns no
 * worktrees - so the row keeps a stable shape; the dialog does the judging,
 * listing every worktree with its proof state and pre-checking only the ones
 * proven safe.
 *
 * Host-backed, so callers must only mount it where the host runtime and the
 * Epic session exist (the status row gates on `snapshotLoaded`, which implies
 * a live session). Nothing here is on the render path of a retained pane.
 */
export function EpicSweepAction(props: {
  readonly epicId: string;
  readonly tabId: string;
}): ReactNode {
  // Decorative chrome must never be able to take the canvas down. This is
  // host-backed (worktree metadata), and the host hooks THROW when the runtime
  // is absent or incomplete; unguarded, that error escapes the status row and
  // the route boundary swallows the entire Epic pane with it. Degrade to "no
  // sweep icon" instead - the same action stays reachable from History and
  // Settings ▸ Worktrees.
  return (
    <StatusRowChromeBoundary label="sweep affordance">
      <EpicSweepActionBody epicId={props.epicId} tabId={props.tabId} />
    </StatusRowChromeBoundary>
  );
}

function EpicSweepActionBody(props: {
  readonly epicId: string;
  readonly tabId: string;
}): ReactNode {
  const { epicId, tabId } = props;
  const epicIds = useMemo(() => [epicId], [epicId]);
  const metadata = useTaskWorktreeMetadata(epicIds);
  const entries = metadata.worktreesByEpicId.get(epicId) ?? EMPTY_ENTRIES;
  const rollup = useMemo(() => computeTaskMergeRollup(entries), [entries]);
  const tabName = useEpicCanvasStore((s) => {
    const tab = s.tabsById[tabId];
    return tab?.epicId === epicId ? tab.name : null;
  });
  const [sweepOpen, setSweepOpen] = useState(false);
  // Kept in place (faded, non-actionable) when there is nothing to sweep, so
  // the status row does not gain and lose a control as worktrees come and go -
  // the same treatment History's row action and bulk button use. `aria-disabled`
  // rather than `disabled`: a truly disabled button swallows the pointer events
  // the tooltip needs, and the tooltip is where the reason lives.
  const hasWorktrees = entries.length > 0;

  return (
    <>
      <TooltipWrapper
        label={
          hasWorktrees
            ? sweepTooltip(entries.length, taskMergeRollupLabel(rollup))
            : "No worktrees to sweep for this task"
        }
        side="bottom"
        sideOffset={undefined}
        align="end"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-disabled={hasWorktrees ? undefined : true}
          aria-label={
            hasWorktrees ? "Sweep worktrees" : "No worktrees to sweep"
          }
          // Only claimed when the button can actually open the dialog -
          // announcing a popup that cannot appear misdescribes it to AT.
          aria-haspopup={hasWorktrees ? "dialog" : undefined}
          data-testid="epic-sweep-action"
          className={cn(
            "text-muted-foreground",
            hasWorktrees
              ? "hover:text-foreground"
              : "cursor-not-allowed text-muted-foreground/50 hover:text-muted-foreground/50",
          )}
          onClick={() => {
            if (!hasWorktrees) return;
            setSweepOpen(true);
          }}
        >
          <Paintbrush className="size-3.5" />
        </Button>
      </TooltipWrapper>
      <SweepWorktreesDialog
        epicIds={sweepOpen ? epicIds : null}
        taskTitle={tabName}
        onOpenChange={(open) => {
          if (!open) setSweepOpen(false);
        }}
      />
    </>
  );
}

/**
 * The status the strip used to render permanently now rides the tooltip: how
 * many worktrees this Task owns, and the merge rollup when there is one.
 */
function sweepTooltip(count: number, rollupLabel: string | null): string {
  const noun = `${count} worktree${count === 1 ? "" : "s"}`;
  return rollupLabel === null
    ? `Sweep worktrees — ${noun}`
    : `Sweep worktrees — ${noun}, ${rollupLabel.toLowerCase()}`;
}
