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
  const runnerHost = useRunnerHost();
  const teams = useAuthStore((s) => s.shareableTeams);
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
}
