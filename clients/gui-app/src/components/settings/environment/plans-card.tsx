import { useState, type ReactNode } from "react";
import { SettingsMasterSelect } from "@/components/settings/settings-master-detail";
import { Button } from "@/components/ui/button";

export interface ConfigurationPlan {
  readonly id: string;
  readonly bindingVersion?: number | null;
  readonly linkedBy: string | null;
  readonly status?: "linked" | "pending" | "expired";
  readonly providerLabel: string;
}

/** A team's linked subscriptions: one plan in the picker, one action row. */
export function PlansCard(props: {
  readonly teamName: string;
  readonly plans: readonly ConfigurationPlan[];
  readonly canEdit: boolean;
  readonly isPending: boolean;
  readonly onLink: () => void;
  readonly onPreviewUnlink: (plan: ConfigurationPlan) => void;
}): ReactNode {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const selected =
    props.plans.length === 0
      ? null
      : (props.plans.find((plan) => plan.id === pickedId) ?? props.plans[0]);
  const quota =
    selected === null ? null : planQuotaSentence(selected, props.teamName);
  return (
    <section className="flex flex-col gap-3" aria-label="Plans">
      <h2 className="text-ui-sm font-medium">Plans</h2>
      {selected === null ? (
        <p className="text-ui-sm text-muted-foreground">No plans yet.</p>
      ) : (
        <LinkedPlanPicker
          plans={props.plans}
          selected={selected}
          onSelect={setPickedId}
        />
      )}
      <PlanActionRow
        canEdit={props.canEdit}
        isPending={props.isPending}
        selected={selected}
        onLink={props.onLink}
        onPreviewUnlink={props.onPreviewUnlink}
      />
      {quota === null ? null : (
        <p className="text-ui-xs text-muted-foreground">{quota}</p>
      )}
      {!props.canEdit ? (
        <p className="text-ui-xs text-muted-foreground">
          Ask a teammate to sign in on Providers.
        </p>
      ) : null}
    </section>
  );
}

function LinkedPlanPicker(props: {
  readonly plans: readonly ConfigurationPlan[];
  readonly selected: ConfigurationPlan;
  readonly onSelect: (planId: string) => void;
}): ReactNode {
  return (
    <>
      <SettingsMasterSelect
        label="Plan"
        value={props.selected.id}
        options={props.plans.map((plan) => ({
          value: plan.id,
          label: planOptionLabel(plan),
          icon: null,
          trailing: null,
        }))}
        onSelect={props.onSelect}
      />
      <p className="text-ui-xs text-muted-foreground">
        {planStanding(props.selected)}
      </p>
    </>
  );
}

function PlanActionRow(props: {
  readonly canEdit: boolean;
  readonly isPending: boolean;
  readonly selected: ConfigurationPlan | null;
  readonly onLink: () => void;
  readonly onPreviewUnlink: (plan: ConfigurationPlan) => void;
}): ReactNode {
  if (!props.canEdit) return null;
  const selected = props.selected;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={props.isPending}
        onClick={props.onLink}
      >
        Sign in
      </Button>
      {selected === null ? null : (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={props.isPending}
          onClick={() => props.onPreviewUnlink(selected)}
        >
          Unlink
        </Button>
      )}
    </div>
  );
}

function planOptionLabel(plan: ConfigurationPlan): string {
  const owner = plan.linkedBy === null ? "" : `${plan.linkedBy}’s `;
  return `${owner}${plan.providerLabel} plan`;
}

function planStanding(plan: ConfigurationPlan): string {
  if (plan.status === "pending") return "Sign-in is pending.";
  if (plan.status === "expired") return "Sign-in expired.";
  return "Signed in";
}

function planQuotaSentence(
  plan: ConfigurationPlan,
  teamName: string,
): string | null {
  if (plan.status === "pending" || plan.status === "expired") return null;
  return `Shared ${plan.providerLabel} quota. Sandbox charges use ${teamName} credits.`;
}
