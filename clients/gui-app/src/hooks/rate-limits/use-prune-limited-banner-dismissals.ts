import { useEffect } from "react";
import type { StatusBarRateLimitCluster } from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { clearedBannerReadings } from "@/lib/rate-limits/limited-profiles";
import { useSampledNow } from "@/lib/relative-time";
import { useLimitedBannerDismissalsStore } from "@/stores/rate-limits/limited-banner-dismissals-store";

/** The signature below, back to its readings. */
function clearedReadingsOf(signature: string): ReadonlyMap<string, number> {
  const parsed: unknown = JSON.parse(signature);
  const readings = new Map<string, number>();
  if (!Array.isArray(parsed)) return readings;
  const entries: ReadonlyArray<unknown> = parsed;
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const pair: ReadonlyArray<unknown> = entry;
    const key = pair[0];
    const readAt = pair[1];
    if (typeof key === "string" && typeof readAt === "number") {
      readings.set(key, readAt);
    }
  }
  return readings;
}

/**
 * Ends the usage popover's banner dismissals that this reading of `hostId`
 * shows are over (`limited-banner-dismissals-store.ts` `prune`): a reset
 * that has passed, or a healthy reading received after the dismissal.
 *
 * Run wherever the cluster is kept current, not only in the popover: the
 * popover mounts only while it is open, and an account that recovers and
 * hits its next limit while it is closed would otherwise find its new banner
 * still hidden. The usage trigger's glyph is always mounted beside the
 * popover with the same host and accounts, so it runs this too; running it
 * twice is idempotent and writes nothing when nothing changed.
 */
export function usePruneLimitedBannerDismissals(
  hostId: string | null,
  cluster: StatusBarRateLimitCluster,
): void {
  const now = useSampledNow();
  const prune = useLimitedBannerDismissalsStore((state) => state.prune);
  // By value: `cluster` is rebuilt on every render, and this prunes only when
  // an account clears, a newer reading arrives, or the minute turns.
  const clearedSignature = JSON.stringify(
    [...clearedBannerReadings(cluster)].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  useEffect(() => {
    if (hostId === null) return;
    prune(hostId, clearedReadingsOf(clearedSignature), now);
  }, [clearedSignature, hostId, now, prune]);
}
