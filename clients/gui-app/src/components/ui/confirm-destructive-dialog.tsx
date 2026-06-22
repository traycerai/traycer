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
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Optional cascade summary inlined into the description. Omit when no descendants. */
  cascadeSummary: string | null;
  /** Label for the destructive action button (e.g. "Delete" or "Remove"). */
  actionLabel: string;
  isPending: boolean;
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
    onConfirm,
  } = props;

  return (
    <Dialog open={open} onOpenChange={isPending ? undefined : onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(92vw,28rem)] gap-0 overflow-hidden p-0 sm:max-w-md"
        data-testid="confirm-destructive-dialog"
      >
        <div className="flex min-w-0 items-start gap-3 p-5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="size-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <DialogTitle className="text-ui font-semibold leading-snug wrap-anywhere">
              {title}
            </DialogTitle>
            <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground wrap-anywhere">
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
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border/60 bg-muted/20 px-5 py-3">
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
            disabled={isPending}
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
