import { FileDiff, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { isNoOpCheckpointEntry } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type {
  TurnCheckpointManifest,
  TurnCheckpointManifestEntry,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { useChatRestoreContext } from "@/components/chat/use-chat-restore-context";
import type {
  ArtifactChangeRow as ArtifactChangeRowModel,
  FileChangeSegment as FileChangeSegmentModel,
} from "@/stores/composer/chat-store";
import { ArtifactChangeRow } from "./artifact-change-row";
import { FileChangeSegment } from "./file-change-segment";
import { RestoreCheckpointDialog } from "./restore-checkpoint-dialog";
import { SegmentCard } from "./segment-card";

interface FileChangeGroupSegmentProps {
  files: ReadonlyArray<FileChangeSegmentModel>;
  artifacts: ReadonlyArray<ArtifactChangeRowModel>;
  checkpointManifest: TurnCheckpointManifest | null;
  hasLaterOverlappingChanges: boolean;
  findUnitId: string | null;
}

function changeCountLabel(fileCount: number, artifactCount: number): string {
  const parts: string[] = [];
  if (fileCount > 0) {
    parts.push(`${fileCount} file${fileCount > 1 ? "s" : ""}`);
  }
  if (artifactCount > 0) {
    parts.push(`${artifactCount} artifact${artifactCount > 1 ? "s" : ""}`);
  }
  return parts.join(" · ");
}

export function FileChangeGroupSegment(props: FileChangeGroupSegmentProps) {
  const { artifacts, checkpointManifest, files, hasLaterOverlappingChanges } =
    props;
  const [open, setOpen] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const restore = useChatRestoreContext();
  const undoState = undoButtonState(checkpointManifest, restore);
  const { additions, deletions } = useMemo(
    () =>
      files.reduce(
        (acc, file) => ({
          additions: acc.additions + file.additions,
          deletions: acc.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [files],
  );

  const header = (
    <>
      <FileDiff
        className="size-3.5 shrink-0 text-muted-foreground/80"
        aria-hidden
      />
      <span className="shrink-0 text-ui-sm font-medium text-foreground/85">
        Changes
      </span>
      <span aria-hidden className="shrink-0 text-muted-foreground/85">
        ·
      </span>
      <span className="shrink-0 text-ui-sm text-muted-foreground">
        {changeCountLabel(files.length, artifacts.length)}
      </span>
      <span aria-hidden className="flex-1" />
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
  const headerAction =
    undoState === null ? null : (
      <div className="flex shrink-0 items-center border-l border-border/30 px-2">
        <TooltipWrapper
          label={undoState.tooltip}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant={undoState.enabled ? "default" : "outline"}
            size="xs"
            aria-disabled={!undoState.enabled || undoState.pending}
            aria-label="Undo changes"
            data-testid="checkpoint-undo-button"
            data-disabled={!undoState.enabled || undoState.pending}
            className="data-[disabled=true]:pointer-events-auto data-[disabled=true]:opacity-50"
            onClick={(event) => {
              event.stopPropagation();
              if (!undoState.enabled || undoState.pending) return;
              setRestoreDialogOpen(true);
            }}
          >
            {undoState.pending ? (
              <AgentSpinningDots
                className={undefined}
                testId="checkpoint-undo-spinner"
                variant={undefined}
              />
            ) : (
              <RotateCcw className="size-3" aria-hidden />
            )}
            Undo
          </Button>
        </TooltipWrapper>
      </div>
    );

  const body = (
    <div className="flex flex-col gap-1.5" data-testid="file-change-group-body">
      {files.map((file) => (
        <FileChangeSegment
          key={file.id}
          segment={file}
          variant="row"
          headerFindUnitId={null}
        />
      ))}
      {artifacts.map((artifact) => (
        <ArtifactChangeRow
          key={`artifact:${artifact.artifactId ?? artifact.filePath}`}
          row={artifact}
        />
      ))}
    </div>
  );

  return (
    <>
      <SegmentCard
        open={open}
        onOpenChange={setOpen}
        header={header}
        headerAction={headerAction}
        collapsedPreview={null}
        body={body}
        tone="default"
        headerPosition="normal"
        bodyOverflow="visible"
        expandable
        headerFindUnitId={props.findUnitId ?? null}
        bodyFindUnitId={null}
        className={undefined}
      />
      {checkpointManifest === null ? null : (
        <RestoreCheckpointDialog
          open={restoreDialogOpen}
          onOpenChange={setRestoreDialogOpen}
          manifest={checkpointManifest}
          hasLaterOverlappingChanges={hasLaterOverlappingChanges}
        />
      )}
    </>
  );
}

interface UndoButtonState {
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly tooltip: string;
}

function undoButtonState(
  manifest: TurnCheckpointManifest | null,
  restore: ChatRestoreContextValue | null,
): UndoButtonState | null {
  if (manifest === null) return null;
  // Drive enablement off real changes only: a manifest whose only entries are
  // no-ops (touched but net-unchanged) has nothing to undo, so it must offer no
  // button - matching the restore plan, which skips those same entries.
  const effectiveEntries = manifest.entries.filter(
    (entry) => !isNoOpCheckpointEntry(entry),
  );
  if (effectiveEntries.length === 0) return null;
  const pending = checkpointRestorePending(manifest, restore);
  const blockedTooltip = undoBlockedTooltip(
    manifest,
    effectiveEntries,
    restore,
  );
  if (blockedTooltip !== null) {
    return {
      enabled: false,
      pending,
      tooltip: blockedTooltip,
    };
  }
  if (pending) {
    return {
      enabled: true,
      pending,
      tooltip: "Restore in progress.",
    };
  }
  return {
    enabled: true,
    pending,
    tooltip: "Undo this turn.",
  };
}

function checkpointRestorePending(
  manifest: TurnCheckpointManifest,
  restore: ChatRestoreContextValue | null,
): boolean {
  const slot = restore?.restore ?? null;
  return (
    restore?.restoreActionPending === true ||
    (slot !== null &&
      slot.checkpointId === manifest.checkpointId &&
      (slot.kind === "in-flight" || slot.kind === "progressing"))
  );
}

function undoBlockedTooltip(
  manifest: TurnCheckpointManifest,
  // No-op-filtered entries (see undoButtonState): "Nothing to restore" must
  // reflect the set that would actually be restored, not the raw capture log.
  effectiveEntries: ReadonlyArray<TurnCheckpointManifestEntry>,
  restore: ChatRestoreContextValue | null,
): string | null {
  if (restore === null) return "Restore unavailable.";
  if (restore.accessRole !== "owner") {
    return "Only the chat owner can restore files.";
  }
  if (restore.activeHostId !== manifest.capturingHostId) {
    return "Undo unavailable on this device.";
  }
  if (restore.activeTurnStatus !== null) {
    return "Wait for the active turn to finish or stop it before restoring.";
  }
  if (restoreBlockedByLocalSnapshotClear(manifest, restore)) {
    return "Undo unavailable on this device.";
  }
  if (!effectiveEntries.some((entry) => entry.undoable)) {
    return "Nothing to restore.";
  }
  return null;
}

function restoreBlockedByLocalSnapshotClear(
  manifest: TurnCheckpointManifest,
  restore: ChatRestoreContextValue,
): boolean {
  return (
    restore.currentUserId === manifest.capturingUserId &&
    restore.localSnapshotsClearedAt !== null &&
    manifest.capturedAt <= restore.localSnapshotsClearedAt
  );
}
