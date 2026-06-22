import { Copy, X } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "../../toolbar/toolbar-button";
import { WireframeIframe } from "./wireframe-iframe";

export interface WireframeFullscreenDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly htmlContent: string;
  readonly title: string;
}

/**
 * Fullscreen preview of a wireframe block. Mirrors the inline preview but
 * gives the iframe the full viewport width - useful for wider layouts
 * where the artifact tile cramps the rendered HTML. Copy HTML lives in
 * the header so the user can grab the source without leaving the dialog.
 *
 * The default `DialogContent` ships with `sm:max-w-sm` (24rem) and a
 * built-in absolute close button at `top-2 right-2`. Both fight us here:
 * we want a viewport-filling shell, and the close button collides with
 * the inline Copy HTML action. We override `sm:max-w-none` to win the
 * responsive merge and pass `showCloseButton={false}` so we can lay out
 * the close + copy controls together inside the header.
 */
export function WireframeFullscreenDialog(
  props: WireframeFullscreenDialogProps,
) {
  const { open, onOpenChange, htmlContent, title } = props;

  const handleCopy = (): void => {
    if (typeof navigator === "undefined") return;
    void navigator.clipboard.writeText(htmlContent).then(() => {
      toast.success("HTML copied to clipboard");
    });
  };

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
            <ToolbarButton
              icon={<Copy className="size-4" aria-hidden="true" />}
              label="Copy HTML"
              active={false}
              onClick={handleCopy}
              className="tc-editor-toolbar-button"
            />
            <DialogClose asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close fullscreen preview"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </DialogClose>
          </div>
        </DialogHeader>
        <div className="flex-1 min-h-0 bg-canvas">
          <WireframeIframe
            htmlContent={htmlContent}
            title={title}
            className="tc-node-wireframe__iframe--fullscreen"
            mode="fill"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
