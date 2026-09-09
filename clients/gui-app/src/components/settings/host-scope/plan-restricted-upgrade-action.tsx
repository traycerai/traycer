import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { resolvePlatformBaseUrl } from "@/lib/auth/platform-base-url";
import { useOpenLink } from "@/lib/links/open-link";
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
 */
export function PlanRestrictedUpgradeAction(): ReactNode {
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
