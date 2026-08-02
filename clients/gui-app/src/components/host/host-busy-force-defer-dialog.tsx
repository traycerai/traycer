import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

export interface HostBusyForceDeferDialogProps {
  readonly open: boolean;
  readonly message: string;
  readonly isForcing: boolean;
  readonly forceLabel: string;
  readonly onForce: () => void;
  readonly onDefer: () => void;
}

/**
 * Shown when a host update/activation intent settles `"busy"`: another
 * Traycer surface (or the host's own boot) already holds the mutation lane.
 * Defer just dismisses - the next launch's boot converge reconciles it, so
 * there is nothing to abandon. Force's target intent is the caller's choice
 * (see each call site): a `continuation: "retry-with-force"` outcome
 * re-submits the same pre-commit intent with `force`; a `continuation:
 * "activate"` outcome (post-commit, packaged macOS) submits
 * `activateInstalled{force}` instead, never re-running the already-consumed
 * apply/pin.
 */
export function HostBusyForceDeferDialog(props: HostBusyForceDeferDialogProps) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={
        props.isForcing
          ? undefined
          : (open) => {
              if (!open) props.onDefer();
            }
      }
    >
      <DialogContent
        showCloseButton={false}
        className="w-[min(92vw,28rem)] gap-0 overflow-hidden p-0 sm:max-w-md"
        data-testid="host-busy-force-defer-dialog"
      >
        <div className="flex flex-col gap-1.5 p-5">
          <DialogTitle className="text-ui font-semibold leading-snug">
            Host is busy
          </DialogTitle>
          <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground">
            {props.message}
          </DialogDescription>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/60 bg-muted/20 px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={props.isForcing}
            onClick={props.onDefer}
            data-testid="host-busy-defer"
          >
            Defer
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={props.isForcing}
            onClick={props.onForce}
            data-testid="host-busy-force"
          >
            {props.isForcing ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            {props.forceLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
