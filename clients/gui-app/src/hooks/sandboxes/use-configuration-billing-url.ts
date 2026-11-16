import { useCallback } from "react";
import { resolvePlatformBillingUrl } from "@/lib/auth/platform-base-url";
import type { StageConfiguration } from "@/lib/sandboxes/sandbox-stage-model";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The billing page where credits for this configuration are added: the
 * team's billing page for a team sandbox, the person's own for Personal.
 * Unlike `usePlatformBillingUrl`, it follows the staged configuration, not
 * the account context the app has selected, so a team remedy never sends
 * anyone to a Personal top-up: a team missing from the shareable teams is
 * named by the configuration's own team name instead of falling back to it.
 */
export function useConfigurationBillingUrl(
  configuration: StageConfiguration,
): string {
  return useBillingUrlOf()(configuration);
}

/**
 * {@link useConfigurationBillingUrl} as a function of the configuration, for
 * a surface whose sandbox's owner may not be known yet: it asks only once
 * the configuration is known, and never builds a page for a guessed one.
 */
export function useBillingUrlOf(): (
  configuration: StageConfiguration,
) => string {
  const runnerHost = useRunnerHost();
  const teams = useAuthStore((s) => s.shareableTeams);
  return useCallback(
    (configuration: StageConfiguration): string => {
      if (configuration.kind === "personal") {
        return resolvePlatformBillingUrl(
          runnerHost.signInUrl,
          { type: "PERSONAL" },
          teams,
        );
      }
      const known = teams.some(
        (team) => team.teamId === configuration.teamId && team.slug.length > 0,
      );
      return resolvePlatformBillingUrl(
        runnerHost.signInUrl,
        { type: "TEAM", teamId: configuration.teamId },
        known
          ? teams
          : [{ teamId: configuration.teamId, slug: configuration.teamName }],
      );
    },
    [runnerHost.signInUrl, teams],
  );
}
