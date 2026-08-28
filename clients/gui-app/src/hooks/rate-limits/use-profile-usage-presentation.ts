import { useMemo, useState } from "react";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  projectComparisonEntry,
  scopeProfileUsageRefreshStatus,
  type ProfileDropdownUsageEntry,
  type ProfileDropdownUsagePresentation,
} from "@/components/providers/profile-dropdown-usage";
import { useProfileUsageComparison } from "@/hooks/rate-limits/use-profile-usage-comparison";
import { useSampledNow } from "@/lib/relative-time";

export interface UseProfileUsagePresentationArgs {
  /** The host that will execute the next run - forwarded verbatim to
   *  `useProfileUsageComparison`. Callers own resolving this to the right
   *  scope (default host, or a tab's lifetime-bound host). */
  readonly runTargetHostId: string | null;
  readonly providerId: ProviderId;
  /** Profiles already scoped to `runTargetHostId`'s identity. A caller whose
   *  visible profiles come from a different host (e.g. the picker's
   *  cross-host reconciliation) must resolve that before calling this hook -
   *  it performs no cross-host identity matching itself. */
  readonly profiles: ReadonlyArray<ProviderProfile>;
}

/**
 * Shared comparison-to-presentation adapter behind both the model picker and
 * the composer rate-limit warning. Wraps `useProfileUsageComparison`'s raw
 * per-profile comparison state with the stable `ProfileDropdownUsageEntry`
 * projection (`projectComparisonEntry`) and scopes each profile's own
 * pending-refresh interaction (`scopeProfileUsageRefreshStatus`) so a click
 * on one profile's Refresh never reads as pending on a sibling profile.
 *
 * Mounting this hook never itself calls `host.getRateLimitUsage` -
 * `useProfileUsageComparison` observes cache-only queries with fetching
 * disabled; this adapter only re-projects that state and re-derives the
 * comparison as `now` samples forward.
 */
export function useProfileUsagePresentation({
  runTargetHostId,
  providerId,
  profiles,
}: UseProfileUsagePresentationArgs): ProfileDropdownUsagePresentation {
  const comparison = useProfileUsageComparison({
    runTargetHostId,
    providerId,
    profiles,
  });
  const now = useSampledNow();
  const [pendingRefreshKeys, setPendingRefreshKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const entries = useMemo(() => {
    const projected = new Map<string | null, ProfileDropdownUsageEntry>();
    comparison.entries.forEach((entry, profileId) => {
      const refreshKey = JSON.stringify([providerId, profileId]);
      const refresh = async (): Promise<void> => {
        setPendingRefreshKeys((current) => {
          const next = new Set(current);
          next.add(refreshKey);
          return next;
        });
        await entry.refresh().finally(() => {
          setPendingRefreshKeys((current) => {
            if (!current.has(refreshKey)) return current;
            const next = new Set(current);
            next.delete(refreshKey);
            return next;
          });
        });
      };
      projected.set(
        profileId,
        projectComparisonEntry(
          {
            ...entry,
            refreshStatus: scopeProfileUsageRefreshStatus(
              entry.refreshStatus,
              pendingRefreshKeys.has(refreshKey),
            ),
            refresh,
          },
          now,
        ),
      );
    });
    return projected;
  }, [comparison.entries, now, pendingRefreshKeys, providerId]);

  return useMemo<ProfileDropdownUsagePresentation>(
    () => ({ isHostReady: comparison.isReady, entries }),
    [comparison.isReady, entries],
  );
}
