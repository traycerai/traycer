import { useEffect, useEffectEvent, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHostClient } from "@/lib/host";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useRefreshProviderRateLimitsOnTurn } from "@/hooks/host/use-refresh-provider-rate-limits-on-turn";
import { useConfiguredRateLimitProviders } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import { useRateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import {
  configureRateLimitQueue,
  enqueueRateLimitFetch,
} from "@/lib/rate-limits/ephemeral-fetch-queue";
import {
  BACKGROUND_RATE_LIMIT_TARGET_BUDGET,
  backgroundRateLimitMembershipKey,
  selectBackgroundRateLimitTargets,
} from "@/lib/rate-limits/background-rate-limit-targets";
import { EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS } from "@/lib/rate-limits/rate-limit-timing";

/** ephemeralProcess poll cadence, matching httpFetch's table-owned tick. Defined in rate-limit-timing.ts; re-exported for existing importers. */
export { EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS };

/** App-shell owner of the `ephemeralProcess` queue and timer. Pause on `visibilityState === "hidden"`, not window focus. `httpFetch` observers poll themselves and never enter this queue. */
export function RateLimitQueueProvider(): null {
  const hostId = useAddressableHostId();
  const client = useHostClient();
  const queryClient = useQueryClient();
  const configuredProviders = useConfiguredRateLimitProviders();
  const profileSelection = useRateLimitProfileSelection();
  useRefreshProviderRateLimitsOnTurn(
    "opencode",
    null,
    configuredProviders.some(({ providerId }) => providerId === "opencode"),
  );

  // Bind the queue to the default host. `hostId` is bound at configure time so a queued fetch cannot be reassigned mid-flight. `useHostClient()` is pinned to the named host.
  useEffect(() => {
    if (hostId === null) {
      configureRateLimitQueue(null);
      return;
    }
    configureRateLimitQueue({
      hostId,
      queryClient,
      // `responseTimeoutMs` is the queue's own budget, not the client's default
      // frame timeout: an `ephemeralProcess` read spawns a provider CLI and
      // legitimately outruns that default.
      request: (_hostId, method, params, responseTimeoutMs) =>
        client.requestWithResponseTimeout(method, params, responseTimeoutMs),
    });
    return () => {
      configureRateLimitQueue(null);
    };
  }, [hostId, client, queryClient]);

  const membershipKey = useMemo(
    () =>
      backgroundRateLimitMembershipKey(configuredProviders, profileSelection),
    [configuredProviders, profileSelection],
  );

  const enqueuePollingWindow = useEffectEvent((): void => {
    const targets = selectBackgroundRateLimitTargets(
      configuredProviders,
      profileSelection,
      Date.now(),
      BACKGROUND_RATE_LIMIT_TARGET_BUDGET,
    );
    for (const target of targets) {
      void enqueueRateLimitFetch(target.providerId, target.accountContext, {
        force: false,
        profileId: target.profileId,
      });
    }
  });

  useEffect(() => {
    if (hostId === null) return;
    enqueuePollingWindow();
  }, [hostId, membershipKey]);

  // Shared interval for background refresh. Paused while hidden. Initial
  // data comes from the immediate effect and enqueue-on-mount.
  useEffect(() => {
    if (hostId === null) return;
    let intervalHandle: number | null = null;

    const tick = (): void => {
      // Defensive: the timer is cleared while hidden, but guard the body too so
      // a tick that races a `visibilitychange` can't spawn a subprocess.
      if (document.visibilityState === "hidden") return;
      enqueuePollingWindow();
    };
    const start = (): void => {
      if (intervalHandle !== null) return;
      intervalHandle = window.setInterval(
        tick,
        EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS,
      );
    };
    const stop = (): void => {
      if (intervalHandle === null) return;
      window.clearInterval(intervalHandle);
      intervalHandle = null;
    };
    const syncToVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        start();
      }
    };

    syncToVisibility();
    document.addEventListener("visibilitychange", syncToVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncToVisibility);
      stop();
    };
  }, [hostId]);

  return null;
}
