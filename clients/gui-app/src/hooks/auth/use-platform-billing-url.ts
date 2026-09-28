import { resolvePlatformBillingUrl } from "@/lib/auth/platform-base-url";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The Billing page URL for the account context currently selected in the app:
 * the selected team's billing page, or the user's own.
 *
 * Teams come from the auth store's `shareableTeams`, which is the signed-in
 * user's `teamSubscriptions` projected to id + slug (and re-projected whenever
 * the user is re-fetched), so a billing link needs no query or provider of its
 * own and renders wherever the runner host does. Settings' subscription card
 * resolves the same context against the live user query and calls
 * `resolvePlatformBillingUrl` directly, so the link there always matches the
 * account its picker shows.
 */
export function usePlatformBillingUrl(): string {
  const runnerHost = useRunnerHost();
  const accountContext = useAccountContextStore((s) => s.accountContext);
  const teams = useAuthStore((s) => s.shareableTeams);
  return resolvePlatformBillingUrl(runnerHost.signInUrl, accountContext, teams);
}
