import { Copy, Download, X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { Kbd } from "@/components/ui/kbd";
import { PanZoomSvgViewer } from "./pan-zoom-svg-viewer";

export interface MermaidFullscreenDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly svg: string;
  readonly code: string;
  readonly title: string;
  readonly onCopyCode: () => void;
  readonly onDownloadPng: () => void;
  readonly downloadDisabled: boolean;
}

/**
 * Fullscreen mermaid preview. Same dialog shell as the wireframe variant -
 * title + Copy + Download + Close in the header. Body delegates to
 * `PanZoomSvgViewer` for read-only pan, zoom, fit, and keyboard control.
 */
export function MermaidFullscreenDialog(props: MermaidFullscreenDialogProps) {
  const {
    open,
    onOpenChange,
    svg,
    code,
    title,
    onCopyCode,
    onDownloadPng,
    downloadDisabled,
  } = props;
  const ariaLabel =
    code.split("\n").find((l) => l.trim().length > 0) ?? "Mermaid diagram";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(95vw,80rem)] sm:max-w-none max-w-[95vw] h-[min(90vh,60rem)] max-h-[90vh] p-0 gap-0 overflow-hidden flex flex-col"
      >
        <DialogHeader className="flex flex-row items-center justify-between gap-2 px-4 py-2 border-b shrink-0">
          <DialogTitle className="text-ui-sm font-medium truncate">
            {title}
          </DialogTitle>
          <div className="flex items-center gap-1">
            <TooltipWrapper
              label="Copy code"
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onCopyCode}
                aria-label="Copy code"
              >
                <Copy className="size-4" aria-hidden="true" />
              </Button>
            </TooltipWrapper>
            <TooltipWrapper
              label="Download PNG"
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onDownloadPng}
                aria-label="Download PNG"
                disabled={downloadDisabled}
              >
                <Download className="size-4" aria-hidden="true" />
              </Button>
            </TooltipWrapper>
            <TooltipWrapper
              label={
                <>
                  Close <Kbd>Esc</Kbd>
                </>
              }
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <DialogClose asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close fullscreen preview"
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </DialogClose>
            </TooltipWrapper>
          </div>
        </DialogHeader>
        <div className="flex-1 min-h-0 bg-canvas tc-node-mermaid__fullscreen-body">
          {svg.length > 0 ? (
            <PanZoomSvgViewer
              svg={svg}
              ariaLabel={ariaLabel}
              className={undefined}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
