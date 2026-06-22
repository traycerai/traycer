import { useEffect, useRef, useState } from "react";
import { isNoOpCheckpointEntry } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type {
  CheckpointArtifactTag,
  CheckpointFileOperation,
  TurnCheckpointManifest,
  TurnCheckpointManifestEntry,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import { FilePathTooltip } from "@/components/file-path-tooltip";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { cn } from "@/lib/utils";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { useChatRestoreContext } from "@/components/chat/use-chat-restore-context";
import { RevertArtifactsCheckbox } from "./revert-artifacts-checkbox";
import { useArtifactRowDisplay } from "./use-artifact-row-display";

interface RestoreCheckpointDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly manifest: TurnCheckpointManifest;
  readonly hasLaterOverlappingChanges: boolean;
}

interface RestoreProgressView {
  readonly processedCount: number;
  readonly totalCount: number;
}

interface RestoreCheckpointDialogState {
  readonly undoableCount: number;
  readonly skippedCount: number;
  readonly progress: RestoreProgressView | null;
  readonly completedCheckpointId: string | null;
  readonly pending: boolean;
  readonly blockedByActiveTurn: boolean;
}

export function RestoreCheckpointDialog(props: RestoreCheckpointDialogProps) {
  return (
    <RestoreCheckpointDialogContent
      key={props.open ? "open" : "closed"}
      {...props}
    />
  );
}

function RestoreCheckpointDialogContent(props: RestoreCheckpointDialogProps) {
  const { hasLaterOverlappingChanges, manifest, onOpenChange, open } = props;
  const submittedCheckpointIdRef = useRef<string | null>(null);
  const restore = useChatRestoreContext();
  // No-op entries (a path touched but left net-unchanged this turn) are not
  // changes of this turn: the restore plan drops them, and the per-turn
  // "Changes" group never shows them. List / count exactly the same set here so
  // the modal can't promise to restore files the turn never actually changed.
  const entries = manifest.entries.filter(
    (entry) => !isNoOpCheckpointEntry(entry),
  );
  const state = restoreCheckpointDialogState(manifest, entries, restore);
  const artifactCount = entries.filter(
    (entry) => entry.artifact && entry.undoable,
  ).length;
  const [revertArtifacts, setRevertArtifacts] = useState(true);

  useEffect(() => {
    if (
      !shouldCloseDialogAfterRestore(
        open,
        state.completedCheckpointId,
        submittedCheckpointIdRef.current,
      )
    ) {
      return;
    }
    submittedCheckpointIdRef.current = null;
    onOpenChange(false);
  }, [onOpenChange, open, state.completedCheckpointId]);

  return (
    <Dialog open={open} onOpenChange={state.pending ? undefined : onOpenChange}>
      <DialogContent
        // Inline `maxWidth` instead of a Tailwind arbitrary-value class:
        // the comma inside `min(92vw, 32rem)` defeats Tailwind v4's
        // class-extractor regex, so the utility silently never reaches
        // the stylesheet. `min-w-0` neutralizes the grid's intrinsic
        // `min-content` minimum so an unbreakable file path can't push
        // the modal past the cap. The default X close button is
        // suppressed - Cancel in the footer already covers dismissal
        // (alongside Esc / overlay click) without the corner-spacing
        // mismatch that comes with the corner-anchored icon.
        className="w-full min-w-0 gap-0 overflow-hidden p-0"
        style={{ maxWidth: "min(92vw, 32rem)" }}
        showCloseButton={false}
        data-testid="restore-checkpoint-dialog"
      >
        <DialogHeader className="space-y-1 px-6 pt-6 pb-2">
          <DialogTitle className="text-base font-semibold">
            Undo this turn?
          </DialogTitle>
          <DialogDescription data-testid="restore-summary">
            <RestoreSummaryCopy
              undoableCount={state.undoableCount}
              skippedCount={state.skippedCount}
            />
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3 px-6 pb-2">
          <div className="max-h-[min(45vh,22rem)] min-w-0 overflow-y-auto overflow-x-hidden rounded-lg border border-border/60 bg-muted/20">
            {entries.map((entry) => (
              <RestoreFileRow
                key={`${entry.filePath}:${entry.operation}:${entry.beforeHash ?? ""}`}
                entry={entry}
              />
            ))}
          </div>

          {hasLaterOverlappingChanges ? (
            <p
              className="text-ui-xs leading-relaxed text-muted-foreground/90"
              data-testid="restore-cumulative-note"
            >
              Files modified again in later turns will be reverted to their
              state at the start of this turn.
            </p>
          ) : null}

          {state.progress !== null ? (
            <RestoreProgressBar
              processed={state.progress.processedCount}
              total={state.progress.totalCount}
            />
          ) : null}

          <RevertArtifactsCheckbox
            count={artifactCount}
            checked={revertArtifacts}
            onCheckedChange={setRevertArtifacts}
            disabled={state.pending}
          />
        </div>

        <DialogFooter
          // `mx-0 mb-0` neutralizes shadcn's default `-mx-4 -mb-4` on
          // DialogFooter - those negatives are tuned for the primitive's
          // `p-4` content padding, but we use `p-0` here, so they leak
          // 16px past the bottom edge and get clipped by
          // `overflow-hidden`. Result: buttons hug the bottom edge with
          // no breathing room.
          className="mx-0 mb-0 gap-2 rounded-b-xl border-t border-border/40 bg-muted/10 px-6 py-4"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={state.pending}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={restoreConfirmDisabled(state, restore)}
            onClick={() => {
              submittedCheckpointIdRef.current = manifest.checkpointId;
              if (
                restore?.restoreCheckpoint(
                  manifest.checkpointId,
                  revertArtifacts,
                ) === null
              ) {
                submittedCheckpointIdRef.current = null;
              }
            }}
            data-testid="restore-confirm"
          >
            {state.pending ? (
              <AgentSpinningDots
                className={undefined}
                testId="restore-confirm-spinner"
                variant={undefined}
              />
            ) : null}
            Restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RestoreSummaryCopy(props: {
  readonly undoableCount: number;
  readonly skippedCount: number;
}) {
  const { undoableCount, skippedCount } = props;
  if (undoableCount === 0) {
    return (
      <>
        Nothing to restore - {skippedCount} {fileLabel(skippedCount)} cannot be
        undone.
      </>
    );
  }
  if (skippedCount === 0) {
    return (
      <>
        Restoring{" "}
        <strong className="font-semibold text-foreground">
          {undoableCount}
        </strong>{" "}
        {fileLabel(undoableCount)} to the state at the start of this turn.
      </>
    );
  }
  return (
    <>
      Restoring{" "}
      <strong className="font-semibold text-foreground">{undoableCount}</strong>{" "}
      of {undoableCount + skippedCount} files.{" "}
      <span className="text-muted-foreground/80">
        {skippedCount} cannot be undone.
      </span>
    </>
  );
}

function RestoreProgressBar(props: {
  readonly processed: number;
  readonly total: number;
}) {
  const { processed, total } = props;
  const percent = total === 0 ? 0 : Math.round((processed / total) * 100);
  return (
    <div data-testid="restore-progress" className="space-y-1">
      <progress
        className="sr-only"
        value={processed}
        max={total}
        aria-label="Restore checkpoint progress"
      />
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-border/60"
        aria-hidden="true"
      >
        <div
          className="h-full bg-primary transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-ui-xs text-muted-foreground">
        Restored {processed} of {total}
      </p>
    </div>
  );
}

function restoreCheckpointDialogState(
  manifest: TurnCheckpointManifest,
  // The no-op-filtered entries (see the call site); counts must reflect exactly
  // what is listed and restored, not the raw capture log.
  entries: ReadonlyArray<TurnCheckpointManifestEntry>,
  restore: ChatRestoreContextValue | null,
): RestoreCheckpointDialogState {
  const undoableCount = entries.filter((entry) => entry.undoable).length;
  const slot = restore?.restore ?? null;
  const slotMatchesManifest =
    slot !== null && slot.checkpointId === manifest.checkpointId;
  return {
    undoableCount,
    skippedCount: entries.length - undoableCount,
    progress:
      slotMatchesManifest && slot.kind === "progressing"
        ? {
            processedCount: slot.processedCount,
            totalCount: slot.totalCount,
          }
        : null,
    completedCheckpointId:
      slotMatchesManifest && slot.kind === "completed"
        ? slot.checkpointId
        : null,
    pending:
      restore?.restoreActionPending === true ||
      (slotMatchesManifest &&
        (slot.kind === "in-flight" || slot.kind === "progressing")),
    blockedByActiveTurn: restore !== null && restore.activeTurnStatus !== null,
  };
}

function shouldCloseDialogAfterRestore(
  open: boolean,
  completedCheckpointId: string | null,
  submittedCheckpointId: string | null,
): boolean {
  return (
    open &&
    completedCheckpointId !== null &&
    completedCheckpointId === submittedCheckpointId
  );
}

function restoreConfirmDisabled(
  state: RestoreCheckpointDialogState,
  restore: ChatRestoreContextValue | null,
): boolean {
  return (
    state.pending ||
    state.undoableCount === 0 ||
    restore === null ||
    state.blockedByActiveTurn
  );
}

function RestoreFileRow(props: {
  readonly entry: TurnCheckpointManifestEntry;
}) {
  const { entry } = props;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2.5 border-t border-border/40 px-3 py-1.5 first:border-t-0",
        entry.undoable ? null : "text-muted-foreground/70",
      )}
    >
      <OperationDot operation={entry.operation} />
      {entry.artifact ? (
        // Artifacts show their title, not the internal `index.md` path. The
        // resolution lives in a child so the open-epic projection hooks run
        // ONLY for artifact rows - a plain file row needs no epic context.
        <RestoreArtifactTitle
          artifact={entry.artifact}
          operation={entry.operation}
        />
      ) : (
        <FilePathTooltip content={entry.filePath} side="bottom">
          <StartTruncatedText className="min-w-0 flex-1 font-mono text-code-xs">
            {entry.filePath}
          </StartTruncatedText>
        </FilePathTooltip>
      )}
      {entry.undoable ? null : <SkippedIndicator entry={entry} />}
    </div>
  );
}

/**
 * Live artifact title for a restore row: re-resolves by id from the open-epic
 * projection (with the captured tag as fallback), so a rename after capture - or
 * a null captured title - shows the current title rather than a stale/generic
 * one. Split from {@link RestoreFileRow} so the projection hooks run only for
 * artifact rows.
 */
function RestoreArtifactTitle(props: {
  readonly artifact: CheckpointArtifactTag;
  readonly operation: CheckpointFileOperation;
}) {
  const display = useArtifactRowDisplay({
    artifactId: props.artifact.artifactId,
    artifactKind: props.artifact.kind,
    fallbackTitle: props.artifact.title,
    operation: props.operation,
  });
  return (
    <StartTruncatedText className="min-w-0 flex-1 text-code-xs">
      {display.title}
    </StartTruncatedText>
  );
}

/** Subtle 6px dot keyed on the operation - replaces the loud rainbow
 * badges so dense lists feel scannable rather than seasick. */
function OperationDot(props: { readonly operation: CheckpointFileOperation }) {
  const cls = operationDotClass(props.operation);
  return (
    <TooltipWrapper
      label={<span className="capitalize">{props.operation}</span>}
      side="right"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        className={cn("size-1.5 shrink-0 rounded-full", cls)}
        aria-label={props.operation}
      />
    </TooltipWrapper>
  );
}

function operationDotClass(operation: CheckpointFileOperation): string {
  if (operation === "create") return "bg-emerald-500/80";
  if (operation === "delete") return "bg-destructive/80";
  return "bg-blue-500/80";
}

function SkippedIndicator(props: {
  readonly entry: TurnCheckpointManifestEntry;
}) {
  return (
    <TooltipWrapper
      label={formatUndoReason(props.entry.reason)}
      side="left"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="shrink-0 cursor-help text-ui-xs text-amber-600/90 dark:text-amber-400/80">
        Skipped
      </span>
    </TooltipWrapper>
  );
}

function fileLabel(count: number): string {
  return count === 1 ? "file" : "files";
}

function formatUndoReason(reason: string | null): string {
  if (reason === null) return "No pre-edit snapshot was captured.";
  if (reason === "binary") {
    return "Binary files cannot be restored from local snapshots.";
  }
  if (reason === "storage_full") return "Local snapshot storage was full.";
  if (reason === "capture_failed") return "Snapshot capture failed.";
  if (reason === "denied")
    return "The edit was denied; the file was not changed.";
  if (reason === "not_intercepted") {
    return "Provider did not surface this tool for approval.";
  }
  return reason;
}
