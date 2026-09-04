import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Paintbrush } from "lucide-react";
import { toast } from "sonner";
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
  SweepHostChoiceScope,
  type SweepHostChoice,
  type SweepHostChoiceView,
} from "@/components/epics/sweep-host-chip";
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
  removeButtonLabel,
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
import {
  useSweepSessionStore,
  type ParkedSweepReview,
} from "@/stores/epics/sweep-session-store";
import { useTeardownAgentNames } from "@/lib/worktree/teardown-agent-names";
import {
  formatUncheckedInUseKnown,
  formatUncheckedInUseUnknown,
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
  /**
   * The host decision this dialog CARRIES, or `null` when there is none to
   * carry - one usable host in the fleet, which is every single-host install.
   *
   * `null` is the byte-identical path on purpose: no chip, no nudge, no fleet
   * list mounted, and the same empty-state sentence Sweep has always shown.
   * Everything the choice adds is inside this one branch.
   */
  readonly hostChoice: SweepHostChoice | null;
  /**
   * The fleet has not been described yet, so nothing about the host has been
   * decided — not even whether there is a choice to make.
   *
   * Distinct from `hostChoice === null`, which is the settled answer "this
   * account has one usable host". A dialog that conflated them would show a
   * single-host install's empty-census sentence for the length of a directory
   * query, claiming a disk nobody has walked.
   */
  readonly fleetPending: boolean;
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
  // Read before the session key, because the key needs it: an OPEN dialog with
  // no host is a session in its own right, not the gap between two.
  //
  // Asked of the whole dialog rather than of `hostChoice`'s shape, which is
  // the generalisation both hostless states needed. There are two ways to be
  // open without a host and they arrive differently - the fleet has not been
  // described (`fleetPending`, which carries NO `hostChoice` at all), or it has
  // and nobody has picked yet (`hostChoice.hostId === null`) - so a rule
  // written against one of those shapes silently missed the other.
  const hostUnchosen =
    props.hostChoice !== null && props.hostChoice.hostId === null;
  const hostlessSession = props.fleetPending || hostUnchosen;
  const {
    hostId,
    rows,
    isPending,
    isError,
    checkedAt,
    canRefresh,
    refresh: refreshCandidates,
    prove: proveCandidates,
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
  const [inventoryChanged, setInventoryChanged] = useState(false);
  const [sessionOutcomes, setSessionOutcomes] = useState<
    ReadonlyMap<string, SweepSessionOutcome>
  >(() => new Map());
  const sessionOutcomesRef = useRef(sessionOutcomes);
  useEffect(() => {
    sessionOutcomesRef.current = sessionOutcomes;
  }, [sessionOutcomes]);
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
  const selectionKey = sweepSessionKey(
    hostlessSession ? HOSTLESS_SESSION : { kind: "host", hostId },
    epicIds,
  );
  const activeSessionKeyRef = useRef(selectionKey);
  useEffect(() => {
    if (selectionKey !== null) {
      activeSessionKeyRef.current = selectionKey;
    }
  }, [selectionKey]);
  const [previousSelectionKey, setPreviousSelectionKey] =
    useState(selectionKey);
  const [previousInUseByPath, setPreviousInUseByPath] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  // Closing disables the candidates query, which temporarily makes the key
  // null. Keep the session parked across that gap so reopening Sweep resumes
  // the same selection, review receipt, and in-flight progress. A genuinely
  // different non-null target still starts a fresh session.
  const selectionRetargeted =
    selectionKey !== null && selectionKey !== previousSelectionKey;
  applySelectionRetarget({
    selectionRetargeted,
    selectionKey,
    setPreviousSelectionKey,
    setCheckOverrides,
    setPreviousInUseByPath,
    setStep,
    setReviewSnapshot,
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
  const proving = useSweepSessionParking({
    selectionKey,
    onParkedReview: (review) => {
      sessionOutcomesRef.current = review.outcomes;
      setSessionOutcomes(review.outcomes);
      setReviewSnapshot(review.snapshot);
      setInventoryChanged(false);
      setStep("review");
    },
  });
  const sweepingPaths = useSweepingWorktreePaths(hostId);
  const activeSweepCount = rows.filter((row) =>
    sweepingPaths.has(row.entry.worktreePath),
  ).length;
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
    const kickoffSessionKey = selectionKey;
    // A confirmed batch is now represented by the per-row shared mutation
    // state. Park the session on Choose before closing so reopening shows the
    // live rows, rather than a spent confirmation receipt.
    setStep("choose");
    setInventoryChanged(false);
    startSweepKickoff({
      hostId,
      epicId: epicIds?.length === 1 ? epicIds[0] : undefined,
      targets,
      mutate: sweepMutation.mutate,
      onClose: () => onOpenChange(false),
      onSweepOutcome: (result) => {
        if (
          kickoffSessionKey === null ||
          activeSessionKeyRef.current !== kickoffSessionKey
        ) {
          return;
        }
        setInventoryChanged(true);
        setCheckOverrides((current) =>
          uncheckNonResubmittableOverrides(current, result),
        );
        const identityByPath = identityByPathFromRows(rows, reviewSnapshot);
        const nextOutcomes = mergeSessionOutcomes(
          sessionOutcomesRef.current,
          // Session outcomes are per-PATH row state; the failure reason rides
          // the toast, not the dialog's re-review model.
          {
            removed: result.removed,
            uncertain: result.uncertain,
            failed: result.failed.map((failure) => failure.worktreePath),
          },
          identityByPath,
        );
        sessionOutcomesRef.current = nextOutcomes;
        setSessionOutcomes(nextOutcomes);
        setReviewSnapshot((current) =>
          applySweepOutcome(current, result, nextOutcomes),
        );
      },
    });
  };
  const handlePrimary = (hostName: string | null): void => {
    startSweepPrimary({
      sessionKey: selectionKey,
      hostId,
      hostName,
      checkedRows,
      prove: proveCandidates,
      kickoff,
      sessionOutcomes,
      setSessionOutcomes,
    });
  };

  const { hostChoice } = props;
  // The host this dialog is pointed at is LATCHED, and its client either
  // resolves or does not. `null` here means the machine the chip names has
  // stopped answering under an open confirmation - which is a thing to say,
  // not a reason to point the dialog somewhere else.
  const hostUnreachable =
    hostChoice !== null &&
    hostChoice.hostId !== null &&
    props.hostClient === null;
  // A Review is a receipt for ONE machine's proof, so it may not be shown
  // without one. `startSweepPrimary` already refuses to ENTER review with no
  // host; this is the other half - a review PARKED from a previous session
  // must not paint over a dialog that has since lost its host, which is a
  // destructive confirmation naming a machine it is no longer pointed at.
  const reviewable =
    step === "review" && reviewSnapshot !== null && hostId !== null;
  const renderBody = (host: SweepHostChoiceView | null): ReactNode =>
    reviewable ? (
      <SweepWorktreesReview
        snapshot={reviewSnapshot}
        selectedEpicIds={selectedEpicIds}
        agentNames={agentNames}
        taskTitles={taskTitles}
        hostName={host?.hostName ?? null}
        inventoryChanged={inventoryChanged}
        activeSweepCount={activeSweepCount}
        onBack={() => {
          setStep("choose");
          setReviewSnapshot(null);
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
        host={host}
        fleetPending={props.fleetPending}
        hostUnchosen={hostUnchosen}
        hostUnreachable={hostUnreachable}
        hostId={hostId}
        isPending={isPending}
        isError={isError}
        proofReady={proofReady}
        rows={rows}
        isRowChecked={isRowChecked}
        isRowSweeping={isRowSweeping}
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
        onPrimary={() => handlePrimary(host?.hostName ?? null)}
        // NOT disabled by a refresh or an unsettled proof: the click itself
        // proves before anything destructive, joining whatever is in flight.
        // Only a click already being answered for this session locks it.
        primaryDisabled={hostId === null || proving || checkedRows.length === 0}
        elevated={!selectionIsSafeOnly(checkedRows)}
        activeSweepCount={activeSweepCount}
        selectedEpicIds={selectedEpicIds}
        agentNames={agentNames}
        sessionOutcomes={sessionOutcomes}
      />
    );

  return (
    <Dialog open={taskCount > 0} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(90dvh,42rem)] w-[min(92vw,45rem)] min-w-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        data-testid="sweep-worktrees-dialog"
      >
        {hostChoice === null ? (
          renderBody(null)
        ) : (
          <SweepHostChoiceScope
            hostId={hostChoice.hostId}
            selectedEpicIds={selectedEpicIds}
            currentHostCount={censusedHostCount({ hostId, isError, rows })}
            unavailableHostId={hostChoice.unavailableHostId}
            // Review has no chip at all - it renders the frozen host read-only
            // and Back is the route to change it - so the review case is
            // structural rather than a disabled control. What is left is the
            // census being unsettled underneath a chip that IS on screen.
            disabled={refresh.refreshing || activeSweepCount > 0}
            hasSelectionOverrides={checkOverrides.size > 0}
            onSwitch={hostChoice.onSwitch}
            render={renderBody}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The flow never holds the user: a Remove click's proof runs as a plain
 * promise chain that outlives the dialog, and the session store is where it
 * leaves its answer. This is the dialog's side of that contract. It says when
 * a dialog is on screen for a session (so the chain knows whether to toast
 * instead of relying on a screen nobody is looking at), reports whether a
 * click is still being answered (so Remove cannot be clicked twice), and
 * hands over a review the chain parked - whether the chain settled while the
 * dialog was open, or after it was closed and reopened on the same session.
 */
function useSweepSessionParking(input: {
  readonly selectionKey: string | null;
  readonly onParkedReview: (review: ParkedSweepReview) => void;
}): boolean {
  const { selectionKey, onParkedReview } = input;
  useEffect(() => {
    if (selectionKey === null) return;
    const store = useSweepSessionStore.getState();
    store.setOpen(selectionKey, true);
    return () => store.setOpen(selectionKey, false);
  }, [selectionKey]);
  const proving = useSweepSessionStore(
    (s) => selectionKey !== null && s.proving.has(selectionKey),
  );
  const parkedReview = useSweepSessionStore((s) =>
    selectionKey === null ? null : (s.parked.get(selectionKey) ?? null),
  );
  // Taken through the store rather than from the subscription's value, so
  // the hand-over is exactly-once even if two renders observe the same park.
  const onParkedReviewRef = useRef(onParkedReview);
  useEffect(() => {
    onParkedReviewRef.current = onParkedReview;
  }, [onParkedReview]);
  useEffect(() => {
    if (selectionKey === null || parkedReview === null) return;
    const taken = useSweepSessionStore.getState().take(selectionKey);
    if (taken !== null) onParkedReviewRef.current(taken);
  }, [parkedReview, selectionKey]);
  return proving;
}

/**
 * The censused host's count for its own popover row: every owned worktree
 * this dialog's walk found, the same attribution the popover asks the OTHER
 * hosts for. Not re-asked, and not claimed while there is no walk to count.
 */
function censusedHostCount(input: {
  readonly hostId: string | null;
  readonly isError: boolean;
  readonly rows: ReadonlyArray<EpicSweepWorktreeRow>;
}): number | null {
  if (input.hostId === null || input.isError) return null;
  return input.rows.length;
}

/**
 * Which host a dialog session is about: one this proof ran against, or none at
 * all.
 *
 * A union rather than a sentinel string, so no host id can ever be mistaken
 * for the hostless case. The distinction is load-bearing: "no host" and "not
 * open" are both absences, and sharing one key made a hostless re-open look
 * like the gap between two opens - the previous host's parked step and Review
 * snapshot survived it, and a person was shown a destructive confirmation for
 * a machine the dialog was no longer pointed at, whose Sweep button silently
 * did nothing.
 *
 * ONE hostless arm covers both ways of getting there - waiting on the fleet,
 * and waiting on a person - because for SESSION purposes they are the same
 * state: no host, no census, and nothing yet to preserve or discard. The copy
 * differs because the reason differs; the identity does not, because the
 * content does not. Splitting them would only add a retarget between two
 * states that have nothing to retarget.
 */
type SweepSessionHost =
  | { readonly kind: "host"; readonly hostId: string | null }
  | { readonly kind: "hostless" };

const HOSTLESS_SESSION: SweepSessionHost = { kind: "hostless" };

/**
 * Dialog-session identity. Matches the candidates query key
 * (`hostQueryKeys.sweepWorktreeCandidates(hostId, epicKey)`): a host
 * change with the same Task set is a retarget, so host A's uncertain/
 * failed map cannot attach to host B's identically named path.
 *
 * `null` means CLOSED — no session at all. An open dialog always has one,
 * including one that has yet to be pointed at a machine.
 */
function sweepSessionKey(
  host: SweepSessionHost,
  epicIds: ReadonlyArray<string> | null,
): string | null {
  if (epicIds === null || epicIds.length === 0) return null;
  const epicKey = [...new Set(epicIds)].sort().join(",");
  if (host.kind === "hostless") return `hostless\n${epicKey}`;
  if (host.hostId === null) return null;
  return `host:${host.hostId}\n${epicKey}`;
}

function applySelectionRetarget(input: {
  readonly selectionRetargeted: boolean;
  readonly selectionKey: string | null;
  readonly setPreviousSelectionKey: (key: string | null) => void;
  readonly setCheckOverrides: (next: ReadonlyMap<string, boolean>) => void;
  readonly setPreviousInUseByPath: (next: ReadonlyMap<string, boolean>) => void;
  readonly setStep: (step: "choose" | "review") => void;
  readonly setReviewSnapshot: (next: SweepReviewSnapshot | null) => void;
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

/**
 * What a Remove click does: record the intent, prove, then either remove or
 * ask - without ever holding the person in the dialog for it.
 *
 * Every click re-proves, the safe-looking selection included. Cached
 * classifications are never the basis for deletion; the proof joins a refresh
 * already in flight or starts a forced one. And the chain is a plain promise,
 * not a per-call mutation callback, so it keeps running if the dialog is
 * closed or the surface it sits on is left (TanStack drops `mutate(vars,
 * { onSuccess })` callbacks on unmount; a `.then` is nobody's to drop). What
 * it decides lands in the session store: a safe selection starts the
 * background removal wherever the person is; one that needs consent is
 * PARKED for the session, and toasted when no dialog is open to show it.
 * Consent is never inferred - a parked review removes nothing until confirmed.
 */
function startSweepPrimary(input: {
  readonly sessionKey: string | null;
  readonly hostId: string | null;
  readonly hostName: string | null;
  readonly checkedRows: ReadonlyArray<EpicSweepWorktreeRow>;
  readonly prove: () => Promise<ReadonlyArray<EpicSweepWorktreeRow>>;
  readonly kickoff: (targets: ReadonlyArray<EpicSweepWorktreeRow>) => void;
  readonly sessionOutcomes: ReadonlyMap<string, SweepSessionOutcome>;
  readonly setSessionOutcomes: (
    next: ReadonlyMap<string, SweepSessionOutcome>,
  ) => void;
}): void {
  const { sessionKey } = input;
  if (
    sessionKey === null ||
    input.hostId === null ||
    input.checkedRows.length === 0
  ) {
    return;
  }
  const store = useSweepSessionStore.getState();
  if (store.proving.has(sessionKey)) return;
  const selectedPaths = new Set(
    input.checkedRows.map((row) => row.entry.worktreePath),
  );
  const previouslyInUse = new Set(
    input.checkedRows
      .filter((row) => row.note === "in-use")
      .map((row) => row.entry.worktreePath),
  );
  store.beginProving(sessionKey);
  void input
    .prove()
    .then((freshRows) => {
      const nextOutcomes = reconcileSessionOutcomes(
        input.sessionOutcomes,
        freshRows,
      );
      input.setSessionOutcomes(nextOutcomes);
      // Reconciled by PATH - the row's identity - so a stale target is never
      // deleted: a row that vanished, turned uncertain, or newly became in
      // use since the click drops out of the intent.
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
      const dialogOpen = useSweepSessionStore.getState().open.has(sessionKey);
      if (selected.length === 0) {
        if (!dialogOpen) {
          toast.info(
            "Nothing was removed — the selected worktrees changed while they were being checked.",
          );
        }
        return;
      }
      if (selectionIsSafeOnly(selected)) {
        input.kickoff(selected);
        return;
      }
      useSweepSessionStore.getState().park(sessionKey, {
        snapshot: captureReviewSnapshot(
          selected,
          bannersFromSessionOutcomes(nextOutcomes),
        ),
        outcomes: nextOutcomes,
      });
      if (!dialogOpen) {
        toast.info(
          input.hostName === null
            ? "Sweep needs your confirmation — open Sweep on these tasks to review."
            : `Sweep on ${input.hostName} needs your confirmation — open Sweep on these tasks to review.`,
        );
      }
    })
    .catch(() => {
      // The proof already toasted. Intent dropped; nothing is removed.
    })
    .finally(() => {
      useSweepSessionStore.getState().endProving(sessionKey);
    });
}

function startSweepKickoff(input: {
  readonly hostId: string | null;
  readonly epicId: string | undefined;
  readonly targets: ReadonlyArray<EpicSweepWorktreeRow>;
  readonly mutate: ReturnType<typeof useEpicSweepWorktrees>["mutate"];
  readonly onClose: () => void;
  readonly onSweepOutcome: (result: SweepWorktreesResult) => void;
}): void {
  if (input.hostId === null) return;
  input.mutate(
    {
      hostId: input.hostId,
      epicId: input.epicId,
      worktrees: input.targets.map((row) => ({
        worktreePath: row.entry.worktreePath,
        branch: row.entry.branch,
        repoIdentifier: row.entry.repoIdentifier,
        stopOwners: row.entry.inUse,
      })),
    },
    {
      onSuccess: (result) => {
        input.onSweepOutcome(result);
      },
    },
  );
  // The mutation cache owns the run after kickoff. Do not hold the user in a
  // modal while the host streams cleanup; reopening reads that shared pending
  // state and resumes this dialog session.
  input.onClose();
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
    if (result.failed.some((failure) => failure.worktreePath === path)) {
      return false;
    }
    return true;
  });
  if (remaining.length === 0) return null;
  return captureReviewSnapshot(
    remaining,
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
  /** The host decision, name-resolved; `null` on a single-host fleet. */
  readonly host: SweepHostChoiceView | null;
  /** The fleet has not answered; nothing about the host is decided yet. */
  readonly fleetPending: boolean;
  /** Nobody has named a host yet; the dialog is asking. */
  readonly hostUnchosen: boolean;
  /** The latched host has stopped answering; there is no census to show. */
  readonly hostUnreachable: boolean;
  readonly hostId: string | null;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly proofReady: boolean;
  readonly rows: ReadonlyArray<EpicSweepWorktreeRow>;
  readonly isRowChecked: (row: EpicSweepWorktreeRow) => boolean;
  readonly isRowSweeping: (row: EpicSweepWorktreeRow) => boolean;
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
  readonly activeSweepCount: number;
  readonly selectedEpicIds: ReadonlySet<string>;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly sessionOutcomes: ReadonlyMap<string, SweepSessionOutcome>;
}): ReactNode {
  return (
    <>
      <SweepChooseHeader
        taskCount={props.taskCount}
        taskTitle={props.taskTitle}
        host={props.host}
      />
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
              disabled={props.bulkRows.length === 0}
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
            host={props.host}
            fleetPending={props.fleetPending}
            hostUnchosen={props.hostUnchosen}
            hostUnreachable={props.hostUnreachable}
            taskCount={props.taskCount}
            isPending={props.isPending}
            isError={props.isError}
            rows={props.rows}
            isRowChecked={props.isRowChecked}
            isRowSweeping={props.isRowSweeping}
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
          {props.activeSweepCount > 0 ? "Close" : "Cancel"}
        </Button>
        {/* Always cues removal. Review is an automatic safety step on the way
            when the proof finds consequences, not the person's goal. */}
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="w-full sm:w-auto"
          disabled={props.primaryDisabled}
          onClick={props.onPrimary}
          data-testid="sweep-worktrees-confirm"
        >
          {removeButtonLabel(props.selectedCount)}
        </Button>
      </div>
    </>
  );
}

/**
 * What is being swept, and on which machine. The chip is the route to any
 * other machine; its popover says how many of these Tasks' worktrees each
 * one holds.
 */
function SweepChooseHeader(props: {
  readonly taskCount: number;
  readonly taskTitle: string | null;
  readonly host: SweepHostChoiceView | null;
}): ReactNode {
  const host = props.host;
  return (
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
        {host?.chip}
      </div>
    </div>
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
  for (const failure of result.failed) {
    next.set(failure.worktreePath, false);
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
  readonly host: SweepHostChoiceView | null;
  readonly fleetPending: boolean;
  readonly hostUnchosen: boolean;
  readonly hostUnreachable: boolean;
  readonly taskCount: number;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly rows: ReadonlyArray<EpicSweepWorktreeRow>;
  readonly isRowChecked: (row: EpicSweepWorktreeRow) => boolean;
  readonly isRowSweeping: (row: EpicSweepWorktreeRow) => boolean;
  readonly selectedEpicIds: ReadonlySet<string>;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly sessionOutcomes: ReadonlyMap<string, SweepSessionOutcome>;
  readonly onToggle: (worktreePath: string, checked: boolean) => void;
}) {
  // Both of these are asked BEFORE the pending and empty branches, because
  // neither of those is true of a census that has not run. The candidates
  // query gates on readiness, so with no client it never fetches and never
  // reports pending - it simply hands back nothing, which the empty branch
  // would read as "this machine's disk is clean". That is a claim about a disk
  // nobody walked, and here nobody even said which disk.
  if (props.fleetPending) {
    return (
      <div className="flex items-center gap-2 py-2 text-ui-sm text-muted-foreground">
        <AgentSpinningDots
          variant="dots"
          className="text-muted-foreground"
          testId="sweep-worktrees-fleet-pending-spinner"
        />
        <span data-testid="sweep-worktrees-fleet-pending">
          Checking which hosts are available…
        </span>
      </div>
    );
  }
  if (props.hostUnchosen) {
    return (
      <p
        className="py-2 text-ui-sm text-muted-foreground wrap-anywhere"
        data-testid="sweep-worktrees-host-unchosen"
      >
        Choose a host to check its worktrees.
      </p>
    );
  }
  if (props.hostUnreachable) {
    return (
      <p
        className="py-2 text-ui-sm text-muted-foreground wrap-anywhere"
        data-testid="sweep-worktrees-host-unreachable"
      >
        {unreachableHostCopy(props.host?.hostName ?? null)}
      </p>
    );
  }
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
    if (props.isError) {
      return (
        <p
          className="py-2 text-ui-sm text-muted-foreground"
          data-testid="sweep-worktrees-empty"
        >
          {`Couldn't check these worktrees. Try again from Settings ▸ Worktrees.`}
        </p>
      );
    }
    return <SweepEmptyCensus host={props.host} taskCount={props.taskCount} />;
  }
  return (
    <ul className="flex min-h-0 min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain rounded-lg border border-border/60 bg-background/40 p-1">
      {props.rows.map((row) => (
        <SweepWorktreeRowItem
          key={row.entry.worktreePath}
          row={row}
          checked={props.isRowChecked(row)}
          isSweeping={props.isRowSweeping(row)}
          selectedEpicIds={props.selectedEpicIds}
          agentNames={props.agentNames}
          sessionOutcome={props.sessionOutcomes.get(row.entry.worktreePath)}
          onToggle={props.onToggle}
        />
      ))}
    </ul>
  );
}

/**
 * What a dialog says when the machine it is pointed at stops answering.
 *
 * Not "no worktrees", which is what an unguarded null client would have
 * produced, and not a retarget either: the host was chosen and is still the
 * one this session is about. The chip stays live, so the way out is the same
 * gesture that got here.
 */
function unreachableHostCopy(hostName: string | null): string {
  if (hostName === null) {
    return `Can't reach this host right now, so its worktrees aren't shown.`;
  }
  return `Can't reach ${hostName} right now, so its worktrees aren't shown. Pick another host, or try again once it is back.`;
}

/**
 * The census came back empty - the honest end of the walk for THIS machine.
 * On a single-host install it is the whole answer. With a fleet, the chip
 * above is the route to the others, and its popover says which of them hold
 * anything for these Tasks.
 */
function SweepEmptyCensus(props: {
  readonly host: SweepHostChoiceView | null;
  readonly taskCount: number;
}): ReactNode {
  const host = props.host;
  if (host === null || host.hostName === null) {
    return (
      <p
        className="py-2 text-ui-sm text-muted-foreground"
        data-testid="sweep-worktrees-empty"
      >
        No worktrees on this host for the selected tasks.
      </p>
    );
  }
  return (
    <p
      className="py-2 text-ui-sm text-muted-foreground wrap-anywhere"
      data-testid="sweep-worktrees-empty"
    >
      {props.taskCount > 1
        ? `No worktrees for these tasks on ${host.hostName}.`
        : `No worktrees for this task on ${host.hostName}.`}
    </p>
  );
}

function SweepWorktreeRowItem(props: {
  readonly row: EpicSweepWorktreeRow;
  readonly checked: boolean;
  /** A sweep of this exact path is already streaming (from any surface). */
  readonly isSweeping: boolean;
  readonly selectedEpicIds: ReadonlySet<string>;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly sessionOutcome: SweepSessionOutcome | undefined;
  readonly onToggle: (worktreePath: string, checked: boolean) => void;
}) {
  const { row, checked, isSweeping, onToggle } = props;
  const entry = row.entry;
  const branch = entry.branch ?? "detached HEAD";
  const uncertainLocked = props.sessionOutcome?.kind === "uncertain";
  // Not disabled by a refresh in flight: rows stay selectable while facts are
  // re-checked, because the Remove click re-proves before acting anyway.
  const disabled = row.disabled || isSweeping || uncertainLocked;
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
            heading="Anything working in this worktree when the delete runs will be stopped."
            agentNames={props.agentNames}
            unknownConsequence={unknownConsequenceForRow(row)}
          />
        ) : null}
      </div>
      {isSweeping ? (
        <span className="inline-flex shrink-0 items-center gap-2 text-ui-xs text-muted-foreground">
          <AgentSpinningDots
            className={undefined}
            testId="sweep-worktrees-row-sweeping-spinner"
            variant={undefined}
          />
          Sweeping…
        </span>
      ) : null}
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
