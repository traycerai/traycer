import type { ReactNode } from "react";
import {
  CANCEL_LABEL,
  demotionConfirmBody,
  demotionConfirmLabel,
  demotionConfirmTitle,
} from "@/components/settings/members/copy";
import type { TeamRole } from "@/components/settings/members/types";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The confirm on a demotion: the question and what the role loses. It reads
 * nothing, so it opens at once. A promotion never opens it.
 */
export function DemotionPreviewDialog(props: {
  readonly open: boolean;
  readonly memberName: string;
  readonly teamName: string;
  readonly currentRole: TeamRole;
  readonly nextRole: TeamRole;
  readonly busy: boolean;
  readonly blockedReason: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}): ReactNode {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        data-testid="members-demotion-preview"
      >
        <DialogHeader>
          <DialogTitle>
            {demotionConfirmTitle(
              props.memberName,
              props.teamName,
              props.nextRole,
            )}
          </DialogTitle>
          {/* What the role loses is the consequence the question asks to
              confirm, so it is the description: Radix announces
              `Dialog.Description` and nothing else beside the title. */}
          <DialogDescription asChild>
            <div className="flex max-w-[72ch] flex-col gap-2">
              <span data-testid="members-demotion-loss">
                {demotionConfirmBody(
                  props.memberName,
                  props.currentRole,
                  props.nextRole,
                )}
              </span>
            </div>
          </DialogDescription>
        </DialogHeader>
        {props.blockedReason === null ? null : (
          <p
            className="max-w-[72ch] text-ui-sm text-destructive"
            role="status"
            data-testid="members-demotion-refusal"
          >
            {props.blockedReason}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => props.onOpenChange(false)}
          >
            {CANCEL_LABEL}
          </Button>
          <Button
            type="button"
            onClick={props.onConfirm}
            disabled={props.busy || props.blockedReason !== null}
            data-testid="members-demotion-confirm"
          >
            {props.busy ? (
              <AgentSpinningDots
                className={undefined}
                testId="members-demotion-confirm-busy"
                variant={undefined}
                tone="inherit"
              />
            ) : null}
            {demotionConfirmLabel(props.nextRole)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
