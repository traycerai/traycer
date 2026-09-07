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
  /** the picker's cross-host reconciliation) must resolve that before calling this hook - it performs no cross-host identity matching itself. */
  readonly profiles: ReadonlyArray<ProviderProfile>;
}

/**
 * Re-project cache-only comparison state. Mounting this never calls `host.getRateLimitUsage`; a click on one profile's Refresh must not read pending on a sibling.
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
