import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

export interface ConfigurationPlan {
  readonly id: string;
  readonly linkedBy: string | null;
  readonly status?: "linked" | "pending" | "expired";
  readonly providerLabel: string;
}

/** A team's linked subscriptions; opening Unlink starts the preview. */
export function PlansCard(props: {
  readonly teamName: string;
  readonly plans: readonly ConfigurationPlan[];
  readonly canAdminister: boolean;
  readonly adminNames: readonly string[];
  readonly isPending: boolean;
  readonly renderDetails?: (plan: ConfigurationPlan) => ReactNode;
  readonly onLink: () => void;
  readonly onPreviewUnlink: (plan: ConfigurationPlan) => void;
}): ReactNode {
  return (
    <section className="flex flex-col gap-3" aria-label="Plans">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-ui-sm font-medium">Plans</h2>
        {props.canAdminister ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.isPending}
            onClick={props.onLink}
          >
            Link a plan
            {props.isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
                tone="muted"
              />
            ) : null}
          </Button>
        ) : null}
      </div>
      <div className="divide-y divide-border/60 rounded-lg border border-border/60">
        {props.plans.length === 0 ? (
          <p className="p-3 text-ui-sm text-muted-foreground">
            No plans linked yet.
          </p>
        ) : (
          props.plans.map((plan) => (
            <div
              key={plan.id}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <div className="min-w-0">
                <p className="text-ui-sm font-medium">
                  {plan.linkedBy === null ? "" : `${plan.linkedBy}’s `}
                  {plan.providerLabel} plan
                </p>
                {plan.status === "pending" ? (
                  <p className="text-ui-xs text-muted-foreground">
                    Sign-in is pending.
                  </p>
                ) : null}
                {plan.status === "expired" ? (
                  <p className="text-ui-xs text-muted-foreground">
                    Sign-in expired.
                  </p>
                ) : null}
                {plan.status === undefined || plan.status === "linked" ? (
                  <p className="text-ui-xs text-muted-foreground">
                    Shared {plan.providerLabel} quota. Sandbox charges use{" "}
                    {props.teamName} credits.
                  </p>
                ) : null}
                {plan.linkedBy === null ? null : (
                  <p className="text-ui-xs text-muted-foreground">
                    Linked by {plan.linkedBy} · unlinks if they leave or stop
                    being an admin
                  </p>
                )}
              </div>
              {props.renderDetails?.(plan)}
              {props.canAdminister ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={props.isPending}
                  onClick={() => props.onPreviewUnlink(plan)}
                >
                  Unlink
                </Button>
              ) : null}
            </div>
          ))
        )}
      </div>
      {!props.canAdminister ? (
        <p className="text-ui-xs text-muted-foreground">
          Admins link a plan
          {props.adminNames.length > 0
            ? `: ${props.adminNames.join(", ")}.`
            : "."}
        </p>
      ) : null}
    </section>
  );
}
