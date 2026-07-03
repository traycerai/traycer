import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { subscribeChatTurnCompletions } from "@/lib/notifications/chat-turn-completion";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { queryKeys } from "@/lib/query-keys";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

/**
 * Shared "how fresh is fresh enough" window for provider rate-limit reads:
 * the `staleTime` on `use-host-provider-rate-limits-query` and the minimum
 * spacing this hook enforces between turn-completion-triggered refetches.
 * Unlike the aperture read (a cheap cloud call), a provider pull spawns a
 * real CLI subprocess (`codex app-server`, or a full `claude` idle
 * `query()`) on the host - a burst of back-to-back turn completions (e.g. a
 * queued run) must not each trigger their own spawn.
 */
export const PROVIDER_RATE_LIMITS_STALE_TIME_MS = 30_000;

/**
 * While mounted, invalidates `host.getRateLimitUsage` for `hostId` whenever a
 * chat turn on `providerId`'s harness completes - the provider-pull analog of
 * `useRefreshRateLimitUsageOnTraycerTurn`.
 *
 * Unlike the aperture refresh hook (always default-host scoped, mounted only
 * by the Traycer-only `RateLimitView`), `hostId` is a caller-supplied
 * parameter instead of a hardcoded `useReactiveActiveHostId()` read, so a
 * future tab-scoped consumer can reuse this hook without a rewrite.
 *
 * Invalidates the exact `{ accountContext, providerId }` params key (the same
 * one `useHostProviderRateLimitsQuery` builds), NOT the whole
 * `host.getRateLimitUsage` method scope: a method-scope invalidation would
 * also refetch the aperture query and every OTHER provider's query on this
 * host, so e.g. a Codex turn completing would spawn a `claude` subprocess to
 * refresh Claude's rate limits too, for data a Codex turn can't have changed.
 *
 * `invalidateQueries` refetches an actively-observed query immediately
 * regardless of `staleTime` (TanStack only consults `staleTime` for
 * mount/refocus-triggered refetches, not explicit invalidation), so the
 * pinned strip - a persistent, always-mounted surface - would otherwise spawn
 * a fresh CLI subprocess on every single matching turn completion. A local
 * cooldown ref throttles invalidation to at most once per
 * `PROVIDER_RATE_LIMITS_STALE_TIME_MS`, which is what actually bounds that
 * cost; the query's own `staleTime` (set alongside this) separately avoids a
 * redundant refetch when a surface merely remounts within the same window.
 *
 * No-ops while `providerId` is `null` (surface isn't gated to a rate-limit
 * -capable provider).
 */
export function useRefreshProviderRateLimitsOnTurn(
  providerId: RateLimitProviderId | null,
  hostId: string | null,
): void {
  const queryClient = useQueryClient();
  const lastInvalidatedAtRef = useRef(0);

  useEffect(() => {
    // Reset the cooldown whenever this effect re-runs for a new hostId/
    // providerId pair - otherwise a provider switch on the same mounted
    // component (e.g. the chat's selected harness changes) inherits the
    // previous provider's cooldown timestamp and can skip its own first,
    // otherwise-due invalidation.
    lastInvalidatedAtRef.current = 0;
    if (providerId === null) return;
    const harnessId = providerIdToGuiHarnessId(providerId);
    return subscribeChatTurnCompletions((completion) => {
      if (completion.harnessId !== harnessId) return;
      const now = Date.now();
      if (
        now - lastInvalidatedAtRef.current <
        PROVIDER_RATE_LIMITS_STALE_TIME_MS
      ) {
        return;
      }
      lastInvalidatedAtRef.current = now;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.hostMethod<
          HostRpcRegistry,
          "host.getRateLimitUsage"
        >(hostId, "host.getRateLimitUsage", {
          accountContext: DEFAULT_ACCOUNT_CONTEXT,
          providerId,
        }),
      });
    });
  }, [queryClient, hostId, providerId]);
}
