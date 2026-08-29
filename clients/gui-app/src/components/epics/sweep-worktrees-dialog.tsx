import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, Paintbrush } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import {
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
import { SelectAllToggle } from "@/components/ui/select-all-toggle";
import { TeardownInlineDisclosure } from "@/components/worktree/teardown-disclosure";
import { SweepWorktreesReview } from "@/components/epics/sweep-worktrees-review";
import {
  useEpicSweepWorktreeCandidatesForClient,
  type EpicSweepWorktreeRow,
} from "@/hooks/epic/use-epic-sweep-worktree-candidates-query";
import {
  useEpicSweepWorktrees,
  useSweepingWorktreePaths,
  type SweepWorktreesResult,
} from "@/hooks/epic/use-epic-sweep-worktrees-mutation";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { useWorktreeTaskTitles } from "@/components/settings/panels/use-worktree-task-titles";
import { useBareKeyClaimer } from "@/lib/keybindings/use-bare-key-claimer";
import { isEditableEventTarget } from "@/lib/keybindings/editable-target";
import { useCompactRelativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  bannersFromSessionOutcomes,
  captureReviewSnapshot,
  isBulkScopeRow,
  mergeSessionOutcomes,
  reconcileSessionOutcomes,
  safeSummaryCopy,
  selectionIsSafeOnly,
  selectAllCountCopy,
  sharedRowHint,
  unprovenRowHint,
  unknownConsequenceForRow,
  worktreeIdentity,
  type SweepReviewSnapshot,
  type SweepSessionOutcome,
} from "@/lib/epics/sweep-consequences";
import { useTeardownAgentNames } from "@/lib/worktree/teardown-agent-names";
import {
  formatUncheckedInUseKnown,
  formatUncheckedInUseUnknown,
  sanitizeHoldersRevision,
} from "@/lib/worktree/teardown-holder-copy";

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
  shared: "Also used by a Task outside this sweep",
  "in-use": "In use",
  checking: "Still checking — facts unverified",
  "not-landed": "Not proven landed — work here may be lost",
};

/**
 * The Sweep confirmation. EVERY worktree owned by the selected Task(s) is
 * listed once with Settings-grade detail (branch, tier pill, PR chips, path);
 * only the proven-safe rows (Landed / At base commit, exclusively owned by the
 * selection, not busy) start checked. Unproven, shared, or in-use rows are
 * unchecked but deliberately checkable — sweeping them is the user's conscious
 * call — while still-checking rows are disabled. Selecting an in-use row
 * surfaces the shared holder disclosure; confirm carries stopOwners for those
 * paths.
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
    onRefresh: async () => {
      const fresh = await refreshCandidates();
      setSessionOutcomes((current) => reconcileSessionOutcomes(current, fresh));
    },
    externalRefreshing: isPending,
    timeoutMs: SWEEP_WORKTREES_REFRESH_TIMEOUT_MS,
  });
  const triggerRefresh = refresh.trigger;
  const [step, setStep] = useState<"choose" | "review">("choose");
  const [reviewSnapshot, setReviewSnapshot] =
    useState<SweepReviewSnapshot | null>(null);
  const [typedSweep, setTypedSweep] = useState("");
  const [inventoryChanged, setInventoryChanged] = useState(false);
  const [sessionOutcomes, setSessionOutcomes] = useState<
    ReadonlyMap<string, SweepSessionOutcome>
  >(() => new Map());
  const reviewRefreshGate = useRef(false);
  const claimRefreshKey = useBareKeyClaimer("r", (event) => {
    event.preventDefault();
    triggerRefresh();
  });
  useEffect(
    () =>
      taskCount > 0 && canRefresh && step === "choose"
        ? claimRefreshKey()
        : undefined,
    [canRefresh, claimRefreshKey, step, taskCount],
  );
  const [checkOverrides, setCheckOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  const selectionKey = sweepSessionKey(hostId, epicIds);
  const [previousSelectionKey, setPreviousSelectionKey] =
    useState(selectionKey);
  const [previousInUseByPath, setPreviousInUseByPath] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  const selectionRetargeted = selectionKey !== previousSelectionKey;
  applySelectionRetarget({
    selectionRetargeted,
    selectionKey,
    setPreviousSelectionKey,
    setCheckOverrides,
    setPreviousInUseByPath,
    setStep,
    setReviewSnapshot,
    setTypedSweep,
    setInventoryChanged,
    setSessionOutcomes,
  });
  applyInUseConsentDrop({
    previousInUseByPath,
    rows,
    checkOverrides,
    isPending,
    selectionRetargeted,
    setPreviousInUseByPath,
    setCheckOverrides,
  });
  const sweepingPaths = useSweepingWorktreePaths(hostId);
  const isRowSweeping = (row: EpicSweepWorktreeRow): boolean =>
    sweepingPaths.has(row.entry.worktreePath);
  const sessionOutcomeOf = (
    row: EpicSweepWorktreeRow,
  ): SweepSessionOutcome | undefined =>
    sessionOutcomes.get(row.entry.worktreePath);
  const isRowUncertain = (row: EpicSweepWorktreeRow): boolean =>
    sessionOutcomeOf(row)?.kind === "uncertain";
  const isRowChecked = (row: EpicSweepWorktreeRow): boolean => {
    if (row.disabled || isRowSweeping(row) || isRowUncertain(row)) return false;
    return checkOverrides.get(row.entry.worktreePath) ?? row.defaultChecked;
  };
  const checkedRows = rows.filter(isRowChecked);
  const isSweeping = sweepMutation.isPending;
  const proofReady = !isPending && !isError;
  const bulkRows = rows.filter(
    (row) => isBulkScopeRow(row) && !isRowSweeping(row) && !isRowUncertain(row),
  );
  const bulkSelectedCount = bulkRows.filter(isRowChecked).length;
  const allBulkSelected =
    bulkRows.length > 0 && bulkSelectedCount === bulkRows.length;
  const claimSelectAllKey = useBareKeyClaimer("a", (event) => {
    if (isEditableEventTarget(event.target)) return;
    event.preventDefault();
    toggleSweepSelectAll({
      allBulkSelected,
      bulkRows,
      rows,
      isRowSweeping,
      checkOverrides,
      setCheckOverrides,
    });
  });
  useEffect(
    () =>
      taskCount > 0 && step === "choose" ? claimSelectAllKey() : undefined,
    [claimSelectAllKey, step, taskCount],
  );
  const selectedEpicIds = new Set(epicIds ?? []);
  const disclosedHolders = rows.flatMap((row) =>
    row.note === "in-use" ? [...row.holders] : [],
  );
  const agentNames = useTeardownAgentNames(disclosedHolders);
  const taskTitles = useWorktreeTaskTitles(
    props.hostClient,
    rows.map((row) => row.entry),
  );
  const kickoff = (targets: ReadonlyArray<EpicSweepWorktreeRow>): void => {
    startSweepKickoff({
      hostId,
      targets,
      mutate: sweepMutation.mutate,
      onClose: () => onOpenChange(false),
      onSweepOutcome: (result) => {
        setInventoryChanged(true);
        setTypedSweep("");
        setCheckOverrides((current) =>
          uncheckNonResubmittableOverrides(current, result),
        );
        const identityByPath = identityByPathFromRows(rows, reviewSnapshot);
        const nextOutcomes = mergeSessionOutcomes(
          sessionOutcomes,
          result,
          identityByPath,
        );
        setSessionOutcomes(nextOutcomes);
        setReviewSnapshot((current) =>
          applySweepOutcome(current, result, nextOutcomes),
        );
      },
    });
  };
  const handlePrimary = (): void => {
    startSweepPrimary({
      proofReady,
      hostId,
      checkedRows,
      refreshCandidates,
      kickoff,
      reviewRefreshGate,
      sessionOutcomes,
      setSessionOutcomes,
      setReviewSnapshot,
      setTypedSweep,
      setInventoryChanged,
      setStep,
    });
  };

  return (
    <Dialog open={taskCount > 0} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(90dvh,42rem)] w-[min(92vw,45rem)] min-w-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        data-testid="sweep-worktrees-dialog"
      >
        {step === "review" && reviewSnapshot !== null ? (
          <SweepWorktreesReview
            snapshot={reviewSnapshot}
            selectedEpicIds={selectedEpicIds}
            agentNames={agentNames}
            taskTitles={taskTitles}
            typedValue={typedSweep}
            inventoryChanged={inventoryChanged}
            submitting={isSweeping}
            onTypedValueChange={setTypedSweep}
            onBack={() => {
              setStep("choose");
              setReviewSnapshot(null);
              setTypedSweep("");
              setInventoryChanged(false);
            }}
            onCancel={() => onOpenChange(false)}
            onConfirm={() =>
              kickoff(
                reviewSnapshot.all.filter(
                  (row) =>
                    sessionOutcomes.get(row.entry.worktreePath)?.kind !==
                    "uncertain",
                ),
              )
            }
          />
        ) : (
          <SweepWorktreesChoose
            taskCount={taskCount}
            taskTitle={taskTitle}
            hostId={hostId}
            isPending={isPending}
            isError={isError}
            proofReady={proofReady}
            rows={rows}
            isRowChecked={isRowChecked}
            isRowSweeping={isRowSweeping}
            interactionDisabled={
              isSweeping || refresh.refreshing || !proofReady
            }
            bulkRows={bulkRows}
            bulkSelectedCount={bulkSelectedCount}
            allBulkSelected={allBulkSelected}
            selectedCount={checkedRows.length}
            checkedAt={checkedAt}
            refreshing={refresh.refreshing}
            canRefresh={canRefresh}
            onRefresh={triggerRefresh}
            onToggle={(path, checked) => {
              setCheckOverrides((prev) => {
                const next = new Map(prev);
                next.set(path, checked);
                return next;
              });
            }}
            onToggleSelectAll={() =>
              toggleSweepSelectAll({
                allBulkSelected,
                bulkRows,
                rows,
                isRowSweeping,
                checkOverrides,
                setCheckOverrides,
              })
            }
            onCancel={() => onOpenChange(false)}
            onPrimary={handlePrimary}
            primaryDisabled={
              hostId === null ||
              !proofReady ||
              isSweeping ||
              refresh.refreshing ||
              checkedRows.length === 0
            }
            elevated={!selectionIsSafeOnly(checkedRows)}
            isSweeping={isSweeping}
            selectedEpicIds={selectedEpicIds}
            agentNames={agentNames}
            sessionOutcomes={sessionOutcomes}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Dialog-session identity. Matches the candidates query key
 * (`hostQueryKeys.sweepWorktreeCandidates(hostId, epicKey)`): a host
 * change with the same Task set is a retarget, so host A's uncertain/
 * failed map cannot attach to host B's identically named path.
 */
function sweepSessionKey(
  hostId: string | null,
  epicIds: ReadonlyArray<string> | null,
): string | null {
  if (hostId === null || epicIds === null || epicIds.length === 0) {
    return null;
  }
  return `${hostId}\n${[...new Set(epicIds)].sort().join(",")}`;
}

function applySelectionRetarget(input: {
  readonly selectionRetargeted: boolean;
  readonly selectionKey: string | null;
  readonly setPreviousSelectionKey: (key: string | null) => void;
  readonly setCheckOverrides: (next: ReadonlyMap<string, boolean>) => void;
  readonly setPreviousInUseByPath: (next: ReadonlyMap<string, boolean>) => void;
  readonly setStep: (step: "choose" | "review") => void;
  readonly setReviewSnapshot: (next: SweepReviewSnapshot | null) => void;
  readonly setTypedSweep: (value: string) => void;
  readonly setInventoryChanged: (value: boolean) => void;
  readonly setSessionOutcomes: (
    next: ReadonlyMap<string, SweepSessionOutcome>,
  ) => void;
}): void {
  if (!input.selectionRetargeted) return;
  input.setPreviousSelectionKey(input.selectionKey);
  input.setCheckOverrides(new Map());
  input.setPreviousInUseByPath(new Map());
  input.setStep("choose");
  input.setReviewSnapshot(null);
  input.setTypedSweep("");
  input.setInventoryChanged(false);
  input.setSessionOutcomes(new Map());
}

function applyInUseConsentDrop(input: {
  readonly previousInUseByPath: ReadonlyMap<string, boolean>;
  readonly rows: ReadonlyArray<EpicSweepWorktreeRow>;
  readonly checkOverrides: ReadonlyMap<string, boolean>;
  readonly isPending: boolean;
  readonly selectionRetargeted: boolean;
  readonly setPreviousInUseByPath: (next: ReadonlyMap<string, boolean>) => void;
  readonly setCheckOverrides: (next: ReadonlyMap<string, boolean>) => void;
}): void {
  const inUseTransition = takeInUseFalseToTrueTransition({
    previousInUseByPath: input.previousInUseByPath,
    rows: input.rows,
    checkOverrides: input.checkOverrides,
    isPending: input.isPending,
    selectionRetargeted: input.selectionRetargeted,
  });
  if (inUseTransition === null) return;
  input.setPreviousInUseByPath(inUseTransition.nextInUseByPath);
  if (inUseTransition.droppedForcePaths.length === 0) return;
  input.setCheckOverrides(
    withoutOverridePaths(
      input.checkOverrides,
      inUseTransition.droppedForcePaths,
    ),
  );
}

function startSweepPrimary(input: {
  readonly proofReady: boolean;
  readonly hostId: string | null;
  readonly checkedRows: ReadonlyArray<EpicSweepWorktreeRow>;
  readonly refreshCandidates: () => Promise<
    ReadonlyArray<EpicSweepWorktreeRow>
  >;
  readonly kickoff: (targets: ReadonlyArray<EpicSweepWorktreeRow>) => void;
  readonly reviewRefreshGate: { current: boolean };
  readonly sessionOutcomes: ReadonlyMap<string, SweepSessionOutcome>;
  readonly setSessionOutcomes: (
    next: ReadonlyMap<string, SweepSessionOutcome>,
  ) => void;
  readonly setReviewSnapshot: (next: SweepReviewSnapshot | null) => void;
  readonly setTypedSweep: (value: string) => void;
  readonly setInventoryChanged: (value: boolean) => void;
  readonly setStep: (step: "choose" | "review") => void;
}): void {
  if (
    !input.proofReady ||
    input.hostId === null ||
    input.checkedRows.length === 0
  ) {
    return;
  }
  if (selectionIsSafeOnly(input.checkedRows)) {
    input.kickoff(input.checkedRows);
    return;
  }
  if (input.reviewRefreshGate.current) return;
  const selectedPaths = new Set(
    input.checkedRows.map((row) => row.entry.worktreePath),
  );
  const previouslyInUse = new Set(
    input.checkedRows
      .filter((row) => row.note === "in-use")
      .map((row) => row.entry.worktreePath),
  );
  input.reviewRefreshGate.current = true;
  void input
    .refreshCandidates()
    .then((freshRows) => {
      const nextOutcomes = reconcileSessionOutcomes(
        input.sessionOutcomes,
        freshRows,
      );
      input.setSessionOutcomes(nextOutcomes);
      const selected = freshRows.filter((row) => {
        if (!selectedPaths.has(row.entry.worktreePath) || row.disabled) {
          return false;
        }
        if (nextOutcomes.get(row.entry.worktreePath)?.kind === "uncertain") {
          return false;
        }
        if (
          row.note === "in-use" &&
          !previouslyInUse.has(row.entry.worktreePath)
        ) {
          return false;
        }
        return true;
      });
      if (selected.length === 0) return;
      if (selectionIsSafeOnly(selected)) {
        input.kickoff(selected);
        return;
      }
      input.setReviewSnapshot(
        captureReviewSnapshot(
          selected,
          bannersFromSessionOutcomes(nextOutcomes),
        ),
      );
      input.setTypedSweep("");
      input.setInventoryChanged(false);
      input.setStep("review");
    })
    .catch(() => {
      // Hook already toasted. Stay on Choose; do not open a stale receipt.
    })
    .finally(() => {
      input.reviewRefreshGate.current = false;
    });
}

function startSweepKickoff(input: {
  readonly hostId: string | null;
  readonly targets: ReadonlyArray<EpicSweepWorktreeRow>;
  readonly mutate: ReturnType<typeof useEpicSweepWorktrees>["mutate"];
  readonly onClose: () => void;
  readonly onSweepOutcome: (result: SweepWorktreesResult) => void;
}): void {
  if (input.hostId === null) return;
  input.mutate(
    {
      hostId: input.hostId,
      worktrees: input.targets.map((row) => ({
        worktreePath: row.entry.worktreePath,
        branch: row.entry.branch,
        repoIdentifier: row.entry.repoIdentifier,
        stopOwners: row.entry.inUse,
        expectedHoldersRevision:
          row.note === "in-use"
            ? sanitizeHoldersRevision(row.holdersRevision)
            : undefined,
      })),
    },
    {
      onSuccess: (result) => {
        if (result.holdersChanged.length === 0) {
          input.onClose();
          return;
        }
        input.onSweepOutcome(result);
      },
    },
  );
}

function toggleSweepSelectAll(input: {
  readonly allBulkSelected: boolean;
  readonly bulkRows: ReadonlyArray<EpicSweepWorktreeRow>;
  readonly rows: ReadonlyArray<EpicSweepWorktreeRow>;
  readonly isRowSweeping: (row: EpicSweepWorktreeRow) => boolean;
  readonly checkOverrides: ReadonlyMap<string, boolean>;
  readonly setCheckOverrides: (next: ReadonlyMap<string, boolean>) => void;
}): void {
  if (input.allBulkSelected) {
    const next = new Map<string, boolean>();
    for (const row of input.rows) {
      if (!row.disabled && !input.isRowSweeping(row)) {
        next.set(row.entry.worktreePath, false);
      }
    }
    input.setCheckOverrides(next);
    return;
  }
  const next = new Map(input.checkOverrides);
  for (const row of input.bulkRows) {
    next.set(row.entry.worktreePath, true);
  }
  input.setCheckOverrides(next);
}

function applySweepOutcome(
  current: SweepReviewSnapshot | null,
  result: SweepWorktreesResult,
  sessionOutcomes: ReadonlyMap<string, SweepSessionOutcome>,
): SweepReviewSnapshot | null {
  if (current === null) return current;
  const removed = new Set(result.removed);
  const remaining = current.all.filter((row) => {
    const path = row.entry.worktreePath;
    if (removed.has(path)) return false;
    const outcome = sessionOutcomes.get(path);
    if (outcome?.kind === "uncertain") return false;
    if (result.failed.includes(path)) return false;
    return true;
  });
  if (remaining.length === 0) return null;
  const byPath = new Map(
    result.holdersChanged.map((entry) => [entry.worktreePath, entry]),
  );
  const updated = remaining.map((row) => {
    const update = byPath.get(row.entry.worktreePath);
    if (update === undefined) return row;
    const holdersRevision = sanitizeHoldersRevision(update.holdersRevision);
    if (update.holders.length === 0 || holdersRevision === undefined) {
      return {
        ...row,
        holders: [],
        holdersStatus: "unknown" as const,
        holdersRevision: undefined,
      };
    }
    return {
      ...row,
      holders: update.holders,
      holdersStatus: "ready" as const,
      holdersRevision,
    };
  });
  return captureReviewSnapshot(
    updated,
    bannersFromSessionOutcomes(sessionOutcomes),
  );
}

function identityByPathFromRows(
  liveRows: ReadonlyArray<EpicSweepWorktreeRow>,
  snapshot: SweepReviewSnapshot | null,
): ReadonlyMap<string, string> {
  const next = new Map<string, string>();
  for (const row of liveRows) {
    next.set(row.entry.worktreePath, worktreeIdentity(row));
  }
  if (snapshot === null) return next;
  for (const row of snapshot.all) {
    if (!next.has(row.entry.worktreePath)) {
      next.set(row.entry.worktreePath, worktreeIdentity(row));
    }
  }
  return next;
}

function SweepWorktreesChoose(props: {
  readonly taskCount: number;
  readonly taskTitle: string | null;
  readonly hostId: string | null;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly proofReady: boolean;
  readonly rows: ReadonlyArray<EpicSweepWorktreeRow>;
  readonly isRowChecked: (row: EpicSweepWorktreeRow) => boolean;
  readonly isRowSweeping: (row: EpicSweepWorktreeRow) => boolean;
  readonly interactionDisabled: boolean;
  readonly bulkRows: ReadonlyArray<EpicSweepWorktreeRow>;
  readonly bulkSelectedCount: number;
  readonly allBulkSelected: boolean;
  readonly selectedCount: number;
  readonly checkedAt: number | null;
  readonly refreshing: boolean;
  readonly canRefresh: boolean;
  readonly onRefresh: () => void;
  readonly onToggle: (path: string, checked: boolean) => void;
  readonly onToggleSelectAll: () => void;
  readonly onCancel: () => void;
  readonly onPrimary: () => void;
  readonly primaryDisabled: boolean;
  readonly elevated: boolean;
  readonly isSweeping: boolean;
  readonly selectedEpicIds: ReadonlySet<string>;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly sessionOutcomes: ReadonlyMap<string, SweepSessionOutcome>;
}): ReactNode {
  return (
    <>
      <div className="flex min-w-0 shrink-0 items-start gap-3 px-5 pt-5 pb-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15">
          <Paintbrush className="size-4" aria-hidden />
        </div>
        <div className="min-h-0 min-w-0 flex-1 space-y-1.5">
          <DialogTitle className="text-ui font-semibold leading-snug wrap-anywhere">
            {sweepDialogTitle(props.taskCount, props.taskTitle)}
          </DialogTitle>
          <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground wrap-anywhere">
            Choose the worktrees to remove from this host. Proven-safe worktrees
            are selected for you.
          </DialogDescription>
        </div>
      </div>
      <TooltipProvider>
        <section
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-t border-border/60 bg-foreground/2 px-5 py-4"
          data-testid="sweep-worktrees-candidates"
        >
          <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
            <SelectAllToggle
              accessibleLabel={
                props.allBulkSelected ? "Deselect all" : "Select all"
              }
              selectableCount={props.bulkRows.length}
              selectedCount={props.bulkSelectedCount}
              disabled={
                props.interactionDisabled || props.bulkRows.length === 0
              }
              testId="sweep-worktrees-select-all"
              onToggle={props.onToggleSelectAll}
              actionLabel={
                props.allBulkSelected ? "Deselect all" : "Select all"
              }
              shortcut="A"
            />
            <span
              className="text-ui-xs text-muted-foreground"
              data-testid="sweep-worktrees-count"
            >
              {selectAllCountCopy({
                selected: props.selectedCount,
                total: props.rows.length,
              })}
            </span>
          </div>
          <SweepRowList
            isPending={props.isPending}
            isError={props.isError}
            rows={props.rows}
            isRowChecked={props.isRowChecked}
            isRowSweeping={props.isRowSweeping}
            interactionDisabled={props.interactionDisabled}
            selectedEpicIds={props.selectedEpicIds}
            agentNames={props.agentNames}
            sessionOutcomes={props.sessionOutcomes}
            onToggle={props.onToggle}
          />
          {!props.elevated &&
          props.proofReady &&
          props.selectedCount > 0 &&
          !props.isPending ? (
            <p
              className="mt-2 text-ui-xs text-muted-foreground wrap-anywhere"
              data-testid="sweep-worktrees-safe-summary"
            >
              {safeSummaryCopy(
                props.selectedCount,
                props.rows.filter(
                  (row) => props.isRowChecked(row) && row.entry.branch !== null,
                ).length,
              )}
            </p>
          ) : null}
          <SweepWorktreesRefreshFooter
            checkedAt={props.checkedAt}
            refreshing={props.refreshing}
            canRefresh={props.canRefresh}
            onRefresh={props.onRefresh}
          />
        </section>
      </TooltipProvider>
      <div className="grid min-w-0 shrink-0 grid-cols-2 gap-2 border-t border-border/60 bg-foreground/3 px-5 py-3 sm:flex sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full sm:w-auto"
          onClick={props.onCancel}
          data-testid="sweep-worktrees-cancel"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant={props.elevated ? "default" : "destructive"}
          size="sm"
          className="w-full sm:w-auto"
          disabled={props.primaryDisabled}
          onClick={props.onPrimary}
          data-testid="sweep-worktrees-confirm"
        >
          {props.isSweeping ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          {props.elevated ? "Review consequences" : "Sweep selected"}
          {props.elevated ? (
            <ArrowRight className="size-3.5" aria-hidden />
          ) : null}
        </Button>
      </div>
    </>
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
  if (props.checkedAt !== null) {
    return <SweepWorktreesCheckedAtText checkedAt={props.checkedAt} />;
  }
  return props.refreshing ? (
    <span className="text-ui-xs text-muted-foreground">Checking…</span>
  ) : (
    <span />
  );
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

function inUseByPathFromRows(
  rows: ReadonlyArray<EpicSweepWorktreeRow>,
): ReadonlyMap<string, boolean> {
  const next = new Map<string, boolean>();
  for (const row of rows) {
    next.set(row.entry.worktreePath, row.entry.inUse);
  }
  return next;
}

function inUseByPathEqual(
  left: ReadonlyMap<string, boolean>,
  right: ReadonlyMap<string, boolean>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [path, inUse] of right) {
    if (left.get(path) !== inUse) return false;
  }
  return true;
}

function takeInUseFalseToTrueTransition(input: {
  readonly previousInUseByPath: ReadonlyMap<string, boolean>;
  readonly rows: ReadonlyArray<EpicSweepWorktreeRow>;
  readonly checkOverrides: ReadonlyMap<string, boolean>;
  readonly isPending: boolean;
  readonly selectionRetargeted: boolean;
}): {
  readonly nextInUseByPath: ReadonlyMap<string, boolean>;
  readonly droppedForcePaths: readonly string[];
} | null {
  // Skip in-flight empty snapshots so a later inUse false→true still
  // compares against the last proven idle value, not "path unseen".
  // Completed empty/error results are real: merge (absent paths keep
  // their last proven inUse) and drop overrides for vanished paths so
  // a reappearance is a new object, not inherited consent.
  if (input.selectionRetargeted || input.isPending) return null;
  const seenInUseByPath = inUseByPathFromRows(input.rows);
  const nextInUseByPath = new Map(input.previousInUseByPath);
  const droppedForcePaths: string[] = [];
  for (const path of input.previousInUseByPath.keys()) {
    if (!seenInUseByPath.has(path) && input.checkOverrides.has(path)) {
      droppedForcePaths.push(path);
    }
  }
  for (const [path, inUse] of seenInUseByPath) {
    nextInUseByPath.set(path, inUse);
    if (inUse && input.previousInUseByPath.get(path) === false) {
      droppedForcePaths.push(path);
    }
  }
  if (
    droppedForcePaths.length === 0 &&
    inUseByPathEqual(input.previousInUseByPath, nextInUseByPath)
  ) {
    return null;
  }
  return { nextInUseByPath, droppedForcePaths };
}

function withoutOverridePaths(
  overrides: ReadonlyMap<string, boolean>,
  paths: readonly string[],
): ReadonlyMap<string, boolean> {
  const next = new Map(overrides);
  let changed = false;
  for (const path of paths) {
    if (next.delete(path)) changed = true;
  }
  return changed ? next : overrides;
}

function uncheckNonResubmittableOverrides(
  overrides: ReadonlyMap<string, boolean>,
  result: SweepWorktreesResult,
): ReadonlyMap<string, boolean> {
  const next = new Map(withoutOverridePaths(overrides, result.removed));
  for (const path of result.uncertain) {
    next.set(path, false);
  }
  for (const path of result.failed) {
    next.set(path, false);
  }
  return next;
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
  readonly selectedEpicIds: ReadonlySet<string>;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly sessionOutcomes: ReadonlyMap<string, SweepSessionOutcome>;
  readonly onToggle: (worktreePath: string, checked: boolean) => void;
}) {
  if (props.isPending && props.rows.length === 0) {
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
          selectedEpicIds={props.selectedEpicIds}
          agentNames={props.agentNames}
          sessionOutcome={props.sessionOutcomes.get(row.entry.worktreePath)}
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
  readonly selectedEpicIds: ReadonlySet<string>;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly sessionOutcome: SweepSessionOutcome | undefined;
  readonly onToggle: (worktreePath: string, checked: boolean) => void;
}) {
  const { row, checked, isSweeping, interactionDisabled, onToggle } = props;
  const entry = row.entry;
  const branch = entry.branch ?? "detached HEAD";
  const uncertainLocked = props.sessionOutcome?.kind === "uncertain";
  const disabled =
    row.disabled || interactionDisabled || isSweeping || uncertainLocked;
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
        <SweepRowHint
          row={row}
          checked={checked}
          selectedEpicIds={props.selectedEpicIds}
          sessionOutcome={props.sessionOutcome}
        />
        {checked && row.note === "in-use" ? (
          <TeardownInlineDisclosure
            holders={row.holders}
            heading="Stopping work on this worktree"
            agentNames={props.agentNames}
            unknownConsequence={unknownConsequenceForRow(row)}
          />
        ) : null}
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
function sessionOutcomeHint(
  outcome: SweepSessionOutcome | undefined,
): ReactNode {
  if (outcome === undefined) return null;
  if (outcome.kind === "uncertain") {
    return (
      <span
        className="mt-0.5 flex items-start gap-1 text-ui-xs text-amber-600 dark:text-amber-400"
        data-testid="sweep-worktrees-row-outcome"
      >
        <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span className="min-w-0 wrap-anywhere">
          Unconfirmed — check the worktree. This deletion is not being retried.
        </span>
      </span>
    );
  }
  return (
    <span
      className="mt-0.5 flex items-start gap-1 text-ui-xs text-destructive"
      data-testid="sweep-worktrees-row-outcome"
    >
      <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span className="min-w-0 wrap-anywhere">
        {`Couldn't be removed — select again to retry.`}
      </span>
    </span>
  );
}

function SweepRowHint(props: {
  readonly row: EpicSweepWorktreeRow;
  readonly checked: boolean;
  readonly selectedEpicIds: ReadonlySet<string>;
  readonly sessionOutcome: SweepSessionOutcome | undefined;
}): ReactNode {
  const { row } = props;
  const outcomeHint = sessionOutcomeHint(props.sessionOutcome);
  if (outcomeHint !== null) return outcomeHint;
  if (row.note === null) return null;
  let detail: string = NOTE_COPY[row.note];
  if (row.note === "not-landed") {
    detail = unprovenRowHint(row);
  } else if (row.note === "shared") {
    detail = sharedRowHint(row, props.selectedEpicIds);
  } else if (row.note === "in-use" && !props.checked) {
    if (row.holdersStatus === "unknown") {
      detail = formatUncheckedInUseUnknown();
    } else if (row.holdersStatus === "ready") {
      detail = formatUncheckedInUseKnown(row.holders.length);
    }
  } else if (row.note === "in-use" && props.checked) {
    detail = "In use · selected for this review";
  }
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
