import {
  Component,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Paintbrush } from "lucide-react";
import { appLogger } from "@/lib/logger";
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

const EMPTY_ENTRIES: readonly WorktreeHostEntryV12[] = [];

/**
 * Icon-only Sweep affordance in the Epic status row (top-right), next to the
 * sync pill. Shown whenever the Task owns worktrees on this host; the dialog
 * does the judging - it lists every worktree with its proof state and
 * pre-checks only the ones proven safe.
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
    <StatusRowChromeBoundary>
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

  if (entries.length === 0) return null;

  return (
    <>
      <TooltipWrapper
        label={sweepTooltip(entries.length, taskMergeRollupLabel(rollup))}
        side="bottom"
        sideOffset={undefined}
        align="end"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Sweep worktrees"
          aria-haspopup="dialog"
          data-testid="epic-sweep-action"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setSweepOpen(true)}
        >
          <Paintbrush className="size-3.5" />
        </Button>
      </TooltipWrapper>
      <SweepWorktreesDialog
        epicId={sweepOpen ? epicId : null}
        taskTitle={tabName}
        onOpenChange={(open) => {
          if (!open) setSweepOpen(false);
        }}
      />
    </>
  );
}

interface StatusRowChromeBoundaryState {
  readonly failed: boolean;
}

/**
 * Renders nothing when its child throws. Deliberately silent: the child is an
 * optional status-row affordance, so the honest fallback is its absence, not a
 * broken-widget placeholder in the Epic chrome. The throw is still logged once
 * so a real regression is visible in the log rather than swallowed.
 */
class StatusRowChromeBoundary extends Component<
  { readonly children: ReactNode },
  StatusRowChromeBoundaryState
> {
  constructor(props: { readonly children: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): StatusRowChromeBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    appLogger.warn("[epic-status-row] sweep affordance failed to render", {
      error: error.message,
      componentStack: info.componentStack ?? null,
    });
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
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
