import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SandboxLinkConfirmProps {
  /** The link a page asked to open, or `null` when nothing is asked. */
  readonly url: string | null;
  readonly onDecide: (open: boolean) => void;
}

/**
 * The app's own confirm for a link an agent page, wireframe or MCP App asked
 * to open (D42). The page cannot prove the reader clicked inside it, so the
 * reader sees the whole URL and decides here, outside the page's reach.
 * Cancel comes first, so it is what the dialog focuses; Esc cancels too.
 */
export function SandboxLinkConfirm(props: SandboxLinkConfirmProps) {
  const { url, onDecide } = props;
  return (
    <Dialog
      open={url !== null}
      onOpenChange={(open) => {
        if (!open) onDecide(false);
      }}
    >
      <DialogContent
        layout="banded"
        // Never taller than the safe viewport: the URL scrolls, the actions
        // stay in view however long it is (the bridge caps it at 8 KiB).
        className="flex max-h-[calc(var(--spacing-safe-dvh)-2rem)] w-full min-w-0 flex-col overflow-hidden"
        style={{ maxWidth: "min(92vw, 30rem)" }}
        showCloseButton={false}
      >
        <DialogHeader className="shrink-0 space-y-1">
          <DialogTitle>Open this link?</DialogTitle>
          <DialogDescription>The page wants to open:</DialogDescription>
        </DialogHeader>
        <p
          data-testid="sandbox-link-url"
          className="max-h-[40svh] min-h-0 overflow-y-auto px-5 py-3 font-mono text-ui-sm break-all text-foreground"
        >
          {url}
        </p>
        <DialogFooter className="shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onDecide(false)}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => onDecide(true)}>
            Open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
