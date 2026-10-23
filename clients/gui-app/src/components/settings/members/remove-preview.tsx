import type { ReactNode } from "react";
import {
  CANCEL_LABEL,
  CANNOT_RECALL_LABEL,
  LINKED_PLAN_LABEL,
  REMOVE_LABEL,
  SHARED_SIGN_INS_LABEL,
  paidSandboxesLabel,
  removeActivityLine,
  removeCannotRecall,
  removeConfirmLabel,
  removeLinkedPlanConsequence,
  removePaidSandboxesConsequence,
  removePendingUntilDone,
  removePreviewLead,
  removePreviewTitle,
  removeSharedSignInConsequence,
  removeTimingRule,
  removeWorkNowLabel,
} from "@/components/settings/members/copy";
import {
  PreviewTable,
  type PreviewTableRow,
} from "@/components/settings/members/preview-table";
import type { RemovePreviewModel } from "@/components/settings/members/types";
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
  teamName: string,
  preview: RemovePreviewModel,
): readonly PreviewTableRow[] {
  const rows: PreviewTableRow[] = [];
  const activity = removeActivityLine(preview);
  const workNow =
    activity === null
      ? removeTimingRule(preview.memberName)
      : `${activity}. ${removeTimingRule(preview.memberName)}`;
  rows.push({
    label: removeWorkNowLabel(preview.memberName),
    value: workNow,
  });
  if (preview.sharedSignIns.length > 0) {
    rows.push({
      label: SHARED_SIGN_INS_LABEL,
      value: removeSharedSignInConsequence(teamName),
    });
  }
  rows.push({
    label: paidSandboxesLabel(preview.memberName),
    value: removePaidSandboxesConsequence(
      preview.memberName,
      teamName,
      preview.paidSandboxes,
    ),
  });
  rows.push({
    label: LINKED_PLAN_LABEL,
    value: removeLinkedPlanConsequence(preview.linkedPlan),
  });
  rows.push({
    label: CANNOT_RECALL_LABEL,
    value: removeCannotRecall(preview.memberName, teamName),
  });
  return rows;
}

/**
 * Offboarding preview for an accepted member. Omits the activity line when
 * turns, terminals, or hostName are null. Never names a clock.
 */
export function RemovePreviewDialog(props: {
  readonly open: boolean;
  readonly teamName: string;
  readonly preview: RemovePreviewModel | null;
  readonly busy: boolean;
  readonly blockedReason: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const preview = props.preview;
  const title =
    preview === null
      ? REMOVE_LABEL
      : removePreviewTitle(preview.memberName, props.teamName);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        data-testid="members-remove-preview"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {preview === null
              ? ""
              : removePreviewLead(preview.memberName, props.teamName)}
          </DialogDescription>
        </DialogHeader>
        {preview === null ? (
          <AgentSpinningDots
            className={undefined}
            testId="members-remove-preview-busy"
            variant={undefined}
            tone="muted"
          />
        ) : (
          <>
            <PreviewTable
              testId="members-remove-preview-table"
              rows={removePreviewRows(props.teamName, preview)}
            />
            <p className="max-w-[72ch] text-ui-xs text-muted-foreground">
              {removePendingUntilDone(preview.memberName, props.teamName)}
            </p>
          </>
        )}
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
              props.busy || preview === null || props.blockedReason !== null
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
            {preview === null
              ? REMOVE_LABEL
              : removeConfirmLabel(preview.memberName)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
