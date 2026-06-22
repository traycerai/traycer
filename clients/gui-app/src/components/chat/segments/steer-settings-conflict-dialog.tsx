import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SteerSettingsConflictDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRestart: () => void;
  // Human-readable labels of the settings that differ from the running turn,
  // e.g. ["model", "reasoning effort"]. Drives the dialog copy.
  readonly changed: ReadonlyArray<string>;
}

/**
 * Shown when the owner steers a queued prompt while the live toolbar carries a
 * turn-start-baked change (model / reasoning / service tier / agent mode) that
 * the running turn can't absorb. Confirming ends the current turn and re-sends
 * the prompt under the new settings (the host resumes or forks per harness);
 * Cancel leaves the prompt queued and the turn running. Native dialog/button
 * keyboard behavior owns Enter/Esc. No in-dialog pending state - the queue/turn
 * reflects the result.
 */
export function SteerSettingsConflictDialog(
  props: SteerSettingsConflictDialogProps,
) {
  const { changed, onOpenChange, onRestart, open } = props;
  const changeList = changed.length > 0 ? changed.join(", ") : "these settings";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-full min-w-0 gap-0 overflow-hidden p-0"
        style={{ maxWidth: "min(92vw, 34rem)" }}
        showCloseButton={false}
        data-testid="steer-settings-conflict-dialog"
      >
        <DialogHeader className="space-y-1 px-6 pt-6 pb-2">
          <DialogTitle className="text-base font-semibold">
            End the current turn to send with new settings?
          </DialogTitle>
          <DialogDescription>
            The current turn is running with different {changeList}. Sending
            this message now will end the current turn and re-send it under the
            new settings.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="mx-0 mb-0 mt-2 gap-2 rounded-b-xl border-t border-border/40 bg-muted/10 px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel <span className="text-muted-foreground/70">(esc)</span>
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onRestart}
            data-testid="steer-settings-conflict-confirm"
          >
            End turn &amp; send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
