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
 * Fullscreen wireframe preview. Override `sm:max-w-none` and `showCloseButton={false}` so close + copy live in the header.
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
