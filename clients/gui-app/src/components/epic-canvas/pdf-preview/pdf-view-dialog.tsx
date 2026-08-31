/**
 * Full-size PDF viewing surface for the diff tile's per-side "View" cards
 * (PDF preview design, Q7 follow-up): one side at a time, full width, the
 * complete `PdfPreview` toolbar - page nav and search are actually usable
 * here, which they never would be at half-a-tile width. Takes a REQUEST
 * DESCRIPTOR (git stream coordinates), never pre-fetched bytes, so the
 * Old/New toggle is just re-pointing `useFileAsset` at the other side -
 * both sides ride the same blob cache as every other asset consumer.
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { BinaryPlaceholder } from "@/components/epic-canvas/binary-placeholder";
import { PdfPreviewLazy } from "./pdf-preview-lazy";
import {
  useFileAsset,
  type FileAssetRequest,
  type UseFileAssetResult,
} from "@/hooks/assets/use-file-asset";

export type PdfViewSide = "old" | "new";

export interface PdfViewDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly runningDir: string;
  readonly filePath: string;
  readonly previousPath: string | null;
  /** Same value as the diff tile's `gitImageDiffRevisionKey` - see `ImageDiffViewProps.revisionKey` for why it must thread into the git request. */
  readonly revisionKey: string;
  /** Stage each side is requested at; `null` = that side does not exist and its toggle is not offered. */
  readonly oldStage: "staged" | "unstaged" | null;
  readonly newStage: "staged" | "unstaged" | null;
  /** Which side the opening card asked for. */
  readonly initialSide: PdfViewSide;
  readonly onOpenExternally: (() => void) | null;
  readonly openExternallyOpening: boolean;
}

function renderBody(
  asset: UseFileAssetResult,
  side: PdfViewSide,
  effectivePath: string,
  props: PdfViewDialogProps,
): ReactNode {
  if (asset.status === "fallback") {
    return (
      <BinaryPlaceholder
        fileName={effectivePath}
        sizeBytes={asset.totalBytes}
        reason={asset.reason}
        onOpenExternally={props.onOpenExternally}
        openExternallyOpening={props.openExternallyOpening}
        compact={false}
      />
    );
  }
  if (asset.status === "ready" && asset.url !== null) {
    return (
      <PdfPreviewLazy
        // Both sides share one mounted dialog; the key forces a clean
        // document swap (fresh pdf.js viewer state) on toggle.
        key={side}
        url={asset.url}
        fileName={effectivePath}
        // The dialog header already shows the path - compact drops the
        // viewer's own caption so it is not repeated one row below.
        compact
        toolbarActions={null}
        onRenderFailure={asset.reportDecodeFailure}
      />
    );
  }
  return (
    <div className="flex size-full items-center justify-center">
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
      />
    </div>
  );
}

export function PdfViewDialog(props: PdfViewDialogProps): ReactNode {
  // The card the user clicked decides the starting side. The parent mounts
  // this component PER VIEWING SESSION (conditional render while open), so
  // the state initializer is the whole re-arm story - no open-tracking
  // effect needed.
  const [side, setSide] = useState<PdfViewSide>(props.initialSide);

  const stageFor = side === "old" ? props.oldStage : props.newStage;
  const request = useMemo<FileAssetRequest | null>(() => {
    if (!props.open || stageFor === null) return null;
    return {
      method: "git",
      runningDir: props.runningDir,
      filePath: props.filePath,
      previousPath: props.previousPath,
      side,
      stage: stageFor,
      coalesceRevision: props.revisionKey,
    };
  }, [
    props.open,
    stageFor,
    props.runningDir,
    props.filePath,
    props.previousPath,
    side,
    props.revisionKey,
  ]);
  const asset = useFileAsset(request);

  const effectivePath =
    side === "old" ? (props.previousPath ?? props.filePath) : props.filePath;
  const bothSidesExist = props.oldStage !== null && props.newStage !== null;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex h-[85vh] w-full max-w-5xl flex-col gap-2 p-3">
        <DialogHeader className="flex-row items-center gap-2 space-y-0 pr-8">
          <DialogTitle className="min-w-0 flex-1 truncate text-left text-sm font-medium">
            {effectivePath}
          </DialogTitle>
          {bothSidesExist ? (
            <div
              className="flex shrink-0 items-center gap-1"
              role="group"
              aria-label="Version"
            >
              <Button
                type="button"
                variant={side === "old" ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={side === "old"}
                onClick={() => setSide("old")}
              >
                Old
              </Button>
              <Button
                type="button"
                variant={side === "new" ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={side === "new"}
                onClick={() => setSide("new")}
              >
                New
              </Button>
            </div>
          ) : null}
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {renderBody(asset, side, effectivePath, props)}
        </div>
      </DialogContent>
    </Dialog>
  );
}
