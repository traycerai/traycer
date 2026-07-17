import type { ProfileDropdownUsageEntry } from "@/components/providers/profile-dropdown-usage";
import {
  rateLimitWindowFillPercent,
  rateLimitWindowSeverityBarClassName,
} from "@/lib/rate-limits/window-severity";
import { cn } from "@/lib/utils";

/**
 * Shared compact usage meter (model picker rows, composer rate-limit
 * warning). Shows the most constrained captured window only - it never
 * infers health from missing data, so `not_checked`/`unavailable` render as
 * an empty track.
 */
export function ProfileUsageCompactMeter({
  entry,
}: {
  readonly entry: ProfileDropdownUsageEntry;
}) {
  const projection = entry.projection;
  const hasDetail = projection.kind === "detail" || projection.kind === "stale";
  const fillPercent = hasDetail
    ? rateLimitWindowFillPercent(projection.compactWindow.window.usedPercent)
    : 0;
  const severity =
    projection.kind === "detail" ||
    projection.kind === "stale" ||
    projection.kind === "semantic_only"
      ? projection.severity
      : null;
  return (
    <span
      aria-hidden="true"
      data-testid={`profile-usage-bar-${String(entry.profileId)}`}
      data-usage-kind={projection.kind}
      className={cn(
        "h-1 w-[clamp(3.5rem,22%,5.5rem)] shrink-0 overflow-hidden rounded-full bg-foreground/15",
        projection.kind === "semantic_only" &&
          projection.severity === "running_low" &&
          "bg-amber-500/25 dark:bg-amber-400/25",
        projection.kind === "semantic_only" &&
          projection.severity === "limited" &&
          "bg-red-500/25 dark:bg-red-400/25",
        (projection.kind === "stale" || projection.kind === "unavailable") &&
          "opacity-50",
      )}
    >
      {hasDetail && severity !== null ? (
        <span
          className={cn(
            "block h-full rounded-full transition-[width]",
            rateLimitWindowSeverityBarClassName(severity),
          )}
          style={{ width: `${fillPercent}%` }}
        />
      ) : null}
    </span>
  );
}
