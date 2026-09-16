import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { resolvePlatformBaseUrl } from "@/lib/auth/platform-base-url";
import { useOpenLink } from "@/lib/links/open-link";
import { isMobileApp } from "@/lib/mobile-app";
import { useRunnerHost } from "@/providers/use-runner-host";

/**
 * The remedy for a host this account may not attach to remotely: a billing
 * limit, not a broken machine.
 *
 * It sits in its own file because more than one surface has to offer it, and
 * offering it is not optional — a plan-gated host is reachable, healthy and
 * working on its own computer, so any surface that reports it as a
 * connectivity problem sends someone to debug a network they have no fault in.
 * The scope gate learned that first (`host-scope-gate.tsx`); the resource
 * monitor reaches the same state through its own picker and owes the same
 * answer, and a second copy of this button is how the two would drift.
 *
 * The `host-scope-plan-upgrade` test id travels with it, so a suite asserting
 * "the upgrade path is offered here" keeps matching whichever surface renders
 * it.
 *
 * Kept a component rather than inlined, as it was in the gate: `useRunnerHost`
 * then mounts only in the plan-restricted branch, so both callers stay
 * renderable without the runner provider. The open goes through `openLink`
 * (kind `account`, always external per A2), which owns the runner-error
 * mapping, so a shell that cannot open links says so instead of failing
 * silently.
 *
 * It renders NOTHING in the installed mobile app. App Store review guideline
 * 3.1.1 forbids an app from presenting or linking to a subscription that is
 * not purchasable through Apple, and this button is both at once: the words
 * "Upgrade plan" and a link to the web billing page. The notices that render
 * it switch to the `PLAN_RESTRICTED_MOBILE_*` copy in
 * `@/lib/host/plan-restricted-copy`, so the phone still explains the state -
 * it just does not offer the purchase. Every caller mounts this
 * unconditionally, so the withholding lives here rather than in three copies.
 *
 * The flag is read in a wrapper so the button's hooks stay unconditional; it
 * is immutable after boot, but a hook behind an early return is a rule
 * violation regardless of how stable the condition is.
 */
export function PlanRestrictedUpgradeAction(): ReactNode {
  if (isMobileApp()) return null;
  return <UpgradeButton />;
}

function UpgradeButton(): ReactNode {
  const runnerHost = useRunnerHost();
  const openLink = useOpenLink();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void openLink(
          resolvePlatformBaseUrl(runnerHost.signInUrl),
          "account",
          null,
        );
      }}
      data-testid="host-scope-plan-upgrade"
    >
      Upgrade plan
    </Button>
  );
}
