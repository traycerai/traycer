import { useMemo, useState, type ReactNode } from "react";
import { Paintbrush, Pin } from "lucide-react";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SweepWorktreesDialog } from "@/components/epics/sweep-worktrees-dialog";
import { useEpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import {
  useEpicSetPinned,
  usePendingSetPinnedEpicIds,
} from "@/hooks/epic/use-epic-set-pinned-mutation";
import { useEpicTaskPinnedStates } from "@/hooks/epic/use-epic-task-pinned-states-query";
import { useTaskWorktreeMetadata } from "@/hooks/worktree/use-task-worktree-metadata-query";
import {
  computeTaskMergeRollup,
  taskMergeRollupLabel,
  type TaskMergeRollup,
} from "@/lib/worktree/task-merge-rollup";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { cn } from "@/lib/utils";

const EMPTY_ENTRIES: readonly WorktreeHostEntryV12[] = [];

/**
 * The always-visible task-status footer of the open epic's sidebar. Constant
 * content is STATUS (live activity while running, the True-AND merge rollup
 * when idle) plus the pin toggle; the destructive Sweep affordance only
 * materializes when the task is actually sweepable (idle, with at least one
 * exclusively-owned worktree the shared classifier proves landed or at base
 * commit) - no permanently parked disabled button.
 */
export function TaskStatusStrip(props: {
  readonly epicId: string;
  readonly tabId: string;
}): ReactNode {
  const { epicId, tabId } = props;
  const activity = useEpicActivityStatus(epicId);
  const epicIds = useMemo(() => [epicId], [epicId]);
  const metadata = useTaskWorktreeMetadata(epicIds);
  const entries = metadata.worktreesByEpicId.get(epicId) ?? EMPTY_ENTRIES;
  const rollup = useMemo(() => computeTaskMergeRollup(entries), [entries]);
  const tabName = useEpicCanvasStore((s) => {
    const tab = s.tabsById[tabId];
    return tab?.epicId === epicId ? tab.name : null;
  });
  const [sweepOpen, setSweepOpen] = useState(false);
  // Shown whenever the task owns worktrees, eligible or not: the dialog lists
  // every worktree with its proof state and pre-checks only the safe ones, so
  // the affordance no longer needs to pre-judge eligibility.
  const showSweep = entries.length > 0;

  return (
    <TooltipProvider>
      <div
        data-testid="task-status-strip"
        className="flex h-9 shrink-0 items-center gap-2 border-t border-border/60 px-3"
      >
        <TaskStatusLabel
          activity={activity}
          rollup={rollup}
          worktreeCount={entries.length}
        />
        <span className="min-w-0 flex-1" />
        {showSweep ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 text-ui-xs"
            onClick={() => setSweepOpen(true)}
            data-testid="task-status-strip-sweep"
          >
            <Paintbrush className="size-3" aria-hidden />
            Sweep
          </Button>
        ) : null}
        <TaskStatusPinToggle epicId={epicId} />
      </div>
      <SweepWorktreesDialog
        epicId={sweepOpen ? epicId : null}
        taskTitle={tabName}
        onOpenChange={(open) => {
          if (!open) setSweepOpen(false);
        }}
      />
    </TooltipProvider>
  );
}

function TaskStatusLabel(props: {
  readonly activity: "idle" | "turn" | "background";
  readonly rollup: TaskMergeRollup;
  readonly worktreeCount: number;
}): ReactNode {
  if (props.activity !== "idle") {
    return (
      <span
        className="flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground"
        data-testid="task-status-strip-activity"
      >
        <AgentSpinningDots
          variant="dots"
          className="text-muted-foreground"
          testId={undefined}
        />
        Working…
      </span>
    );
  }
  const rollupLabel = taskMergeRollupLabel(props.rollup);
  if (rollupLabel !== null) {
    return (
      <span
        className={cn(
          "truncate rounded-full border px-1.5 text-ui-xs",
          props.rollup.status === "merged"
            ? "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/30 dark:text-emerald-300"
            : "border-border bg-muted/40 text-muted-foreground",
        )}
        data-testid="task-status-strip-rollup"
      >
        {props.rollup.status === "merged" ? "Landed" : rollupLabel}
      </span>
    );
  }
  if (props.worktreeCount === 0) return null;
  return (
    <span className="truncate text-ui-xs text-muted-foreground">
      {props.worktreeCount} worktree{props.worktreeCount === 1 ? "" : "s"}
    </span>
  );
}

function TaskStatusPinToggle(props: { readonly epicId: string }): ReactNode {
  const { epicId } = props;
  const epicIds = useMemo(() => [epicId], [epicId]);
  const pinnedStates = useEpicTaskPinnedStates(epicIds);
  const pinned = pinnedStates.get(epicId) ?? null;
  const setPinnedMutation = useEpicSetPinned();
  const setPinned = setPinnedMutation.mutate;
  const isPinPending = usePendingSetPinnedEpicIds().has(epicId);
  const label =
    pinned === true ? "Unpin Task in History" : "Pin Task in History";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pinned === true}
          data-testid="task-status-strip-pin"
          disabled={pinned === null || isPinPending}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-wait",
            pinned === true ? "text-primary" : "text-muted-foreground",
          )}
          onClick={() => {
            if (pinned === null) return;
            setPinned({ epicId, pinned: !pinned });
          }}
        >
          {/* Optimistic pin state - the icon flips at click time; the brief
              disabled window only serializes rapid re-toggles. */}
          <Pin className={cn("size-3.5", pinned === true && "fill-current")} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
