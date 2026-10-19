import { resolvePlatformBaseUrl } from "@/lib/auth/platform-base-url";

/**
 * Where the account's secrets live: the dashboard page that stores them, binds
 * them to destinations, connects coding CLIs for sandboxes and installs the
 * GitHub App. The app holds no control over any of it - a sandbox never takes
 * a credential from a client - so every surface that would have offered one
 * links here instead.
 *
 * Navigation only (`resolvePlatformBaseUrl`): a shell with no usable platform
 * origin lands on production's page, which the user can see and leave.
 */
export const SECRETS_DASHBOARD_LABEL = "Secrets and GitHub";

export function secretsDashboardUrl(signInUrl: string): string {
  return `${resolvePlatformBaseUrl(signInUrl)}/environments/personal/secrets`;
}

/**
 * The dashboard's Personal Secrets page with its add dialog open at `kind`: the
 * kinds whose forms live on the web (SSH, the cloud and certificate kinds) hand
 * off here. The dashboard reads `add`.
 */
export function secretsDashboardAddUrl(
  signInUrl: string,
  kind: string,
): string {
  const params = new URLSearchParams({ add: kind });
  return `${secretsDashboardUrl(signInUrl)}?${params.toString()}`;
}

/**
 * The dashboard's Personal review page, where held values and the changes a
 * host's move to Personal made are reviewed and applied.
 */
export function personalReviewUrl(signInUrl: string): string {
  return `${resolvePlatformBaseUrl(signInUrl)}/environments/personal/review`;
}

/**
 * The team's environment in the dashboard, where its settings are changed:
 * the first page of its Environment group, which a member can read.
 * `teamName` is the team's handle, the one segment the dashboard's team
 * routes are keyed by.
 */
export function settingsDashboardUrl(
  signInUrl: string,
  teamName: string,
): string {
  return `${resolvePlatformBaseUrl(signInUrl)}/team/${encodeURIComponent(teamName)}/environment/providers`;
}
