import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { resolvePlatformBaseUrl } from "@/lib/auth/platform-base-url";
import { useOpenLink } from "@/lib/links/open-link";
import { useRunnerHost } from "@/providers/use-runner-host";

/** The open goes through `openLink` (kind `account`, always external per A2), which owns the runner-error
 * mapping, so a shell that cannot open links says so instead of failing silently. */
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
