import { ChevronDown, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import type { ChatAccumulatedFileChange } from "@traycer/protocol/host/agent/gui/subscribe";
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
import { diffLineCountsFromContents } from "@/lib/file-change-diff-hunks";
import {
  useChatSnapshotDiffOpener,
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
  const filePaths = useMemo(
    () => changes.map((change) => change.filePath),
    [changes],
  );
  const reviewAll = useMemo(
    () =>
      opener === null || restore.activeTurnStatus !== null
        ? null
        : opener.cumulativeBundle(filePaths),
    [filePaths, opener, restore.activeTurnStatus],
  );
  const diffCountsByPath = useMemo(() => {
    const map = new Map<string, DiffCounts>();
    for (const change of changes) {
      // Active-turn rows have null content until the host recomputes at turn
      // end, but carry `streamingCounts` (per-edit `+/-` summed across the
      // turn) so the panel shows a live magnitude on every edit. Host rows
      // have null `streamingCounts` and derive `+/-` from resolved content.
      map.set(
        change.filePath,
        change.streamingCounts ??
          diffLineCountsFromContents(
            change.beforeContent,
            change.afterContent,
            false,
          ),
      );
    }
    return map;
  }, [changes]);
  const totals = useMemo(
    () => aggregateCounts(diffCountsByPath),
    [diffCountsByPath],
  );
  const hasUndoable = changes.some((change) => change.undoable);
  const artifactCount = useMemo(
    () => changes.filter((change) => change.artifact && change.undoable).length,
    [changes],
  );

  if (changes.length === 0) return null;

  return (
    <>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className={cn(
          "bg-muted/30",
          props.separated ? "border-t border-border/50" : null,
        )}
        data-testid="accumulated-changes-panel"
      >
        <div className="flex items-stretch">
          <CollapsibleTrigger className="group/acc flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-muted-foreground/70 transition-transform",
                open ? null : "-rotate-90",
              )}
            />
            <span className="shrink-0 text-ui-xs font-medium text-foreground/85">
              {changes.length}{" "}
              {changes.length === 1 ? "file changed" : "files changed"}
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
              label={
                hasUndoable ? gate.tooltip : "Nothing here can be reverted."
              }
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
            className={cn(
              "overflow-y-auto border-t border-border/50 px-2 py-1.5 chat-scrollbar-native-thin",
              props.scrollRegionMaxHeightClass ?? "max-h-[min(40dvh,24rem)]",
            )}
          >
            <div className="flex flex-col gap-0.5">
              {changes.map((change) => (
                <AccumulatedChangeRow
                  key={change.filePath}
                  change={change}
                  counts={
                    diffCountsByPath.get(change.filePath) ?? {
                      additions: 0,
                      deletions: 0,
                    }
                  }
                  gate={gate}
                  pending={restore.restoreActionPending}
                  clickHandlers={
                    opener === null ? null : opener.cumulative(change.filePath)
                  }
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
        artifactCount={artifactCount}
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
  readonly artifactCount: number;
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
        <div className="flex justify-end gap-2 border-t border-border/60 bg-muted/20 px-5 py-3">
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
  readonly change: ChatAccumulatedFileChange;
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
        <span className="inline-flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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

function aggregateCounts(
  countsByPath: ReadonlyMap<string, DiffCounts>,
): DiffCounts {
  let additions = 0;
  let deletions = 0;
  for (const counts of countsByPath.values()) {
    additions += counts.additions;
    deletions += counts.deletions;
  }
  return { additions, deletions };
}
