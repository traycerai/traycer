import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import { resolvePlatformBaseUrl } from "@/lib/auth/platform-base-url";

/**
 * The dashboard page that opens its create-team dialog on load
 * (`?create-team=1`): a team is made there, not in the app, and the app's
 * environment list picks the new team up on its next refetch.
 *
 * Navigation only (`resolvePlatformBaseUrl`): a shell with no usable platform
 * origin lands on production's page, which the user can see and leave.
 */
export function createTeamDashboardUrl(signInUrl: string): string {
  return `${resolvePlatformBaseUrl(signInUrl)}/settings?create-team=1`;
}

/**
 * Whether the answered environment list holds no team, which is when
 * "Create a team" is offered. `false` while the list has not answered.
 */
export function hasNoTeamEnvironment(
  environments: ReadonlyArray<EnvironmentDescriptor> | undefined,
): boolean {
  if (environments === undefined) return false;
  return !environments.some(
    (environment) => environment.ownerKind === "organization",
  );
}
