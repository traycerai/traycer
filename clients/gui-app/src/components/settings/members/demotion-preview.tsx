import type { ReactNode } from "react";
import {
  AFTERWARDS_LABEL,
  AGENTS_ON_PLAN_LABEL,
  CANCEL_LABEL,
  RETRY_LABEL,
  WHAT_KEEPS_WORKING_LABEL,
  WHO_PAYS_LABEL,
  demotionConfirmBody,
  demotionConfirmLabel,
  demotionConfirmTitle,
  demotionPreviewFailed,
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
  TeamRole,
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
 * The confirm on a demotion: the question, what the role loses, and the
 * plan-unlink table only when this member linked a plan the demotion unlinks.
 * A promotion never opens it. A preview that could not be read says so and
 * offers Retry.
 *
 * Its caller opens it only once the check has answered, so everything the
 * question is about is already in the description when focus arrives; while a
 * Retry is in flight the confirm waits, and the dialog stays up.
 */
export function DemotionPreviewDialog(props: {
  readonly open: boolean;
  readonly memberName: string;
  readonly teamName: string;
  readonly currentRole: TeamRole;
  readonly nextRole: TeamRole;
  readonly preview: PreviewState<PlanUnlinkPreviewModel>;
  readonly busy: boolean;
  readonly blockedReason: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRetry: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const preview = props.preview;
  // The plan rows, where this demotion actually unlinks a plan. Only they
  // need the check's answer; the question and the loss line do not.
  const planRows =
    preview.status === "ready" && preview.preview.planLabel.length > 0
      ? demotionRows(props.teamName, preview.preview)
      : null;
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
          {/* Everything the announcement has to carry is the description.
              Radix announces `Dialog.Description` and nothing else beside the
              title, so a sentence left outside it is a sentence a screen
              reader never reaches — and both of these are about the
              consequence the question is asking to confirm: what the role
              loses, always, and that the team's agents stop using the plan
              where this demotion unlinks one. The description is not a live
              region, which is why the caller waits for the check before
              opening: both sentences are here before focus is. */}
          <DialogDescription asChild>
            <div className="flex max-w-[72ch] flex-col gap-2">
              <span data-testid="members-demotion-loss">
                {demotionConfirmBody(
                  props.memberName,
                  props.teamName,
                  props.currentRole,
                  props.nextRole,
                )}
              </span>
              {planRows === null ? null : (
                <span>{planUnlinkLead(props.teamName)}</span>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
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
        {planRows === null ? null : (
          <PreviewTable
            testId="members-demotion-preview-table"
            rows={planRows}
          />
        )}
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
            // Off while a plan check is in flight — which here is a Retry,
            // since the dialog does not open before the first answer — because
            // what it finds belongs in the question. A check that FAILED does
            // not take the change away: the role is the person's to set, the
            // ruled line about what they lose needs no read, and only the plan
            // rows do.
            disabled={
              props.busy ||
              preview.status === "loading" ||
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
            {demotionConfirmLabel(props.nextRole)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
