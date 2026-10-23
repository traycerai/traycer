import type { ReactNode } from "react";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import type { ConfigurationPlan } from "./plans-card";

export function PlanUnlinkPreview(props: {
  readonly teamName: string;
  readonly plan: ConfigurationPlan;
  readonly activeTurns: number | null;
  readonly activeHostName?: string | null;
  readonly remainingAccess: readonly string[];
  readonly isPending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const name = `${props.plan.linkedBy === null ? "" : `${props.plan.linkedBy}’s `}${props.plan.providerLabel} plan`;
  return (
    <ConfirmDestructiveDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={`Unlink ${name} from ${props.teamName}`}
      description={`${props.teamName}'s agents stop using this plan.`}
      cascadeSummary={null}
      actionLabel="Unlink"
      isPending={props.isPending}
      blockedReason={null}
      onConfirm={props.onConfirm}
    >
      <dl className="flex flex-col gap-3 px-5 pb-5 text-ui-sm">
        <div>
          <dt className="font-medium">Agents on it now</dt>
          <dd className="text-muted-foreground">
            {props.activeTurns === null
              ? "Active turns could not be counted."
              : `${props.activeTurns} active turns.`}{" "}
            {(props.activeHostName ?? null) === null
              ? null
              : `On ${props.activeHostName} only. `}
            Each finishes its current step, then stops. No new turn can use the
            unlinked plan.
          </dd>
        </div>
        <div>
          <dt className="font-medium">What keeps working</dt>
          <dd className="text-muted-foreground">
            {props.remainingAccess.length === 0
              ? "No other plans or keys are set."
              : props.remainingAccess.join(", ") + "."}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Afterwards</dt>
          <dd className="text-muted-foreground">
            {props.teamName}'s {props.plan.providerLabel} plan was unlinked. An
            admin can link one. A host that has not confirmed keeps the unlink
            pending.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Sandboxes</dt>
          <dd className="text-muted-foreground">
            Sandbox charges use {props.teamName} credits. No sandbox's payer
            changes.
          </dd>
        </div>
      </dl>
    </ConfirmDestructiveDialog>
  );
}
