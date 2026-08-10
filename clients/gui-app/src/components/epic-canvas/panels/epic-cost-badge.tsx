import { useMemo, type ReactNode } from "react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostClient } from "@/lib/host";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useUsageSummarySupported } from "@/hooks/usage-analytics/use-usage-summary-support";
import {
  buildUsageSummaryRequest,
  useUsageSummaryForClient,
} from "@/hooks/usage-analytics/use-usage-summary-query";
import {
  describeCostCoverage,
  FULL_RATE_QUALIFIER,
  servedByScopeNote,
} from "@/lib/usage-analytics/cost-format";
import { StatusRowChromeBoundary } from "@/components/epic-canvas/panels/status-row-chrome-boundary";
import { cn } from "@/lib/utils";

const EPIC_COST_BADGE_WINDOW_DAYS = 30;

/**
 * Epic-scoped cost display for the canvas status row - the same
 * `host.usage.summary` RPC as the Usage page, filtered by this epic's id.
 * Feature-detected: renders nothing on a host that predates the capability,
 * or while there is nothing to show (no facts in the window, or the read
 * failed) - a failed ambient badge stays silent rather than surfacing a
 * banner over ordinary canvas chrome; it never swaps to a stale/local-only
 * number to fill the gap.
 *
 * App-wide host access (`useReactiveActiveHostId` / `useHostClient`), not
 * `useTabHostId` - this status row sits above the per-tile `TabHostProvider`
 * scope.
 *
 * Host-backed, so this must only be mounted where the host runtime and the
 * Epic session exist (the status row gates on `snapshotLoaded`, which
 * implies a live session) - wrapped in `StatusRowChromeBoundary`, matching
 * its sibling `EpicSweepAction`, since host hooks throw when the runtime is
 * absent or incomplete and this decorative chrome must never be able to take
 * the canvas down with it.
 */
export function EpicCostBadge(props: { readonly epicId: string }): ReactNode {
  return (
    <StatusRowChromeBoundary label="cost badge">
      <EpicCostBadgeBody epicId={props.epicId} />
    </StatusRowChromeBoundary>
  );
}

function EpicCostBadgeBody(props: { readonly epicId: string }): ReactNode {
  const hostId = useReactiveActiveHostId();
  const client = useHostClient();
  const supported = useUsageSummarySupported(hostId);
  const request = useMemo(
    () =>
      buildUsageSummaryRequest({
        windowDays: EPIC_COST_BADGE_WINDOW_DAYS,
        epicId: props.epicId,
      }),
    [props.epicId],
  );
  // Real client unconditionally, gated through `enabled` - see the doc
  // comment on `useUsageSummaryForClient` for why nulling the client instead
  // (this component's original shape) is the wrong way to express this gate.
  // `poll: true` gives this ambient, unsupervised badge a bounded self-heal
  // interval instead of a one-shot fetch with no other trigger.
  const query = useUsageSummaryForClient(client, request, supported, true);

  if (!supported || query.data === undefined) return null;
  const { summary, coverage, servedBy } = query.data;
  if (summary.totals.factCount === 0) return null;

  const { headline, coverageNote } = describeCostCoverage(
    summary.totals,
    coverage,
  );
  const scopeNote = servedByScopeNote(servedBy);
  const tooltip = [
    `Last ${String(EPIC_COST_BADGE_WINDOW_DAYS)} days, ${FULL_RATE_QUALIFIER}.`,
    coverageNote === null ? null : coverageNote,
    scopeNote,
  ]
    .filter((line): line is string => line !== null)
    .join(" ");

  return (
    <TooltipWrapper
      label={tooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        data-testid="epic-cost-badge"
        className={cn(
          "inline-flex h-5 items-center gap-1 px-1.5 py-0 text-overline text-muted-foreground italic leading-none",
        )}
      >
        {headline}
      </span>
    </TooltipWrapper>
  );
}
