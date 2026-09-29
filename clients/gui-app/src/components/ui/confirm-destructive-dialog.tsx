import { useRef, type ReactNode, type ComponentProps } from "react";
import { AlertTriangle } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ConfirmDestructiveDialogProps {
  children?: ReactNode;
  /** Let navigation closes retain destination focus instead of restoring the opener. */
  finalFocus?: ComponentProps<typeof DialogContent>["finalFocus"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Optional cascade summary inlined into the description. Omit when no descendants. */
  cascadeSummary: string | null;
  /** Label for the destructive action button (e.g. "Delete" or "Remove"). */
  actionLabel: string;
  isPending: boolean;
  /**
   * Why this action cannot be performed at all, or `null` when it can.
   *
   * Disables confirm and renders the reason. Deliberately not optional: a
   * caller that can be blocked and a caller that never is must both say so,
   * because the failure of the omitted case is an enabled destructive button.
   *
   * For a MULTI-target action the reason must name the blocking targets. A
   * refusal that does not say which row to deselect turns a clean refusal into
   * a dead end - the whole reason refusing beats partially succeeding is that
   * the user can act on it.
   */
  blockedReason: string | null;
  onConfirm: () => void;
}

export function ConfirmDestructiveDialog(props: ConfirmDestructiveDialogProps) {
  const {
    open,
    onOpenChange,
    title,
    description,
    cascadeSummary,
    actionLabel,
    isPending,
    blockedReason,
    onConfirm,
  } = props;

  // Capture before Base moves focus; menu-triggered openers may disconnect.
  const openerRef = useRef<HTMLElement | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (isPending) details.cancel();
        else onOpenChange(next);
      }}
    >
      <DialogContent
        layout="banded"
        showCloseButton={false}
        className="w-[min(92vw,28rem)] overflow-hidden sm:max-w-md"
        data-testid="confirm-destructive-dialog"
        initialFocus={() => {
          const active = document.activeElement;
          openerRef.current =
            active instanceof HTMLElement && active !== document.body
              ? active
              : null;
          return true;
        }}
        finalFocus={(interaction) => {
          const opener = openerRef.current;
          openerRef.current = null;
          if (typeof props.finalFocus === "function")
            return props.finalFocus(interaction);
          if (props.finalFocus !== undefined)
            return typeof props.finalFocus === "object"
              ? props.finalFocus.current
              : props.finalFocus;
          return opener?.isConnected ? opener : false;
        }}
      >
        <div className="flex min-w-0 items-start gap-3 p-5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="size-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <DialogTitle className="wrap-anywhere">{title}</DialogTitle>
            <DialogDescription className="wrap-anywhere">
              {description}
            </DialogDescription>
            {cascadeSummary !== null ? (
              <p
                className="text-ui-sm leading-relaxed text-muted-foreground"
                data-testid="confirm-cascade-meta"
              >
                This will also delete{" "}
                <span className="font-medium text-foreground">
                  {cascadeSummary}
                </span>{" "}
                nested under it.
              </p>
            ) : null}
            {blockedReason !== null ? (
              <p
                className="text-ui-sm leading-relaxed font-medium text-destructive wrap-anywhere"
                data-testid="confirm-blocked-reason"
              >
                {blockedReason}
              </p>
            ) : null}
          </div>
        </div>

        {props.children}

        <div className="flex justify-end gap-2 border-t border-border/60 bg-foreground/3 px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => {
              onOpenChange(false);
            }}
            data-testid="confirm-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={isPending || blockedReason !== null}
            onClick={onConfirm}
            data-testid="confirm-action"
          >
            {isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            {actionLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
