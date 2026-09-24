import { useEffect, useEffectEvent, useMemo } from "react";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useRefreshProviderRateLimitsOnTurn } from "@/hooks/host/use-refresh-provider-rate-limits-on-turn";
import { useConfiguredRateLimitProviders } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import { useProviderRateLimitFetchScope } from "@/hooks/rate-limits/use-provider-rate-limit-fetch-scope";
import { fetchProviderRateLimits } from "@/lib/rate-limits/provider-rate-limit-fetch";
import {
  rateLimitPollCandidates,
  rateLimitPollMembershipKey,
  rateLimitPollTargets,
} from "@/lib/rate-limits/rate-limit-poll-targets";
import { EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS } from "@/lib/rate-limits/rate-limit-timing";

/**
 * The long-lived app-shell owner of background usage freshness for the
 * `ephemeralProcess` providers (codex, claude-code, grok), on the app-wide
 * host. It renders nothing and owns two things for the lifetime of the window:
 *
 * 1. The poll: once when the target set is first known or changes, then every
 *    `EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS`, it asks for every fetch-eligible
 *    target whose persisted reading is stale (`rateLimitPollTargets`), with
 *    `force: false` - independent requests, no ordering, no budget. The host
 *    serves what its gauge already holds and bounds the probes it does run; a
 *    target whose reading is still fresh in this renderer is skipped before it
 *    reaches the wire.
 * 2. OpenCode's HTTP-lane turn refresh, kept mounted even while its popover
 *    and Settings surfaces are closed.
 *
 * The timer PAUSES on `document.visibilityState === "hidden"` (window truly
 * minimized/backgrounded) and resumes when the window is shown again - matching
 * the same visibility signal TanStack's `focusManager` uses for the httpFetch
 * lane's `refetchIntervalInBackground: false`. It deliberately does NOT key off
 * window focus (`blur` / `document.hasFocus()`): the core scenario this feature
 * exists for is glancing at the icon while Traycer sits visible-but-unfocused on
 * a second monitor, and pausing on mere focus-loss would break exactly that.
 *
 * `httpFetch` providers are intentionally absent here - their observers opt
 * into table-owned polling directly.
 */
export function RateLimitPollProvider(): null {
  const hostId = useAddressableHostId();
  const fetchScope = useProviderRateLimitFetchScope();
  const configuredProviders = useConfiguredRateLimitProviders();
  useRefreshProviderRateLimitsOnTurn(
    "opencode",
    null,
    configuredProviders.some(({ providerId }) => providerId === "opencode"),
  );

  const candidates = useMemo(
    () => rateLimitPollCandidates(configuredProviders),
    [configuredProviders],
  );
  const membershipKey = rateLimitPollMembershipKey(candidates);

  // Staleness is judged when the tick runs, not when the list last rendered.
  const pollTargets = useEffectEvent((): void => {
    for (const target of rateLimitPollTargets(candidates, Date.now())) {
      void fetchProviderRateLimits(fetchScope, target, { force: false });
    }
  });

  useEffect(() => {
    if (hostId === null) return;
    pollTargets();
  }, [hostId, membershipKey]);

  // The single shared interval timer, gated on host presence and paused while
  // the window is hidden. Surfaces still populate their own targets on mount;
  // this timer only does the periodic background refresh.
  useEffect(() => {
    if (hostId === null) return;
    let intervalHandle: number | null = null;

    const tick = (): void => {
      // Defensive: the timer is cleared while hidden, but guard the body too so
      // a tick that races a `visibilitychange` cannot ask the host for work.
      if (document.visibilityState === "hidden") return;
      pollTargets();
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
