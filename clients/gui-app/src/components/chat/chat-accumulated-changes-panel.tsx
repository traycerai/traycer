import { ChevronDown, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  CheckpointArtifactTag,
  CheckpointFileOperation,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import {
  FileArtifactIcon,
  StaticEpicNodeIcon,
} from "@/components/epic-canvas/epic-node-tab-icon";
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
import { RollingNumber } from "@/components/ui/rolling-number";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import {
  accumulatedDiffTotals,
  type AccumulatedChangeRow,
} from "@/lib/chat/accumulated-change-rows";
import {
  useChatSnapshotDiffOpener,
  type ChatSnapshotDiffOpener,
  type DiffRowClickHandlers,
} from "@/components/chat/chat-diff-target";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { useChatDockSectionAttached } from "@/components/chat/chat-dock-compact-context";
import {
  CHAT_DOCK_PANEL_LIST,
  CHAT_DOCK_PANEL_ROW,
  CHAT_DOCK_PANEL_ROW_TEXT,
} from "@/components/chat/chat-dock-panel-row";
import {
  ChatDockAttachedPanelBody,
  ChatDockPillActions,
} from "@/components/chat/chat-dock-attached-panel";
import { DiffLineDeltas } from "@/components/chat/diff-line-deltas";
import { FileChangeHeader } from "@/components/chat/segments/file-change-segment";
import { RevertArtifactsCheckbox } from "@/components/chat/segments/revert-artifacts-checkbox";
import {
  sessionlessArtifactRowDisplay,
  useArtifactRowDisplay,
  type ArtifactRowDisplay,
} from "@/components/chat/segments/use-artifact-row-display";
import { EpicSessionGate } from "@/providers/epic-session-gate";
import { artifactOperationVerb } from "@/lib/chat/artifact-operation-verb";
import { useIsLooseFileArtifact } from "@/lib/epic-selectors";
import {
  distinctArtifactCount,
  groupArtifactFolderChanges,
  type ArtifactFolderBundle,
} from "@/lib/chat/artifact-folder-bundles";

interface ChatAccumulatedChangesPanelProps {
  readonly restore: ChatRestoreContextValue;
  /** A hairline above this panel, because a sibling drew before it in the
   *  dock's shared frame (L-97). */
  readonly separated: boolean;
  readonly scrollRegionMaxHeightClass?: string;
}

interface RevertGate {
  readonly enabled: boolean;
  readonly tooltip: string;
}

const LOADING_CHANGES_TOOLTIP = "Still loading the full list of changes.";

const LOADING_CHANGES_GATE: RevertGate = {
  enabled: false,
  tooltip: LOADING_CHANGES_TOOLTIP,
};

interface DiffCounts {
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Pinned summary of every file changed across the chat (first-in-chat
 * snapshot → current). Collapsed by default, and open on arrival when a
 * compact chip is what put it back in the dock. Per-row Undo (on hover) and the
 * header's Undo all revert files to their first snapshot. The list is
 * host-computed, so reverted files drop off.
 */
export function ChatAccumulatedChangesPanel(
  props: ChatAccumulatedChangesPanelProps,
) {
  const { restore } = props;
  const changes = restore.accumulatedFileChanges;
  const opener = useChatSnapshotDiffOpener();
  // Attached above the composer because its pill is the open one (L-142):
  // no header of its own, actions in the pill row, body resizable.
  const attached = useChatDockSectionAttached("filesChanged");
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
  const totals = useMemo(() => accumulatedDiffTotals(changes), [changes]);
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
    undelivered > 0 ? LOADING_CHANGES_TOOLTIP : "Nothing here can be reverted.";
  const fileCount = changes.length + undelivered;
  const artifactCount = useMemo(
    () => distinctArtifactCount(changes.filter((change) => change.undoable)),
    [changes],
  );
  const groupedChanges = useMemo(
    () => groupArtifactFolderChanges(changes, (change) => change.artifact),
    [changes],
  );

  if (fileCount === 0) return null;

  // The header's two actions, written once: in the dock's full row they close
  // the header strip, and while this panel is the attached one they are
  // portalled to the right end of the pill row (L-142). Same buttons, same
  // gates, same pending spinner - only the node they land in differs.
  const actions = (
    <>
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
    </>
  );

  const rows = (
    <div className={CHAT_DOCK_PANEL_LIST}>
      {groupedChanges.map((grouped) =>
        grouped.kind === "single" ? (
          <AccumulatedChangeRow
            key={grouped.item.filePath}
            change={grouped.item}
            label={null}
            counts={grouped.item.counts ?? { additions: 0, deletions: 0 }}
            gate={gate}
            pending={restore.restoreActionPending}
            clickHandlers={rowClickHandlers(opener, grouped.item)}
            onUndo={() =>
              // A per-row Undo targets this exact path, so artifacts are
              // always included (the opt-out is only for bulk reverts).
              restore.revertFileChanges(null, [grouped.item.filePath], true)
            }
          />
        ) : (
          <AccumulatedArtifactBundleRow
            key={`artifact:${grouped.artifactId}`}
            bundle={grouped}
            gate={gate}
            artifactUndoGate={
              // The artifact's Undo reverts the files listed under it, so a
              // list still arriving would revert only part of the artifact.
              restore.accumulatedSetComplete ? gate : LOADING_CHANGES_GATE
            }
            pending={restore.restoreActionPending}
            opener={opener}
            onUndo={(filePaths) =>
              restore.revertFileChanges(null, filePaths, true)
            }
          />
        ),
      )}
    </div>
  );

  const undoAllDialog = (
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
  );

  if (attached) {
    return (
      <>
        <ChatDockPillActions>{actions}</ChatDockPillActions>
        <ChatDockAttachedPanelBody
          section="filesChanged"
          testId="accumulated-changes-list"
        >
          {rows}
        </ChatDockAttachedPanelBody>
        {undoAllDialog}
      </>
    );
  }

  return (
    <>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className={cn(props.separated ? "border-t border-border/50" : null)}
        data-testid="accumulated-changes-panel"
        variant="panel"
      >
        <div className="flex items-stretch">
          <CollapsibleTrigger
            className="group/acc flex min-w-0 flex-1 items-center text-left"
            variant="panel"
          >
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
            <span
              data-testid="accumulated-changes-summary"
              className="min-w-0 truncate text-ui-xs font-medium text-foreground/85"
            >
              {/* The count rolls; the word after it does not. The header is a
                  TOTAL that moves several times while a turn writes, which is
                  what a roll is for - the per-file rows below keep plain text,
                  because a turn touching twelve files would roll twelve of
                  them at once. */}
              <RollingNumber
                value={fileCount}
                className={undefined}
                testId={undefined}
              />{" "}
              {fileCount === 1 ? "file changed" : "files changed"}
            </span>
            <DiffLineDeltas counts={totals} className={undefined} rolling />
            <span aria-hidden className="flex-1" />
          </CollapsibleTrigger>
          <div className="flex shrink-0 items-center gap-1 pr-1.5">
            {actions}
          </div>
        </div>
        <CollapsibleContent>
          <div
            data-native-scrollbar="true"
            className={cn(
              "overflow-y-auto border-t border-border/50",
              props.scrollRegionMaxHeightClass ?? "max-h-[min(40dvh,24rem)]",
            )}
          >
            {rows}
          </div>
        </CollapsibleContent>
      </Collapsible>
      {undoAllDialog}
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
        layout="banded"
        showCloseButton={false}
        className="flex w-[min(92vw,28rem)] flex-col overflow-hidden sm:max-w-md"
        data-testid="undo-all-dialog"
      >
        <div className="min-w-0 shrink-0 space-y-3 p-5">
          <DialogTitle>Undo all changes?</DialogTitle>
          <DialogDescription>
            This reverts every changed file to the snapshot from the first time
            it was edited by this agent.
          </DialogDescription>
        </div>
        <div className="-m-1 min-h-0 min-w-0 overflow-y-auto px-6 pt-1 pb-6">
          <RevertArtifactsCheckbox
            count={props.artifactCount}
            checked={revertArtifacts}
            onCheckedChange={setRevertArtifacts}
            disabled={props.isPending}
          />
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 bg-foreground/3 px-5 py-3">
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
  /** The row's text in place of its full path; `null` shows the path. */
  readonly label: string | null;
  readonly counts: DiffCounts;
  readonly gate: RevertGate;
  readonly pending: boolean;
  readonly clickHandlers: DiffRowClickHandlers | null;
  readonly onUndo: () => void;
}

function AccumulatedChangeRow(props: AccumulatedChangeRowProps) {
  const { change, counts, gate, label, onUndo, pending, clickHandlers } = props;
  const { additions, deletions } = counts;
  return (
    <div
      className={cn(
        "group",
        CHAT_DOCK_PANEL_ROW,
        label === null ? null : "pl-8",
        // muted-fill-ok: row inside the canvas-surface panel above; --canvas never equals --muted
        "hover:bg-muted/40",
      )}
    >
      {change.artifact && label === null ? (
        <ArtifactAccumulatedHeader
          artifact={change.artifact}
          operation={change.operation}
          additions={additions}
          deletions={deletions}
          fileCount={null}
        />
      ) : (
        <FileChangeHeader
          filePath={change.filePath}
          label={label ?? change.filePath}
          operation={change.operation}
          additions={additions}
          deletions={deletions}
          isStreaming={false}
          endState={null}
          reason={change.reason}
          clickHandlers={clickHandlers}
        />
      )}
      <RowUndoButton
        undoable={change.undoable}
        gate={gate}
        pending={pending}
        ariaLabel={`Undo changes to ${change.filePath}`}
        testId="accumulated-undo-file"
        onUndo={onUndo}
      />
    </div>
  );
}

interface AccumulatedArtifactBundleRowProps {
  readonly bundle: ArtifactFolderBundle<AccumulatedChangeRow>;
  readonly gate: RevertGate;
  readonly artifactUndoGate: RevertGate;
  readonly pending: boolean;
  readonly opener: ChatSnapshotDiffOpener | null;
  readonly onUndo: (filePaths: ReadonlyArray<string>) => void;
}

/**
 * One html or canvas artifact. A loose HTML page is its own single file and
 * reads as any single artifact row; a folder is one collapsed row for all of
 * its changed files.
 */
function AccumulatedArtifactBundleRow(
  props: AccumulatedArtifactBundleRowProps,
) {
  const { bundle, gate, onUndo, opener, pending } = props;
  const page = bundle.members[0].item;
  return useIsLooseFileArtifact(bundle.artifactId) ? (
    <AccumulatedChangeRow
      change={page}
      label={null}
      counts={page.counts ?? { additions: 0, deletions: 0 }}
      gate={gate}
      pending={pending}
      clickHandlers={rowClickHandlers(opener, page)}
      onUndo={() => onUndo([page.filePath])}
    />
  ) : (
    <AccumulatedArtifactFolderRow {...props} />
  );
}

/**
 * An html or canvas folder: its title, how many of its files changed and
 * their summed `+/-`, collapsed by default. Expanded, each changed file is an
 * ordinary file row of this panel; the artifact's own Undo reverts them all.
 */
function AccumulatedArtifactFolderRow(
  props: AccumulatedArtifactBundleRowProps,
) {
  const { bundle, gate, onUndo, opener, pending } = props;
  const [expanded, setExpanded] = useState(false);
  const memberChanges = bundle.members.map((member) => member.item);
  const totals = accumulatedDiffTotals(memberChanges);
  return (
    <>
      {/* muted-fill-ok: row inside the canvas-surface panel above; --canvas never equals --muted */}
      <div className={cn("group", CHAT_DOCK_PANEL_ROW, "hover:bg-muted/40")}>
        <ArtifactAccumulatedHeader
          artifact={{
            artifactId: bundle.artifactId,
            kind: bundle.artifactKind,
            title: bundle.title,
          }}
          operation={bundle.operation}
          additions={totals.additions}
          deletions={totals.deletions}
          fileCount={memberChanges.length}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-expanded={expanded}
          aria-label={expanded ? "Hide changed files" : "Show changed files"}
          data-testid="accumulated-artifact-toggle"
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3 text-muted-foreground/70 transition-transform",
              expanded ? null : "-rotate-90",
            )}
          />
        </Button>
        <RowUndoButton
          undoable={memberChanges.some((change) => change.undoable)}
          gate={props.artifactUndoGate}
          pending={pending}
          ariaLabel="Undo changes to this artifact"
          testId="accumulated-undo-artifact"
          onUndo={() => onUndo(memberChanges.map((change) => change.filePath))}
        />
      </div>
      {expanded
        ? bundle.members.map((member) => (
            <AccumulatedChangeRow
              key={member.item.filePath}
              change={member.item}
              label={member.label}
              counts={member.item.counts ?? { additions: 0, deletions: 0 }}
              gate={gate}
              pending={pending}
              clickHandlers={rowClickHandlers(opener, member.item)}
              onUndo={() => onUndo([member.item.filePath])}
            />
          ))
        : null}
    </>
  );
}

function RowUndoButton(props: {
  readonly undoable: boolean;
  readonly gate: RevertGate;
  readonly pending: boolean;
  readonly ariaLabel: string;
  readonly testId: string;
  readonly onUndo: () => void;
}) {
  const { gate, onUndo, undoable } = props;
  const undoEnabled = gate.enabled && undoable && !props.pending;
  return (
    <TooltipWrapper
      label={undoable ? gate.tooltip : "This change cannot be reverted."}
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
          aria-label={props.ariaLabel}
          data-testid={props.testId}
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
  );
}

interface ArtifactAccumulatedHeaderProps {
  readonly artifact: CheckpointArtifactTag;
  readonly operation: CheckpointFileOperation;
  readonly additions: number;
  readonly deletions: number;
  /** How many of an html or canvas artifact's files changed; null otherwise. */
  readonly fileCount: number | null;
}

/**
 * The live title and opener read the open epic, which the layout editor's
 * sample workspace draws this panel without: there the row keeps its captured
 * tag and opens nothing.
 */
function ArtifactAccumulatedHeader(props: ArtifactAccumulatedHeaderProps) {
  const { artifact, operation } = props;
  return (
    <EpicSessionGate
      fallback={
        <ArtifactAccumulatedHeaderView
          {...props}
          display={sessionlessArtifactRowDisplay({
            artifactKind: artifact.kind,
            fallbackTitle: artifact.title,
            operation,
          })}
        />
      }
    >
      <LiveArtifactAccumulatedHeader {...props} />
    </EpicSessionGate>
  );
}

function LiveArtifactAccumulatedHeader(props: ArtifactAccumulatedHeaderProps) {
  const { artifact, operation } = props;
  const display = useArtifactRowDisplay({
    artifactId: artifact.artifactId,
    artifactKind: artifact.kind,
    fallbackTitle: artifact.title,
    operation,
  });
  return <ArtifactAccumulatedHeaderView {...props} display={display} />;
}

function ArtifactAccumulatedHeaderView(
  props: ArtifactAccumulatedHeaderProps & {
    readonly display: ArtifactRowDisplay;
  },
) {
  const { operation, additions, deletions, display, fileCount } = props;
  return (
    <>
      {display.displayKind === "file" ? (
        <FileArtifactIcon
          viewer={display.fileViewer}
          className="size-4 shrink-0 text-muted-foreground/80"
        />
      ) : (
        <StaticEpicNodeIcon
          type={display.displayKind}
          className="size-4 shrink-0 text-muted-foreground/80"
        />
      )}
      {/* The same two tokens the FILE branch beside this one draws (L-171):
          the verb on the dock's row text, the title on the code ramp, because
          it occupies the row slot a path occupies. This branch was `text-ui-sm`
          throughout - a 1.875px step inside one typeface at one weight, which
          is exactly the size step the ruling is about. */}
      <span
        className={cn(
          "shrink-0 font-medium text-foreground/85",
          CHAT_DOCK_PANEL_ROW_TEXT,
        )}
      >
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
            "min-w-0 flex-1 text-code-sm text-foreground/85",
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
            "min-w-0 flex-1 text-code-sm text-foreground/85",
            display.isDeleted && "text-muted-foreground line-through",
          )}
        >
          {display.title}
        </StartTruncatedText>
      )}
      {fileCount === null ? null : (
        <span
          className={cn(
            "shrink-0 text-muted-foreground",
            CHAT_DOCK_PANEL_ROW_TEXT,
          )}
        >
          {fileCount} {fileCount === 1 ? "file" : "files"}
        </span>
      )}
      <DiffLineDeltas
        counts={{ additions, deletions }}
        className="@max-[28rem]:hidden"
        rolling={false}
      />
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
