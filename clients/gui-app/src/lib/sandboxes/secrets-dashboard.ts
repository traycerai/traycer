import { resolvePlatformBaseUrl } from "@/lib/auth/platform-base-url";

/**
 * The team's GitHub page in the dashboard, where an admin links GitHub,
 * installs the App and ticks the team's repositories, and where the
 * installing admin is changed. `teamName` is the team's handle, the one
 * segment the dashboard's team routes are keyed by.
 *
 * Navigation only (`resolvePlatformBaseUrl`): a shell with no usable platform
 * origin lands on production's page, which the user can see and leave.
 */
export function teamGithubDashboardUrl(
  signInUrl: string,
  teamName: string,
): string {
  return `${resolvePlatformBaseUrl(signInUrl)}/team/${encodeURIComponent(teamName)}/environment/github`;
}
