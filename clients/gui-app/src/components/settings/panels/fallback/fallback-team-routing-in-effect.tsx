import type { ReactNode } from "react";
import type { FallbackPolicy } from "@traycer/protocol/host/fallback-policy";
import { FallbackPolicySummary } from "@/components/settings/panels/fallback/fallback-policy-summary";

/**
 * Settings ▸ Host ▸ Model routing on a team computer.
 *
 * Routing on such a computer is the team's, one setting for everyone who works
 * on it, so there is nothing here for a member to change and no editor. What
 * the editor shows is the policy it will save, and mounting it here would
 * offer every control on the page as if it described what happens now. So the
 * policy in effect is read out, with one sentence saying whose it is and where
 * it is set.
 *
 * No action, deliberately: there is no per-member routing to take over to.
 *
 * The values are read out by {@link FallbackPolicySummary}, the same component
 * the team's own page uses for a viewer, so the two surfaces cannot drift into
 * describing one policy two ways. Nothing is passed for `accounts`: which
 * provider accounts the team has linked is a fact of the team's page, and this
 * page does not read it.
 */
export function FallbackTeamRoutingInEffect(props: {
  readonly policy: FallbackPolicy;
  /**
   * The stored policy could not be read, so {@link props.policy} is the
   * host's defaults with routing off rather than anything the team chose.
   * Said plainly instead of passed over: the read-out would otherwise present
   * routing-off as the team's decision, and the one sentence a member can act
   * on is which page it is fixed from.
   */
  readonly storedPolicyUnreadable: boolean;
}): ReactNode {
  return (
    <div
      className="flex flex-col gap-5"
      data-testid="fallback-team-routing-in-effect"
    >
      <div className="rounded-lg border border-border/60 bg-card/40 px-5 py-4">
        <div className="font-medium text-ui-sm">Your team&apos;s routing</div>
        <p className="mt-1 max-w-[68ch] text-ui-sm text-muted-foreground">
          Model routing on this computer is set for the whole team, on the
          team&apos;s page.
        </p>
      </div>
      {props.storedPolicyUnreadable ? (
        <div
          role="alert"
          className="rounded-lg border border-warning/40 bg-warning/5 px-5 py-4"
          data-testid="fallback-team-policy-unreadable"
        >
          <div className="font-medium text-ui-sm text-warning-foreground">
            Your team&apos;s saved routing couldn&apos;t be read
          </div>
          <p className="mt-1 max-w-[68ch] text-ui-sm text-muted-foreground">
            This computer is running the default settings below, with automatic
            routing off. Saving the team&apos;s routing again replaces the
            settings we couldn&apos;t read.
          </p>
        </div>
      ) : null}
      <section className="flex flex-col gap-3 px-5 text-ui-sm text-muted-foreground">
        <FallbackPolicySummary policy={props.policy} accounts={null} />
      </section>
    </div>
  );
}
