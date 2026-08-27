/**
 * PDF change summary for the single-file git diff tile (PDF preview design,
 * Q7 follow-up). Deliberately NOT two inline viewers: two unsynchronized
 * multi-page viewers in cramped half-tile columns would look like a diff
 * while carrying none of a diff's meaning (page insertions shift
 * everything). Instead: the diff view's job here is "tell me it changed and
 * how much, and let me open either version properly" - per-side metadata
 * cards in the same old|new spatial grammar the image diff established,
 * each with a View button into the full-size `PdfViewDialog`.
 */
import { useState, type ReactNode } from "react";
import { Eye, FileMinus, FilePlus, FileTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { BinaryPlaceholder } from "@/components/epic-canvas/binary-placeholder";
import { isPdfAssetPath } from "@/lib/assets/image-extension-allowlist";
import { PdfViewDialog, type PdfViewSide } from "./pdf-view-dialog";

export interface PdfDiffViewProps {
  readonly runningDir: string;
  readonly filePath: string;
  readonly previousPath: string | null;
  /** `gitImageDiffRevisionKey(file, headSha)` - threads into every git request, see `ImageDiffViewProps.revisionKey`. */
  readonly revisionKey: string;
  /** From `gitImageDiffSides`; `null` = the side does not exist (Added/Deleted empty state). */
  readonly oldStage: "staged" | "unstaged" | null;
  readonly newStage: "staged" | "unstaged" | null;
  /** Current (new-side) size from `GitChangedFile.sizeBytes`; the old side's size is not known without a stream, so its card omits it. */
  readonly sizeBytes: number | null;
  readonly onOpenExternally: (() => void) | null;
  readonly openExternallyOpening: boolean;
}

function formatSizeBytes(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (sizeBytes >= 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${sizeBytes} B`;
}

function PdfDiffEmptyState(props: {
  readonly label: "Added" | "Deleted";
}): ReactNode {
  const Icon = props.label === "Added" ? FilePlus : FileMinus;
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 p-4 text-ui-xs text-muted-foreground">
      <Icon className="size-8" />
      <span>{props.label}</span>
    </div>
  );
}

function PdfSideCard(props: {
  readonly label: "Old" | "New";
  readonly sizeBytes: number | null;
  readonly onView: () => void;
}): ReactNode {
  return (
    <div
      className="flex size-full flex-col items-center justify-center gap-2 p-4"
      data-testid={`pdf-diff-side-${props.label.toLowerCase()}`}
    >
      <FileTextIcon className="size-8 text-muted-foreground" />
      <span className="text-ui-xs text-muted-foreground">
        {props.label} version
        {props.sizeBytes !== null
          ? ` · ${formatSizeBytes(props.sizeBytes)}`
          : ""}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={props.onView}>
        <Eye className="size-4" />
        View
      </Button>
    </div>
  );
}

function PdfDiffSideSlot(props: {
  readonly exists: boolean;
  readonly isPdf: boolean;
  readonly emptyLabel: "Added" | "Deleted";
  readonly cardLabel: "Old" | "New";
  readonly effectivePath: string;
  readonly sizeBytes: number | null;
  readonly onView: () => void;
  readonly onOpenExternally: (() => void) | null;
  readonly openExternallyOpening: boolean;
}): ReactNode {
  if (!props.exists) {
    return <PdfDiffEmptyState label={props.emptyLabel} />;
  }
  if (props.isPdf) {
    return (
      <PdfSideCard
        label={props.cardLabel}
        sizeBytes={props.sizeBytes}
        onView={props.onView}
      />
    );
  }
  // A rename can put a non-PDF on one side (`data.bin -> report.pdf`) - that
  // side gets the plain compact placeholder rather than a View card into a
  // document that is not a PDF.
  return (
    <BinaryPlaceholder
      fileName={props.effectivePath}
      sizeBytes={props.sizeBytes}
      reason={null}
      onOpenExternally={props.onOpenExternally}
      openExternallyOpening={props.openExternallyOpening}
      compact
    />
  );
}

export function PdfDiffView(props: PdfDiffViewProps): ReactNode {
  const [viewSide, setViewSide] = useState<PdfViewSide | null>(null);

  // Same either-path rule as the image diff's per-side gating.
  const oldEffectivePath = props.previousPath ?? props.filePath;
  const oldIsPdf = props.oldStage !== null && isPdfAssetPath(oldEffectivePath);
  const newIsPdf = props.newStage !== null && isPdfAssetPath(props.filePath);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 items-stretch">
        <div className="min-w-0 flex-1">
          <PdfDiffSideSlot
            exists={props.oldStage !== null}
            isPdf={oldIsPdf}
            emptyLabel="Added"
            cardLabel="Old"
            effectivePath={oldEffectivePath}
            sizeBytes={null}
            onView={() => setViewSide("old")}
            onOpenExternally={props.onOpenExternally}
            openExternallyOpening={props.openExternallyOpening}
          />
        </div>
        <div className="w-px shrink-0 bg-canvas-border/70" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <PdfDiffSideSlot
            exists={props.newStage !== null}
            isPdf={newIsPdf}
            emptyLabel="Deleted"
            cardLabel="New"
            effectivePath={props.filePath}
            sizeBytes={props.sizeBytes}
            onView={() => setViewSide("new")}
            onOpenExternally={props.onOpenExternally}
            openExternallyOpening={props.openExternallyOpening}
          />
        </div>
      </div>
      {props.onOpenExternally !== null ? (
        <div className="flex shrink-0 items-center justify-center border-t border-canvas-border/70 p-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.openExternallyOpening}
            onClick={props.onOpenExternally}
          >
            {props.openExternallyOpening ? (
              <AgentSpinningDots
                className="size-4"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Open Externally
          </Button>
        </div>
      ) : null}
      {viewSide !== null ? (
        // Mounted per viewing session (the dialog's own state initializer
        // re-arms to the clicked side); unmount on close.
        <PdfViewDialog
          open
          onOpenChange={(open) => {
            if (!open) setViewSide(null);
          }}
          runningDir={props.runningDir}
          filePath={props.filePath}
          previousPath={props.previousPath}
          revisionKey={props.revisionKey}
          oldStage={oldIsPdf ? props.oldStage : null}
          newStage={newIsPdf ? props.newStage : null}
          initialSide={viewSide}
          onOpenExternally={props.onOpenExternally}
          openExternallyOpening={props.openExternallyOpening}
        />
      ) : null}
    </div>
  );
}
