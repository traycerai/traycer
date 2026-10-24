import type { ReactNode } from "react";
import {
  AFTERWARDS_LABEL,
  AGENTS_ON_PLAN_LABEL,
  CANCEL_LABEL,
  CHANGE_ROLE_LABEL,
  RETRY_LABEL,
  WHAT_KEEPS_WORKING_LABEL,
  WHO_PAYS_LABEL,
  demotionLossLine,
  demotionPreviewFailed,
  demotionTitle,
  planUnlinkAfterwards,
  planUnlinkLead,
  planUnlinkTurnsLineFor,
  planUnlinkWhoPays,
} from "@/components/settings/members/copy";
import {
  PreviewTable,
  type PreviewTableRow,
} from "@/components/settings/members/preview-table";
import type {
  PlanUnlinkPreviewModel,
  PreviewState,
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

function demotionRows(
  teamName: string,
  preview: PlanUnlinkPreviewModel,
): readonly PreviewTableRow[] {
  return [
    {
      label: AGENTS_ON_PLAN_LABEL,
      value: planUnlinkTurnsLineFor(teamName, preview.turnsOnPlan),
    },
    {
      label: WHAT_KEEPS_WORKING_LABEL,
      value: preview.whatKeepsWorking,
    },
    {
      label: AFTERWARDS_LABEL,
      value: planUnlinkAfterwards(teamName),
    },
    {
      label: WHO_PAYS_LABEL,
      value: planUnlinkWhoPays(),
    },
  ];
}

/**
 * Demotion preview: the plan-unlink table plus the admin-powers loss line. A
 * preview that could not be read says so, offers Retry, and keeps Change role
 * off.
 */
export function DemotionPreviewDialog(props: {
  readonly open: boolean;
  readonly memberName: string;
  readonly teamName: string;
  readonly nextRoleLabel: string;
  readonly preview: PreviewState<PlanUnlinkPreviewModel>;
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
        data-testid="members-demotion-preview"
      >
        <DialogHeader>
          <DialogTitle>
            {demotionTitle(props.memberName, props.teamName)}
          </DialogTitle>
          <DialogDescription>
            {planUnlinkLead(props.teamName)}
          </DialogDescription>
        </DialogHeader>
        {preview.status === "loading" ? (
          <AgentSpinningDots
            className={undefined}
            testId="members-demotion-preview-busy"
            variant={undefined}
            tone="muted"
          />
        ) : null}
        {preview.status === "failed" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p
              className="max-w-[72ch] text-ui-sm text-destructive"
              role="status"
              data-testid="members-demotion-preview-failed"
            >
              {demotionPreviewFailed(props.memberName)}
            </p>
            <Button type="button" variant="outline" onClick={props.onRetry}>
              {RETRY_LABEL}
            </Button>
          </div>
        ) : null}
        {preview.status === "ready" ? (
          <>
            <PreviewTable
              testId="members-demotion-preview-table"
              rows={demotionRows(props.teamName, preview.preview)}
            />
            <p
              className="max-w-[72ch] text-ui-sm"
              data-testid="members-demotion-loss"
            >
              {demotionLossLine(props.memberName)}
            </p>
          </>
        ) : null}
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
            disabled={
              props.busy ||
              preview.status !== "ready" ||
              props.blockedReason !== null
            }
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
            {CHANGE_ROLE_LABEL}
            {props.nextRoleLabel.length === 0
              ? ""
              : ` · ${props.nextRoleLabel}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
