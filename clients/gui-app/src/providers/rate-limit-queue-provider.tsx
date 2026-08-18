import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useRefreshProviderRateLimitsOnTurn } from "@/hooks/host/use-refresh-provider-rate-limits-on-turn";
import { useConfiguredRateLimitProviders } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import {
  configureRateLimitQueue,
  enqueueRateLimitFetchBatch,
  type RateLimitQueueBatchTarget,
} from "@/lib/rate-limits/ephemeral-fetch-queue";
import { refreshTargetsForProvider } from "@/lib/rate-limits/rate-limit-refresh-targets";
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
 * output). It owns the following for the lifetime of the window:
 *
 * 1. Binds the `ephemeralProcess` serial queue to the default host
 *    (`configureRateLimitQueue`), re-binding on host/client swap and unbinding
 *    on host loss so a stale client can't service an enqueue.
 * 2. Drives the single shared interval timer for the `ephemeralProcess` lane,
 *    walking the currently-configured providers and enqueuing, per provider,
 *    one `force: false` batch over EVERY fetch-eligible profile (ambient and
 *    managed alike - a managed profile the header glyph or a popover row shows
 *    must not go stale merely because it is not the terminal login). The
 *    profiles of one provider start together inside that item, the way the
 *    popover's "Refresh all" fans out, so a sweep costs one probe's wall-clock
 *    rather than the sum; still-fresh profiles no-op inside the queue. It also
 *    enqueues the same safe sweep immediately when the configured target set
 *    changes, so the header glyph/popover can recover from a failed first read
 *    without waiting for a transient surface mount.
 * 3. Keeps OpenCode's HTTP-lane turn refresh mounted even while its popover and
 *    Settings surfaces are closed.
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
  const client = useHostClientForHostId(hostId);
  const queryClient = useQueryClient();
  const configuredProviders = useConfiguredRateLimitProviders();
  useRefreshProviderRateLimitsOnTurn(
    "opencode",
    null,
    configuredProviders.some(
      (provider) =>
        provider.providerId === "opencode" && provider.fetchEligibility.ambient,
    ),
  );

  // Bind the queue to the default host. Re-runs on host/client swap; the
  // cleanup + `null` branch clears the binding on host loss (`hostId` flips to
  // `null`). `hostId` is bound into the queue at configure time (not passed per
  // enqueue) so a queued fetch can't be reassigned to a different host
  // mid-flight - but that only pins the CACHE KEY, so the client has to be
  // pinned to the same id or the two disagree. `useHostClientForHostId` returns
  // a requester frozen on this host; the bare app-wide `useHostClient()`
  // re-points on a host switch, and a pull already in the lane (up to its full
  // response budget) would then fetch host B's usage and write it under host
  // A's key. A pinned client that stops resolving yields `null` here, which
  // clears the binding exactly like host loss.
  useEffect(() => {
    if (hostId === null || client === null) {
      configureRateLimitQueue(null);
      return;
    }
    configureRateLimitQueue({
      hostId,
      queryClient,
      request: (_hostId, method, params, responseTimeoutMs) =>
        client.requestWithResponseTimeout(method, params, responseTimeoutMs),
    });
    return () => {
      configureRateLimitQueue(null);
    };
  }, [hostId, client, queryClient]);

  // Latest `ephemeralProcess` sweep - one batch of fetch-eligible profile
  // targets per provider - read live by the interval callback through a ref so
  // a credential/profile change re-gates the walked set on the very next tick
  // WITHOUT resetting the timer (which a dependency would, pushing the first
  // tick a full interval into the future on every list change).
  const ephemeralSweeps = useMemo(
    () =>
      configuredProviders
        .filter((provider) => provider.lane === "ephemeralProcess")
        .map((provider): ReadonlyArray<RateLimitQueueBatchTarget> =>
          refreshTargetsForProvider(provider).map((profileId) => ({
            providerId: provider.providerId,
            accountContext: DEFAULT_ACCOUNT_CONTEXT,
            profileId,
          })),
        )
        .filter((targets) => targets.length > 0),
    [configuredProviders],
  );
  const ephemeralSweepsRef = useRef(ephemeralSweeps);
  useEffect(() => {
    ephemeralSweepsRef.current = ephemeralSweeps;
  }, [ephemeralSweeps]);

  // Immediate sweep whenever the walked set changes (`force: false`, so a
  // still-fresh profile costs nothing - only a never-read or stale one spawns).
  useEffect(() => {
    if (hostId === null) return;
    ephemeralSweeps.forEach((targets) => {
      void enqueueRateLimitFetchBatch(targets, { force: false });
    });
  }, [hostId, ephemeralSweeps]);

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
      ephemeralSweepsRef.current.forEach((targets) => {
        void enqueueRateLimitFetchBatch(targets, { force: false });
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
