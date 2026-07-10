import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { providerIdForHarness } from "@/components/chat/composer/use-provider-reauth-gate";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { resolveSeededProfileId } from "@/lib/composer/resolve-seeded-profile-id";

const SEEDED_PROFILE_REFRESH_MS = 15 * 60 * 1000;

/**
 * Validates a fork dialog's seeded `profileId` against the LIVE
 * `providers.list` of the SAME host the fork's create call will actually hit
 * - not the app-wide active host. A fork dialog has no send-time reauth gate
 * of its own (unlike the main chat composer), so a source's profileId that
 * was tombstoned since it last ran must be caught HERE, at seed time.
 *
 * `client` is caller-resolved and passed in explicitly rather than looked up
 * internally (e.g. via `useProvidersList`, which binds to the app-wide
 * ACTIVE host) - per CLAUDE.md's host-scoping rule, a hook must never
 * silently bind to a different host scope than the one its consumer
 * actually targets. `chat-fork-dialog.tsx` creates on the TAB host
 * (`useEpicCreateChatForHost` -> `useTabHostClient`), so it passes a tab-
 * scoped client; `terminal-agent-fork-dialog.tsx` creates on its explicit
 * `hostClient` prop, so it passes that directly. Active host and tab/fixed
 * host can genuinely diverge (a tab bound to a non-default host) - using the
 * wrong one would validate against profiles that don't even exist on the
 * host the fork is about to run on.
 */
export function useResolvedSeededProfileId(
  harnessId: GuiHarnessId,
  profileId: string | null,
  active: boolean,
  client: HostClient<HostRpcRegistry> | null,
): string | null {
  const providerId = providerIdForHarness(harnessId);
  const providersQuery = useHostQuery<HostRpcRegistry, "providers.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "providers.list",
    params: {},
    options: {
      enabled: active,
      subscribed: active,
      staleTime: SEEDED_PROFILE_REFRESH_MS,
    },
  });
  // `providers.list` always returns every configured provider in one atomic
  // response - once this has landed, a missing/empty entry for `providerId`
  // is a real "no support" verdict, not a partial load. `providerId === null`
  // (a harness with no provider-CLI concept, e.g. `traycer`) never settles -
  // there is nothing to judge a profile against either way.
  const settled = providerId !== null && providersQuery.data !== undefined;
  const profiles =
    providerId === null
      ? undefined
      : providersQuery.data?.providers.find(
          (provider) => provider.providerId === providerId,
        )?.profiles;
  return resolveSeededProfileId(profileId, profiles, settled);
}
