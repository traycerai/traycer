import { ChevronDown, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  CheckpointArtifactTag,
  CheckpointFileOperation,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import { StaticEpicNodeIcon } from "@/components/epic-canvas/epic-node-tab-icon";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
import {
  useChatSnapshotDiffOpener,
  type ChatSnapshotDiffOpener,
  type DiffRowClickHandlers,
} from "@/components/chat/chat-diff-target";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { FileChangeHeader } from "@/components/chat/segments/file-change-segment";
import { RevertArtifactsCheckbox } from "@/components/chat/segments/revert-artifacts-checkbox";
import { useArtifactRowDisplay } from "@/components/chat/segments/use-artifact-row-display";
import { artifactOperationVerb } from "@/lib/chat/artifact-operation-verb";

interface ChatAccumulatedChangesPanelProps {
  readonly restore: ChatRestoreContextValue;
  readonly separated: boolean;
  readonly scrollRegionMaxHeightClass?: string;
}

interface RevertGate {
  readonly enabled: boolean;
  readonly tooltip: string;
}

interface DiffCounts {
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Pinned summary of every file changed across the chat (first-in-chat
 * snapshot → current). Collapsed by default. Per-row Undo (on hover) and the
 * header's Undo all revert files to their first snapshot. The list is
 * host-computed, so reverted files drop off.
 */
export function ChatAccumulatedChangesPanel(
  props: ChatAccumulatedChangesPanelProps,
) {
  const { restore } = props;
  const changes = restore.accumulatedFileChanges;
  const opener = useChatSnapshotDiffOpener();
  const [open, setOpen] = useState(false);
  const [confirmUndoAll, setConfirmUndoAll] = useState(false);
  const gate = useMemo(() => revertGate(restore), [restore]);
  // CONTENT-BEARING rows only. A `hasContents: false` summary has no
  // before/after to fetch - `fetchableAccumulatedChanges` drops it and the
  // durable tile has no inline contents for it either - so including it here
  // makes the bundle's title count sections the tile can never render, and a
  // bundle of nothing but such rows opens straight into "source unavailable".
  //
  // The panel's own list still shows every row: a content-less change is a real
  // change and the user should see it. It is only unreviewable.
  const filePaths = useMemo(
    () =>
      changes
        .filter((change) => change.hasContents)
        .map((change) => change.filePath),
    [changes],
  );
  // Gated on the summary set being COMPLETE, not just on there being one.
  // While chunks are still arriving `filePaths` is the delivered prefix, and
  // this action captures it into a durable cumulative-bundle tile - so a click
  // during ordinary initial loading produces a "review all changes" bundle
  // that permanently omits the files that had not landed yet, with nothing on
  // screen to say so. The header already counts the whole host set, which is
  // what makes the shortfall invisible.
  const reviewAll = useMemo(
    () =>
      opener === null ||
      restore.activeTurnStatus !== null ||
      // EXACT completeness, not the clamped count. A revert that lowers the
      // host's total while the replacement index-0 summary chunk is dropped
      // leaves MORE summaries than the count, so `undeliveredChangeCount`
      // clamps to `0` and reads as a finished stream - and during the watchdog
      // recovery window this action would capture reverted, stale paths into a
      // durable bundle. `accumulatedSummarySetComplete` is the predicate that
      // can tell an overshoot from a finished stream; the count cannot.
      !restore.accumulatedSetComplete ||
      // Nothing reviewable. Offering the action anyway opens a tile with no
      // sections at all, which reads as a failure rather than as "these
      // changes have no contents to diff".
      filePaths.length === 0
        ? null
        : opener.cumulativeBundle(filePaths),
    [
      filePaths,
      opener,
      restore.activeTurnStatus,
      restore.accumulatedSetComplete,
    ],
  );
  // Every row arrives carrying its own `+/-`: derived from contents on the
  // pre-windowed line, host-computed on the windowed one, and summed per-edit
  // for a file the active turn is still writing. The panel used to diff two
  // file bodies per row per render to get here.
  const totals = useMemo(() => aggregateCounts(changes), [changes]);
  // The header counts what "Undo all" would touch, which is the host's whole
  // set - not the prefix of it that has arrived. The rows below fill in as
  // their summaries land.
  const undelivered = restore.undeliveredChangeCount;
  // Known-undoable rows only. A non-zero `undelivered` is NOT evidence of
  // undoability: that count includes summaries whose `undoable` is false -
  // denied, binary, otherwise non-intercepted - so enabling the control on it
  // offers a revert confirmation that can revert nothing, and the same set
  // correctly disables the control once its summaries arrive.
  const hasUndoable = changes.some((change) => change.undoable);
  // What a prefix DOES change is what the disabled state may claim. "Nothing
  // here can be reverted." is a statement about the whole set, and while
  // summaries are still arriving this side does not know the whole set - the
  // host may well hold undoable files behind the count. So the copy says what
  // is actually true in that state, and only the settled set makes the
  // stronger claim. (Line 255 already treats a non-zero `undelivered` as "the
  // set is a prefix"; this keeps the two controls saying one thing about it.)
  const undoableTooltip =
    undelivered > 0
      ? "Still loading the full list of changes."
      : "Nothing here can be reverted.";
  const fileCount = changes.length + undelivered;
  const artifactCount = useMemo(
    () => changes.filter((change) => change.artifact && change.undoable).length,
    [changes],
  );

  if (fileCount === 0) return null;

  return (
    <>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className={cn(
          // muted-fill-ok: panel on the chat dock / pinned stack bg-canvas; --canvas never equals --muted
          "bg-muted/30",
          props.separated ? "border-t border-border/50" : null,
        )}
        data-testid="accumulated-changes-panel"
      >
        <div className="flex items-stretch">
          {/* muted-fill-ok: trigger inside the canvas-surface panel above;
              --canvas never equals --muted */}
          <CollapsibleTrigger className="group/acc flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-muted-foreground/70 transition-transform",
                open ? null : "-rotate-90",
              )}
            />
            {/* The one shrinkable item in the row. Every sibling is a fixed
                chip (chevron, +/− counts, the action buttons), so if this
                label could not give up width, a narrow viewport would push
                the counts out of the trigger's box and under the buttons. */}
            <span className="min-w-0 truncate text-ui-xs font-medium text-foreground/85">
              {fileCount} {fileCount === 1 ? "file changed" : "files changed"}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-code-xs">
              {totals.additions > 0 ? (
                <span className="text-emerald-600 dark:text-emerald-400">
                  +{totals.additions}
                </span>
              ) : null}
              {totals.deletions > 0 ? (
                <span className="text-destructive">−{totals.deletions}</span>
              ) : null}
            </span>
            <span aria-hidden className="flex-1" />
          </CollapsibleTrigger>
          <div className="flex shrink-0 items-center gap-1 pr-1.5">
            {reviewAll === null ? null : (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label="Review all changes"
                data-testid="accumulated-review-all"
                onClick={(event) => {
                  event.stopPropagation();
                  reviewAll();
                }}
              >
                Review all
              </Button>
            )}
            <TooltipWrapper
              label={hasUndoable ? gate.tooltip : undoableTooltip}
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={!gate.enabled || !hasUndoable}
                  aria-label="Undo all changes"
                  data-testid="accumulated-undo-all"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!gate.enabled || !hasUndoable) return;
                    setConfirmUndoAll(true);
                  }}
                >
                  {restore.restoreActionPending ? (
                    <AgentSpinningDots
                      className={undefined}
                      testId="accumulated-undo-all-spinner"
                      variant={undefined}
                    />
                  ) : (
                    <RotateCcw className="size-3" aria-hidden />
                  )}
                  Undo all
                </Button>
              </span>
            </TooltipWrapper>
          </div>
        </div>
        <CollapsibleContent>
          <div
            data-native-scrollbar="true"
            className={cn(
              "overflow-y-auto border-t border-border/50 px-2 py-1.5",
              props.scrollRegionMaxHeightClass ?? "max-h-[min(40dvh,24rem)]",
            )}
          >
            <div className="flex flex-col gap-0.5">
              {changes.map((change) => (
                <AccumulatedChangeRow
                  key={change.filePath}
                  change={change}
                  counts={change.counts ?? { additions: 0, deletions: 0 }}
                  gate={gate}
                  pending={restore.restoreActionPending}
                  clickHandlers={rowClickHandlers(opener, change)}
                  onUndo={() =>
                    // A per-row Undo targets this exact path, so artifacts are
                    // always included (the opt-out is only for bulk reverts).
                    restore.revertFileChanges(null, [change.filePath], true)
                  }
                />
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <UndoAllDialog
        open={confirmUndoAll}
        onOpenChange={setConfirmUndoAll}
        isPending={restore.restoreActionPending}
        // `null` while the set is a prefix: the opt-out defaults to CHECKED and
        // "Undo all" reverts every file the host holds, so a count taken from
        // the rows on screen would understate what is being opted out of.
        artifactCount={
          undelivered > 0 || !restore.accumulatedSetComplete
            ? null
            : artifactCount
        }
        onConfirm={(revertArtifacts) => {
          restore.revertFileChanges(null, null, revertArtifacts);
          setConfirmUndoAll(false);
        }}
      />
    </>
  );
}

interface UndoAllDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly isPending: boolean;
  /** `null` when the accumulated set is still a prefix - see the call site. */
  readonly artifactCount: number | null;
  readonly onConfirm: (revertArtifacts: boolean) => void;
}

function UndoAllDialog(props: UndoAllDialogProps) {
  return (
    <UndoAllDialogContent key={props.open ? "open" : "closed"} {...props} />
  );
}

function UndoAllDialogContent(props: UndoAllDialogProps) {
  const [revertArtifacts, setRevertArtifacts] = useState(true);
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.isPending ? undefined : props.onOpenChange}
    >
      <DialogContent
        showCloseButton={false}
        className="w-[min(92vw,28rem)] gap-0 overflow-hidden p-0 sm:max-w-md"
        data-testid="undo-all-dialog"
      >
        <div className="min-w-0 space-y-3 p-5">
          <DialogTitle className="text-ui font-semibold leading-snug">
            Undo all changes?
          </DialogTitle>
          <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground">
            This reverts every changed file to the snapshot from the first time
            it was edited by this agent.
          </DialogDescription>
          <RevertArtifactsCheckbox
            count={props.artifactCount}
            checked={revertArtifacts}
            onCheckedChange={setRevertArtifacts}
            disabled={props.isPending}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-border/60 bg-foreground/3 px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={props.isPending}
            onClick={() => {
              props.onOpenChange(false);
            }}
            data-testid="undo-all-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={props.isPending}
            onClick={() => props.onConfirm(revertArtifacts)}
            data-testid="undo-all-confirm"
          >
            {props.isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Undo all
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface AccumulatedChangeRowProps {
  readonly change: AccumulatedChangeRow;
  readonly counts: DiffCounts;
  readonly gate: RevertGate;
  readonly pending: boolean;
  readonly clickHandlers: DiffRowClickHandlers | null;
  readonly onUndo: () => void;
}

function AccumulatedChangeRow(props: AccumulatedChangeRowProps) {
  const { change, counts, gate, onUndo, pending, clickHandlers } = props;
  const { additions, deletions } = counts;
  const undoEnabled = gate.enabled && change.undoable && !pending;
  return (
    // muted-fill-ok: row inside the canvas-surface panel above; --canvas never equals --muted
    <div className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/40">
      {change.artifact ? (
        <ArtifactAccumulatedHeader
          artifact={change.artifact}
          operation={change.operation}
          additions={additions}
          deletions={deletions}
        />
      ) : (
        <FileChangeHeader
          filePath={change.filePath}
          operation={change.operation}
          additions={additions}
          deletions={deletions}
          isStreaming={false}
          endState={null}
          reason={change.reason}
          clickHandlers={clickHandlers}
        />
      )}
      <TooltipWrapper
        label={
          change.undoable ? gate.tooltip : "This change cannot be reverted."
        }
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span className="inline-flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!undoEnabled}
            aria-label={`Undo changes to ${change.filePath}`}
            data-testid="accumulated-undo-file"
            onClick={(event) => {
              event.stopPropagation();
              if (!undoEnabled) return;
              onUndo();
            }}
          >
            <RotateCcw className="size-3" aria-hidden />
          </Button>
        </span>
      </TooltipWrapper>
    </div>
  );
}

function ArtifactAccumulatedHeader(props: {
  readonly artifact: CheckpointArtifactTag;
  readonly operation: CheckpointFileOperation;
  readonly additions: number;
  readonly deletions: number;
}) {
  const { artifact, operation, additions, deletions } = props;
  const display = useArtifactRowDisplay({
    artifactId: artifact.artifactId,
    artifactKind: artifact.kind,
    fallbackTitle: artifact.title,
    operation,
  });
  return (
    <>
      <StaticEpicNodeIcon
        type={display.displayKind}
        className="size-4 shrink-0 text-muted-foreground/80"
      />
      <span className="shrink-0 text-ui-sm font-medium text-foreground/85">
        {artifactOperationVerb(operation)}
      </span>
      <span aria-hidden className="shrink-0 text-muted-foreground/40">
        ·
      </span>
      {display.canOpen ? (
        <StartTruncatedText
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            display.openArtifact();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            display.openArtifact();
          }}
          className={cn(
            "min-w-0 flex-1 text-ui-sm text-foreground/85",
            "hover:text-foreground hover:underline underline-offset-2",
            "focus-visible:underline focus-visible:outline-none",
            "cursor-pointer",
          )}
        >
          {display.title}
        </StartTruncatedText>
      ) : (
        <StartTruncatedText
          className={cn(
            "min-w-0 flex-1 text-ui-sm text-foreground/85",
            display.isDeleted && "text-muted-foreground line-through",
          )}
        >
          {display.title}
        </StartTruncatedText>
      )}
      <span className="@max-[28rem]:hidden flex shrink-0 items-center gap-1.5 font-mono text-code-xs">
        {additions > 0 ? (
          <span className="text-emerald-600 dark:text-emerald-400">
            +{additions}
          </span>
        ) : null}
        {deletions > 0 ? (
          <span className="text-destructive">−{deletions}</span>
        ) : null}
      </span>
    </>
  );
}

/**
 * Which tile a row opens, or `null` for a row that opens nothing.
 *
 * Every branch here answers one question: can the surface this click opens
 * actually RESOLVE this row's contents? An advertised click that lands on
 * source-unavailable is worse than a plain row, so a row only becomes
 * interactive once something can answer for it.
 *
 * - `hasContents: false` (a `diffSource: "none"` summary) has no before/after
 *   to show at all - the fetch list excludes it by construction and the
 *   windowed inline-change array is empty.
 * - {@link AccumulatedChangeRow.liveDiff} is the active turn's own row, which
 *   no host version names yet: cumulative resolution has neither a digest nor
 *   an inline change for it. Its `file_change` blocks are hydrated, so it opens
 *   the SEGMENT tile that addresses them by block id instead.
 * - Everything else is a host row, and the cumulative surface answers for it.
 */
function rowClickHandlers(
  opener: ChatSnapshotDiffOpener | null,
  change: AccumulatedChangeRow,
): DiffRowClickHandlers | null {
  if (opener === null || !change.hasContents) return null;
  const live = change.liveDiff;
  if (live !== null) {
    return opener.segment({
      filePath: change.filePath,
      sourceBlockIds: live.sourceBlockIds,
      beforeHash: live.beforeHash,
      afterHash: live.afterHash,
    });
  }
  return opener.cumulative(change.filePath);
}

function revertGate(restore: ChatRestoreContextValue): RevertGate {
  if (restore.accessRole !== "owner") {
    return {
      enabled: false,
      tooltip: "Only the agent owner can revert files.",
    };
  }
  if (restore.activeTurnStatus !== null) {
    return {
      enabled: false,
      tooltip: "Wait for the active turn to finish before reverting.",
    };
  }
  if (restore.restoreActionPending) {
    return { enabled: false, tooltip: "Revert in progress." };
  }
  return { enabled: true, tooltip: "Revert to the first snapshot." };
}

/**
 * The collapsed header's totals.
 *
 * A `null` count contributes nothing, which is the right reading: it means the
 * row has no diff to count (`diffSource: "none"`), not that it counted zero.
 */
function aggregateCounts(
  rows: ReadonlyArray<AccumulatedChangeRow>,
): DiffCounts {
  let additions = 0;
  let deletions = 0;
  for (const row of rows) {
    if (row.counts === null) continue;
    additions += row.counts.additions;
    deletions += row.counts.deletions;
  }
  return { additions, deletions };
}
