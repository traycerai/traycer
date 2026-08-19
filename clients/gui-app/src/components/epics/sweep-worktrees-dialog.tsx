import { useEffect, useId, useState, type ReactNode } from "react";
import { AlertTriangle, Paintbrush } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import {
  describeReviewReasons,
  WORKTREE_TIER_LABEL,
  WORKTREE_TIER_TOOLTIP,
  type WorktreeTier,
} from "@traycer-clients/shared/worktree/classify-worktree";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd } from "@/components/ui/kbd";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { WorktreePrPills } from "@/components/worktree/worktree-pr-metadata";
import {
  useEpicSweepWorktreeCandidatesForClient,
  type EpicSweepWorktreeRow,
} from "@/hooks/epic/use-epic-sweep-worktree-candidates-query";
import {
  useEpicSweepWorktrees,
  useSweepingWorktreePaths,
} from "@/hooks/epic/use-epic-sweep-worktrees-mutation";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { useBareKeyClaimer } from "@/lib/keybindings/use-bare-key-claimer";
import { useCompactRelativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

const SWEEP_WORKTREES_REFRESH_TIMEOUT_MS = 20_000;

interface SweepWorktreesDialogProps {
  /**
   * The Tasks being swept. `null` (or empty) keeps the dialog closed and its
   * query off. More than one comes from History's multi-select, and the extra
   * members are load-bearing rather than cosmetic: a worktree shared between
   * two selected Tasks stops counting as "shared".
   */
  readonly epicIds: ReadonlyArray<string> | null;
  /**
   * The host whose worktrees are proven and swept. Worktrees are per HOST, and
   * the sweep's host id is frozen from this client's proof: the Epics list
   * (app chrome) passes the app-wide client; a caller INSIDE an Epic session
   * passes the session's client, so an Epic projected from host A is never
   * offered - or swept of - host B's worktrees during a re-point.
   */
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  /** Title for a single-Task sweep; `null` for bulk or unknown. */
  readonly taskTitle: string | null;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * Same visual family as the Settings ▸ Worktrees tier pills: greens for the
 * proven-safe tiers, amber for Review, muted for the neutral states.
 */
const TIER_PILL_CLASS: Record<WorktreeTier, string> = {
  merged:
    "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/30 dark:text-emerald-300",
  "at-base-commit":
    "border-emerald-600/25 bg-emerald-500/8 text-emerald-700/90 dark:border-emerald-400/25 dark:text-emerald-300/85",
  unreferenced:
    "border-emerald-600/20 bg-emerald-500/5 text-emerald-700/80 dark:border-emerald-400/20 dark:text-emerald-300/70",
  review:
    "border-amber-600/30 bg-amber-500/10 text-amber-700 dark:border-amber-400/30 dark:text-amber-300",
  orphaned: "border-border text-muted-foreground",
  "in-use": "border-border bg-foreground/8 text-muted-foreground",
};

const NOTE_COPY: Record<NonNullable<EpicSweepWorktreeRow["note"]>, string> = {
  shared:
    "Also used by a Task outside this selection — sweeping breaks its binding",
  "in-use": "In use by an active agent or terminal",
  checking: "Still checking — facts unverified",
  "not-landed": "Not proven landed — work here may be lost",
};

/**
 * The Sweep confirmation. EVERY worktree owned by the selected Task(s) is
 * listed once with Settings-grade detail (branch, tier pill, PR chips, path);
 * only the proven-safe rows (Landed / At base commit, exclusively owned by the
 * selection, not busy) start checked. Unproven or shared rows are unchecked but
 * deliberately checkable — sweeping them is the user's conscious call — while
 * busy and still-checking rows are disabled.
 *
 * Self-contained: the History row, History's bulk selection, and the Epic
 * status row all render it with just a list of epic ids.
 */
export function SweepWorktreesDialog(props: SweepWorktreesDialogProps) {
  const { epicIds, taskTitle, onOpenChange } = props;
  const {
    hostId,
    rows,
    isPending,
    isError,
    checkedAt,
    canRefresh,
    refresh: refreshCandidates,
  } = useEpicSweepWorktreeCandidatesForClient(props.hostClient, epicIds);
  const taskCount = epicIds?.length ?? 0;
  const sweepMutation = useEpicSweepWorktrees();
  const refresh = useRefreshSpinner({
    onRefresh: refreshCandidates,
    externalRefreshing: isPending,
    timeoutMs: SWEEP_WORKTREES_REFRESH_TIMEOUT_MS,
  });
  const triggerRefresh = refresh.trigger;
  const claimRefreshKey = useBareKeyClaimer("r", (event) => {
    event.preventDefault();
    triggerRefresh();
  });
  useEffect(
    () => (taskCount > 0 && canRefresh ? claimRefreshKey() : undefined),
    [canRefresh, claimRefreshKey, taskCount],
  );
  // Explicit user toggles, cleared whenever the dialog retargets so a
  // reopened dialog starts from the per-row defaults again (the
  // React-recommended "adjust state during render" idiom).
  const [checkOverrides, setCheckOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  // Keyed on the selection itself so re-opening with a DIFFERENT set of Tasks
  // starts from the per-row defaults again.
  const selectionKey =
    epicIds === null ? null : [...new Set(epicIds)].sort().join(",");
  const [previousSelectionKey, setPreviousSelectionKey] =
    useState(selectionKey);
  if (selectionKey !== previousSelectionKey) {
    setPreviousSelectionKey(selectionKey);
    setCheckOverrides(new Map());
  }
  // Read from the mutation cache, not this instance: the dialog is mounted
  // per surface (History row and task-status strip each render their own), so
  // a component-local `isPending` would miss a run started from the other one
  // and happily re-stream the same paths.
  const sweepingPaths = useSweepingWorktreePaths(hostId);
  const isRowSweeping = (row: EpicSweepWorktreeRow): boolean =>
    sweepingPaths.has(row.entry.worktreePath);
  const isRowChecked = (row: EpicSweepWorktreeRow): boolean => {
    if (row.disabled || isRowSweeping(row)) return false;
    return checkOverrides.get(row.entry.worktreePath) ?? row.defaultChecked;
  };
  const checkedRows = rows.filter(isRowChecked);
  // Only THIS dialog's own run disables the whole form; a sweep of some other
  // Task's worktrees just removes its own paths from selection above.
  const isSweeping = sweepMutation.isPending;

  const handleConfirm = () => {
    if (hostId === null || checkedRows.length === 0) return;
    // Background model, matching Settings worktree deletion: confirm hands
    // the streamed run off and closes immediately. The mutation acknowledges
    // the kickoff and reports the outcome via toasts; re-opening while the
    // run is live keeps Sweep disabled so the same paths can't double-stream.
    sweepMutation.mutate({
      hostId,
      worktrees: checkedRows.map((row) => ({
        worktreePath: row.entry.worktreePath,
        branch: row.entry.branch,
        repoIdentifier: row.entry.repoIdentifier,
      })),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={taskCount > 0} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(90dvh,42rem)] w-[min(92vw,34rem)] min-w-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
        data-testid="sweep-worktrees-dialog"
      >
        <div className="flex min-w-0 shrink-0 items-start gap-3 px-5 pt-5 pb-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15">
            <Paintbrush className="size-4" aria-hidden />
          </div>
          <div className="min-h-0 min-w-0 flex-1 space-y-1.5">
            <DialogTitle className="text-ui font-semibold leading-snug wrap-anywhere">
              {sweepDialogTitle(taskCount, taskTitle)}
            </DialogTitle>
            <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground wrap-anywhere">
              Removes the selected worktrees and their branches from this host.
              Worktrees proven landed or still at their base commit are
              pre-selected; anything else may carry unmerged work — select it
              only deliberately. This cannot be undone.
            </DialogDescription>
          </div>
        </div>

        <TooltipProvider>
          <section
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-t border-border/60 bg-foreground/2 px-5 py-4"
            data-testid="sweep-worktrees-candidates"
          >
            <SweepRowList
              isPending={isPending}
              isError={isError}
              rows={rows}
              isRowChecked={isRowChecked}
              isRowSweeping={isRowSweeping}
              interactionDisabled={isSweeping || refresh.refreshing}
              onToggle={(path, checked) => {
                setCheckOverrides((prev) => {
                  const next = new Map(prev);
                  next.set(path, checked);
                  return next;
                });
              }}
            />
            <SweepWorktreesRefreshFooter
              checkedAt={checkedAt}
              refreshing={refresh.refreshing}
              canRefresh={canRefresh}
              onRefresh={triggerRefresh}
            />
          </section>
        </TooltipProvider>

        <div className="grid min-w-0 shrink-0 grid-cols-2 gap-2 border-t border-border/60 bg-foreground/3 px-5 py-3 sm:flex sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            data-testid="sweep-worktrees-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="w-full sm:w-auto"
            disabled={
              hostId === null ||
              isSweeping ||
              refresh.refreshing ||
              checkedRows.length === 0
            }
            onClick={handleConfirm}
            data-testid="sweep-worktrees-confirm"
          >
            {isSweeping ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Sweep
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SweepWorktreesRefreshFooter(props: {
  readonly checkedAt: number | null;
  readonly refreshing: boolean;
  readonly canRefresh: boolean;
  readonly onRefresh: () => void;
}): ReactNode {
  return (
    <div
      className="mt-3 flex shrink-0 items-center justify-between gap-2 border-t border-border/25 pt-1.5"
      data-testid="sweep-worktrees-refresh-footer"
    >
      <SweepWorktreesCheckedAt
        checkedAt={props.checkedAt}
        refreshing={props.refreshing}
      />
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label="Refresh worktree details"
        aria-keyshortcuts="R"
        disabled={!props.canRefresh || props.refreshing}
        onClick={props.onRefresh}
        data-testid="sweep-worktrees-refresh"
      >
        {props.refreshing ? (
          <AgentSpinningDots
            className="text-muted-foreground"
            testId="sweep-worktrees-refresh-spinner"
            variant={undefined}
          />
        ) : null}
        Refresh
        <Kbd className="ml-0.5 font-mono">R</Kbd>
      </Button>
    </div>
  );
}

function SweepWorktreesCheckedAt(props: {
  readonly checkedAt: number | null;
  readonly refreshing: boolean;
}): ReactNode {
  if (props.refreshing) {
    return <span className="text-ui-xs text-muted-foreground">Checking…</span>;
  }
  if (props.checkedAt === null) return <span />;
  return <SweepWorktreesCheckedAtText checkedAt={props.checkedAt} />;
}

function SweepWorktreesCheckedAtText(props: {
  readonly checkedAt: number;
}): ReactNode {
  const relative = useCompactRelativeTime(props.checkedAt);
  return (
    <span
      className="text-ui-xs whitespace-nowrap text-muted-foreground"
      data-testid="sweep-worktrees-checked-at"
    >
      Workspace snapshot · {relative}
    </span>
  );
}

/**
 * Names what is being swept. A single Task uses its title when we have one;
 * a bulk sweep names the count instead, because listing titles would push the
 * worktree list (the thing being confirmed) below the fold.
 */
function sweepDialogTitle(taskCount: number, taskTitle: string | null): string {
  if (taskCount > 1) return `Sweep worktrees for ${taskCount} tasks?`;
  return taskTitle === null
    ? "Sweep worktrees?"
    : `Sweep worktrees for "${taskTitle}"?`;
}

function SweepRowList(props: {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly rows: ReadonlyArray<EpicSweepWorktreeRow>;
  readonly isRowChecked: (row: EpicSweepWorktreeRow) => boolean;
  readonly isRowSweeping: (row: EpicSweepWorktreeRow) => boolean;
  readonly interactionDisabled: boolean;
  readonly onToggle: (worktreePath: string, checked: boolean) => void;
}) {
  if (props.isPending) {
    return (
      <div className="flex items-center gap-2 py-2 text-ui-sm text-muted-foreground">
        <AgentSpinningDots
          variant="dots"
          className="text-muted-foreground"
          testId={undefined}
        />
        Checking worktrees…
      </div>
    );
  }
  if (props.rows.length === 0) {
    return (
      <p
        className="py-2 text-ui-sm text-muted-foreground"
        data-testid="sweep-worktrees-empty"
      >
        {props.isError
          ? "Couldn't check these worktrees. Try again from Settings ▸ Worktrees."
          : "No worktrees on this host for the selected tasks."}
      </p>
    );
  }
  return (
    <ul className="flex min-h-0 min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain rounded-lg border border-border/60 bg-background/40 p-1">
      {props.rows.map((row) => (
        <SweepWorktreeRowItem
          key={row.entry.worktreePath}
          row={row}
          checked={props.isRowChecked(row)}
          isSweeping={props.isRowSweeping(row)}
          interactionDisabled={props.interactionDisabled}
          onToggle={props.onToggle}
        />
      ))}
    </ul>
  );
}

function SweepWorktreeRowItem(props: {
  readonly row: EpicSweepWorktreeRow;
  readonly checked: boolean;
  /** A sweep of this exact path is already streaming (from any surface). */
  readonly isSweeping: boolean;
  readonly interactionDisabled: boolean;
  readonly onToggle: (worktreePath: string, checked: boolean) => void;
}) {
  const { row, checked, isSweeping, interactionDisabled, onToggle } = props;
  const entry = row.entry;
  const branch = entry.branch ?? "detached HEAD";
  const disabled = row.disabled || interactionDisabled || isSweeping;
  // Derived from `useId`, never from the path: a worktree path can contain
  // spaces (routine on Windows, e.g. `C:\\Users\\John Doe\\wt`), which makes an
  // invalid HTML id and silently breaks the `htmlFor` association below - the
  // branch text would stop toggling the row.
  const checkboxId = useId();
  // The PR pills render external links, so they must NOT sit inside the
  // <label>: clicking one would toggle the checkbox (and nesting interactive
  // content in a label is invalid). Only the text half is label-wrapped.
  return (
    <li
      className={cn(
        "flex min-w-0 items-start gap-3 rounded-md px-2.5 py-2 transition-colors hover:bg-accent/40",
        disabled && "opacity-60",
      )}
    >
      <Checkbox
        id={checkboxId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) =>
          onToggle(entry.worktreePath, value === true)
        }
        className="mt-0.5"
        aria-label={`Sweep worktree ${branch}`}
        data-testid="sweep-worktrees-checkbox"
      />
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm text-foreground">
          <label
            htmlFor={checkboxId}
            className={cn(
              "font-medium wrap-anywhere",
              disabled ? "cursor-not-allowed" : "cursor-pointer",
            )}
          >
            {branch}
          </label>
          <span className="text-ui-xs text-muted-foreground wrap-anywhere">
            {entry.repoLabel}
          </span>
          <SweepTierPill row={row} />
          <WorktreePrPills
            worktrees={[entry]}
            detailOnHover
            maximumVisible={2}
            className="max-w-full overflow-hidden"
            testId={`sweep-worktrees-prs-${entry.worktreePath}`}
            openPrInApp={null}
          />
        </div>
        {/* The path is truncated to keep rows scannable, so the full value
            rides a tooltip rather than the native `title` attribute. */}
        <TooltipWrapper
          label={entry.worktreePath}
          side="bottom"
          sideOffset={undefined}
          align="start"
        >
          <span className="mt-1 block max-w-full truncate font-mono text-ui-xs text-muted-foreground">
            {entry.worktreePath}
          </span>
        </TooltipWrapper>
        <SweepRowHint row={row} />
      </div>
    </li>
  );
}

function SweepTierPill(props: { readonly row: EpicSweepWorktreeRow }) {
  const { row } = props;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "shrink-0 rounded-full border px-1.5 text-ui-xs",
            TIER_PILL_CLASS[row.tier],
          )}
          data-testid="sweep-worktrees-tier"
        >
          {WORKTREE_TIER_LABEL[row.tier]}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[min(90vw,24rem)]">
        {WORKTREE_TIER_TOOLTIP[row.tier]}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The per-row caution line: the row's note, plus the classifier's specific
 * Review blockers (uncommitted counts, unmerged commits, submodule branches)
 * so an unchecked row names exactly what checking it would lose.
 */
function SweepRowHint(props: {
  readonly row: EpicSweepWorktreeRow;
}): ReactNode {
  const { row } = props;
  if (row.note === null) return null;
  const reviewReasons =
    row.note === "not-landed" ? describeReviewReasons(row.entry) : [];
  const detail =
    reviewReasons.length > 0
      ? `${NOTE_COPY[row.note]}: ${reviewReasons.join("; ")}`
      : NOTE_COPY[row.note];
  const cautious = row.note === "not-landed" || row.note === "shared";
  return (
    <span
      className={cn(
        "mt-0.5 flex items-start gap-1 text-ui-xs",
        cautious
          ? "text-amber-600 dark:text-amber-400"
          : "text-muted-foreground",
      )}
      data-testid="sweep-worktrees-hint"
    >
      {cautious ? (
        <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
      ) : null}
      <span className="min-w-0 wrap-anywhere">{detail}</span>
    </span>
  );
}
