import { useState, type ReactNode } from "react";
import { SettingsMasterSelect } from "@/components/settings/settings-master-detail";
import { Button } from "@/components/ui/button";

export interface ConfigurationPlan {
  readonly id: string;
  readonly linkedBy: string | null;
  readonly status?: "linked" | "pending" | "expired";
  readonly providerLabel: string;
}

/** A team's linked subscriptions: one plan in the picker, one action row. */
export function PlansCard(props: {
  readonly teamName: string;
  readonly plans: readonly ConfigurationPlan[];
  readonly canAdminister: boolean;
  readonly adminNames: readonly string[];
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
        <p className="text-ui-sm text-muted-foreground">No plans linked.</p>
      ) : (
        <LinkedPlanPicker
          plans={props.plans}
          selected={selected}
          onSelect={setPickedId}
        />
      )}
      <PlanActionRow
        canAdminister={props.canAdminister}
        isPending={props.isPending}
        selected={selected}
        onLink={props.onLink}
        onPreviewUnlink={props.onPreviewUnlink}
      />
      {quota === null ? null : (
        <p className="text-ui-xs text-muted-foreground">{quota}</p>
      )}
      {!props.canAdminister ? (
        <p className="text-ui-xs text-muted-foreground">
          {askAnAdminLine(props.adminNames)}
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
        label="Linked plan"
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
  readonly canAdminister: boolean;
  readonly isPending: boolean;
  readonly selected: ConfigurationPlan | null;
  readonly onLink: () => void;
  readonly onPreviewUnlink: (plan: ConfigurationPlan) => void;
}): ReactNode {
  if (!props.canAdminister) return null;
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
        Link a plan
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

/**
 * What a reader who cannot link a plan is told: who to ask, two admins by
 * name and the rest by count, so a long list stays one line.
 */
function askAnAdminLine(adminNames: readonly string[]): string {
  const opening = "Only an admin can link a plan";
  const [first, second] = adminNames;
  if (adminNames.length === 0) return `${opening}.`;
  if (adminNames.length === 1) return `${opening}: ask ${first}.`;
  if (adminNames.length === 2) return `${opening}: ask ${first} or ${second}.`;
  const others = adminNames.length - 2;
  return `${opening}: ask ${first}, ${second} or ${others === 1 ? "1 other" : `${others} others`}.`;
}
