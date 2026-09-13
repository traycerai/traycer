import { useRef } from "react";
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

  /**
   * The control the dialog was opened FROM, so Escape and Cancel have somewhere
   * to return the keyboard to.
   *
   * Every caller of this component opens it by setting `open`, from a button
   * rendered outside the dialog's own root - none renders a `DialogTrigger`. So
   * Radix's modal content, which composes its own close handler that calls
   * `preventDefault()` and then focuses `triggerRef.current`, was focusing
   * `null`; and because it had prevented the default, the FocusScope's generic
   * "restore what was focused before" was skipped too. Escape and Cancel
   * therefore dropped focus on `document.body` - a keyboard user was returned
   * to the top of the page after dismissing a dialog they had opened
   * deliberately, and a screen-reader user was told nothing.
   *
   * Captured in `onOpenAutoFocus` rather than in an effect because that is the
   * one moment the opener is still the active element: Radix's FocusScope
   * dispatches it after reading `document.activeElement` and before moving
   * focus into the dialog, and a parent effect would run only after the child
   * scope had already taken it.
   */
  const openerRef = useRef<HTMLElement | null>(null);

  return (
    <Dialog open={open} onOpenChange={isPending ? undefined : onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(92vw,28rem)] gap-0 overflow-hidden p-0 sm:max-w-md"
        data-testid="confirm-destructive-dialog"
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          // `document.body` is what "nothing was focused" looks like, not an
          // opener. Capturing it would make the close handler preventDefault
          // and focus an unfocusable element - the same place Radix ends up,
          // but by overriding a path rather than by leaving it alone.
          openerRef.current =
            active instanceof HTMLElement && active !== document.body
              ? active
              : null;
        }}
        onCloseAutoFocus={(event) => {
          const opener = openerRef.current;
          openerRef.current = null;
          // `isConnected` is not defensiveness - it is what lets this compose
          // with the callers that already handle their own post-confirm focus.
          //
          // Radix runs this handler from a `setTimeout(0)`, so it fires AFTER
          // the commit in which the confirmed action re-rendered. A caller that
          // focuses something itself on that render (`repo-branch-prefix-section`
          // does, and so does `fallback-danger-zone`) would have it stolen back
          // a tick later - except that the reason such a caller needs its own
          // mechanism at all is that its confirmed action REPLACED the subtree
          // holding the opener. So the opener is detached exactly when the
          // caller has a better answer, and this defers to it.
          //
          // Falling through rather than focusing a detached node also costs
          // nothing: `.focus()` on one is a silent no-op, so both paths reach
          // `document.body`. What is returned here is the DECISION, not the
          // outcome.
          if (opener === null || !opener.isConnected) return;
          // Radix's own handler runs only while the default is not prevented,
          // so preventing it here is what stops the null-trigger focus from
          // undoing this.
          event.preventDefault();
          opener.focus();
        }}
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
