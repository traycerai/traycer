import type { ReactNode } from "react";
import {
  CANCEL_LABEL,
  CANNOT_RECALL_LABEL,
  LINKED_PLAN_LABEL,
  RETRY_LABEL,
  SHARED_SIGN_INS_LABEL,
  paidSandboxesLabel,
  removeCannotRecall,
  removeConfirmLabel,
  removeLinkedPlanConsequence,
  removePaidSandboxesConsequence,
  removePendingUntilDone,
  removePreviewFailed,
  removePreviewLead,
  removePreviewTitle,
  removeSharedSignInConsequence,
  removeWorkNow,
  removeWorkNowLabel,
} from "@/components/settings/members/copy";
import {
  PreviewTable,
  type PreviewTableRow,
} from "@/components/settings/members/preview-table";
import type {
  PreviewState,
  RemovePreviewModel,
} from "@/components/settings/members/types";
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

function removePreviewRows(
  memberName: string,
  teamName: string,
  preview: RemovePreviewModel,
): readonly PreviewTableRow[] {
  return [
    {
      label: removeWorkNowLabel(memberName),
      value: removeWorkNow(memberName, preview),
    },
    {
      label: SHARED_SIGN_INS_LABEL,
      value: removeSharedSignInConsequence(teamName, preview.sharedSignIns),
    },
    {
      label: paidSandboxesLabel(memberName),
      value: removePaidSandboxesConsequence(
        memberName,
        teamName,
        preview.paidSandboxes,
      ),
    },
    {
      label: LINKED_PLAN_LABEL,
      value: removeLinkedPlanConsequence(preview.linkedPlan),
    },
    {
      label: CANNOT_RECALL_LABEL,
      value: removeCannotRecall(memberName, teamName),
    },
  ];
}

/**
 * Offboarding preview for an accepted member. Every row shows each time,
 * "None." when it has nothing; work the serving host cannot count is never
 * given a count. Never names a clock. A preview that could not be read says
 * so, offers Retry, and keeps Remove off: nothing is shown as a consequence
 * that was not read.
 */
export function RemovePreviewDialog(props: {
  readonly open: boolean;
  readonly memberName: string;
  readonly memberEmail: string | null;
  /** The confirm button's name for the member: their first name. */
  readonly confirmName: string;
  readonly teamName: string;
  readonly preview: PreviewState<RemovePreviewModel>;
  readonly busy: boolean;
  readonly blockedReason: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRetry: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const preview = props.preview;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        data-testid="members-remove-preview"
      >
        <DialogHeader>
          <DialogTitle>
            {removePreviewTitle(
              props.memberName,
              props.memberEmail,
              props.teamName,
            )}
          </DialogTitle>
          <DialogDescription>
            {removePreviewLead(props.memberName, props.teamName)}
          </DialogDescription>
        </DialogHeader>
        {preview.status === "loading" ? (
          <AgentSpinningDots
            className={undefined}
            testId="members-remove-preview-busy"
            variant={undefined}
            tone="muted"
          />
        ) : null}
        {preview.status === "failed" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p
              className="max-w-[72ch] text-ui-sm text-destructive"
              role="status"
              data-testid="members-remove-preview-failed"
            >
              {removePreviewFailed(props.memberName)}
            </p>
            <Button type="button" variant="outline" onClick={props.onRetry}>
              {RETRY_LABEL}
            </Button>
          </div>
        ) : null}
        {preview.status === "ready" ? (
          <>
            <PreviewTable
              testId="members-remove-preview-table"
              rows={removePreviewRows(
                props.memberName,
                props.teamName,
                preview.preview,
              )}
            />
            <p className="max-w-[72ch] text-ui-xs text-muted-foreground">
              {removePendingUntilDone(props.memberName, props.teamName)}
            </p>
          </>
        ) : null}
        {props.blockedReason === null ? null : (
          <p
            className="max-w-[72ch] text-ui-sm text-destructive"
            role="status"
            data-testid="members-remove-refusal"
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
            variant="destructive"
            onClick={props.onConfirm}
            disabled={
              props.busy ||
              preview.status !== "ready" ||
              props.blockedReason !== null
            }
            data-testid="members-remove-confirm"
          >
            {props.busy ? (
              <AgentSpinningDots
                className={undefined}
                testId="members-remove-confirm-busy"
                variant={undefined}
                tone="inherit"
              />
            ) : null}
            {removeConfirmLabel(props.confirmName)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
