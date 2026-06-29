import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

export interface RestartUpdateDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly latestVersion: string | null;
  readonly onConfirm: () => void;
}

/**
 * Confirms the app restart that installs a downloaded update. Restarting is
 * disruptive (open work, running agents), so the install never fires straight
 * from the header tick - the user confirms here first. The blurred backdrop
 * comes from the shared `Dialog` overlay.
 */
export function RestartUpdateDialog(props: RestartUpdateDialogProps) {
  const { open, onOpenChange, latestVersion, onConfirm } = props;
  const [actionState, setActionState] = useState({
    open,
    actionHandled: false,
  });
  const versionLabel =
    latestVersion === null ? "the latest version" : `v${latestVersion}`;

  if (actionState.open !== open) {
    setActionState({ open, actionHandled: false });
  }

  const actionHandled =
    actionState.open === open ? actionState.actionHandled : false;

  function handleConfirm(): void {
    if (actionHandled) return;
    setActionState({ open, actionHandled: true });
    onConfirm();
  }

  return (
    <Dialog open={open} onOpenChange={actionHandled ? undefined : onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(92vw,28rem)] gap-0 overflow-hidden p-0 sm:max-w-md"
        data-testid="restart-update-dialog"
      >
        <div className="flex min-w-0 items-start gap-3 p-5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <RotateCcw className="size-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <DialogTitle className="text-ui font-semibold leading-snug">
              Restart to update Traycer?
            </DialogTitle>
            <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground">
              Traycer will restart to install {versionLabel}. Save your work
              before continuing - any running agents will be interrupted.
            </DialogDescription>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border/60 bg-muted/20 px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={actionHandled}
            onClick={() => {
              onOpenChange(false);
            }}
            data-testid="restart-update-cancel"
          >
            Later
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={actionHandled}
            onClick={handleConfirm}
            data-testid="restart-update-confirm"
          >
            {actionHandled ? (
              <span
                role="status"
                aria-label="Restart request in progress"
                className="inline-flex"
              >
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant={undefined}
                />
              </span>
            ) : null}
            Restart now
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
