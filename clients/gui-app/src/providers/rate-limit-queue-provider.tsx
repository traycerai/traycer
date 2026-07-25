import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { useHostClient } from "@/lib/host";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useConfiguredRateLimitProviders } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import {
  configureRateLimitQueue,
  enqueueRateLimitFetch,
} from "@/lib/rate-limits/ephemeral-fetch-queue";
import { EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS } from "@/lib/rate-limits/rate-limit-timing";

/**
 * Background poll cadence for the `ephemeralProcess` lane (codex, claude-code),
 * matching the `httpFetch` lane's table-owned fixed cadence so both lanes
 * settle to the same background freshness regardless of fetch cost class. The serial
 * queue's five-minute freshness floor, turn-completion enqueues, and manual refresh
 * all keep data fresher between ticks. Defined in `rate-limit-timing.ts`
 * (shared with `ephemeral-fetch-queue.ts`'s cool-down) and re-exported here so
 * existing importers of this module are unaffected.
 */
export { EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS };

/**
 * The long-lived app-shell owner of the rate-limit data layer (no rendered
 * output). It does two things for the lifetime of the window:
 *
 * 1. Binds the `ephemeralProcess` serial queue to the default host
 *    (`configureRateLimitQueue`), re-binding on host/client swap and unbinding
 *    on host loss so a stale client can't service an enqueue.
 * 2. Drives the single shared interval timer for the `ephemeralProcess` lane,
 *    walking the currently-configured providers and enqueuing a `force: false`
 *    pull for each (the queue serializes them, one subprocess at a time). It
 *    also enqueues the same safe pull immediately when the configured
 *    `ephemeralProcess` provider set changes, so the header glyph/popover can
 *    recover from a failed first read without waiting for a transient surface
 *    mount.
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
 * into table-owned polling and never enter this queue.
 */
export function RateLimitQueueProvider(): null {
  const hostId = useReactiveActiveHostId();
  const client = useHostClient();
  const queryClient = useQueryClient();
  const configuredProviders = useConfiguredRateLimitProviders();

  // Bind the queue to the default host. Re-runs on host/client swap; the
  // cleanup + `null` branch clears the binding on host loss (`hostId` flips to
  // `null`). `hostId` is bound into the queue at configure time (not passed per
  // enqueue) so a queued fetch can't be reassigned to a different host
  // mid-flight. `useHostClient()` is non-null once the runtime is mounted, so
  // only host presence needs gating here.
  useEffect(() => {
    if (hostId === null) {
      configureRateLimitQueue(null);
      return;
    }
    configureRateLimitQueue({
      hostId,
      queryClient,
      request: (_hostId, method, params) => client.request(method, params),
    });
    return () => {
      configureRateLimitQueue(null);
    };
  }, [hostId, client, queryClient]);

  // Latest `ephemeralProcess` provider ids, read live by the interval callback
  // through a ref so a credential change re-gates the walked set on the very
  // next tick WITHOUT resetting the timer (which a dependency would, pushing the
  // first tick a full interval into the future on every list change).
  const ephemeralProviderIds = useMemo(
    () =>
      configuredProviders
        .filter((provider) => provider.lane === "ephemeralProcess")
        .map((provider) => provider.providerId),
    [configuredProviders],
  );
  const ephemeralProviderIdsRef = useRef(ephemeralProviderIds);
  useEffect(() => {
    ephemeralProviderIdsRef.current = ephemeralProviderIds;
  }, [ephemeralProviderIds]);

  useEffect(() => {
    if (hostId === null) return;
    ephemeralProviderIds.forEach((providerId) => {
      void enqueueRateLimitFetch(providerId, DEFAULT_ACCOUNT_CONTEXT, {
        force: false,
        profileId: null,
      });
    });
  }, [hostId, ephemeralProviderIds]);

  // The single shared interval timer, gated on host presence and paused while
  // the window is hidden. Initial per-provider data still populates through the
  // immediate effect above and per-surface queue enqueue-on-mount; this timer
  // only does the periodic background refresh.
  useEffect(() => {
    if (hostId === null) return;
    let intervalHandle: number | null = null;

    const tick = (): void => {
      // Defensive: the timer is cleared while hidden, but guard the body too so
      // a tick that races a `visibilitychange` can't spawn a subprocess.
      if (document.visibilityState === "hidden") return;
      ephemeralProviderIdsRef.current.forEach((providerId) => {
        void enqueueRateLimitFetch(providerId, DEFAULT_ACCOUNT_CONTEXT, {
          force: false,
          profileId: null,
        });
      });
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
