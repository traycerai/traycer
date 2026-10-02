import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitCluster,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { providerDisplayName } from "@/lib/provider-ordering";
import { formatUnavailableReason } from "@/lib/provider-rate-limit-content";
import { useRegionValues } from "@/lib/layout-overrides";
import { windowPercentText } from "@/lib/rate-limits/status-bar-window-text";
import type { RateLimitWindowSeverity } from "@/lib/rate-limits/window-severity";
import type { AmountMode } from "@/lib/layout/layout-values";

/**
 * The box the readings sit in, at its NATURAL width.
 *
 * `shrink-0` is the whole point: the box lives inside a scroller, and a box
 * that shrank to fit the room would never overflow it - the readings would be
 * squeezed and clipped rather than scrolled to. One constant rather than two
 * literals because both boxes that render these readings - the strip and the
 * Settings preview - have to be the same box, and a second call site copying
 * the string is how the two drift.
 */
export const STATUS_BAR_USAGE_CONTENT_CLASS =
  "inline-flex shrink-0 items-center gap-2 px-1.5";

/**
 * What a segment is called wherever a segment is named: the provider, and the
 * account after it when the provider has more than one (`Codex · Work`). The
 * account is named only where the dot is drawn, for the same reason the dot is
 * drawn only then - one account needs telling apart from nothing.
 */
export function statusBarSegmentName(
  segment: StatusBarProviderSegmentModel,
): string {
  const name = providerDisplayName(segment.providerId);
  return segment.account === null ? name : `${name} · ${segment.account.label}`;
}

/**
 * Stable identity for one segment across renders: a provider can draw several
 * accounts, so the provider id alone is not one.
 */
export function statusBarSegmentKey(
  segment: StatusBarProviderSegmentModel,
): string {
  return `${segment.providerId}:${segment.profileId ?? ""}`;
}

/**
 * WHOSE segments the cluster is drawing, as one string that changes exactly
 * when the host or the segment set does - a host switch, a provider hidden or
 * shown, an account checked or unchecked - and not when a reading inside a
 * segment moves. What scrolls back to the start on a change is keyed on this.
 *
 * The host is part of it because the ids alone can coincide across hosts: two
 * machines each drawing the ambient login of the same providers produce the
 * same segment keys, and the strip keeps its subtree across a host switch, so
 * without the host the scroll position would survive a switch to a strip
 * that reads entirely different numbers. `JSON.stringify` rather than a
 * joined string so a `null` host and a host id can never spell the same key.
 */
export function statusBarUsageScrollKey(
  hostId: string | null,
  cluster: StatusBarRateLimitCluster,
): string {
  return JSON.stringify([
    hostId,
    ...statusBarClusterSegments(cluster).map(statusBarSegmentKey),
  ]);
}

const SEVERITY_RANK: Readonly<Record<RateLimitWindowSeverity, number>> = {
  healthy: 0,
  running_low: 1,
  limited: 2,
};

/**
 * The severity a profile is drawn at: the worst of the windows the strip shows
 * for it. The host decides each window's tier (`semantics.ts`); this only picks
 * between them, so a profile showing two limits is never calmer than either.
 * A segment with nothing to show (cold, unavailable) is calm.
 */
export function statusBarSegmentSeverity(
  segment: StatusBarProviderSegmentModel,
): RateLimitWindowSeverity {
  return segment.shown.reduce<RateLimitWindowSeverity>(
    (worst, window) =>
      SEVERITY_RANK[window.severity] > SEVERITY_RANK[worst]
        ? window.severity
        : worst,
    "healthy",
  );
}

/** One empty list for the three cluster states that draw no segments. */
const NO_SEGMENTS: ReadonlyArray<StatusBarProviderSegmentModel> = [];

/**
 * Everything about the readings that the user chose.
 *
 * One value because two surfaces draw these readings - the strip and the
 * Settings preview - and both need the same answers to one question: what a
 * segment prints. Passing them together is what keeps a preview from being a
 * second opinion about the settings it exists to show. Which of a provider's
 * limits are drawn is NOT here: that is resolved into the segment model
 * itself, so a segment already carries the windows it should draw. Neither is
 * the density, which decides which component draws the readings at all.
 */
export interface StatusBarUsageDisplay {
  readonly percentMode: AmountMode;
  readonly showTimer: boolean;
}

/**
 * Through the override seam (`lib/layout-overrides.ts`), so a style example or
 * a specimen stage can draw the real readings under a different answer.
 *
 * One region read rather than two: every one of these leaves lives in the
 * `usageLimits` bag, so a reader of one is a reader of the region, and the
 * delta's identity changes only when that region does.
 */
export function useStatusBarUsageDisplay(): StatusBarUsageDisplay {
  const values = useRegionValues("usageLimits");
  return { percentMode: values.amount, showTimer: values.reset };
}

/** The segments a cluster is drawing, or one shared empty list for the rest. */
export function statusBarClusterSegments(
  cluster: StatusBarRateLimitCluster,
): ReadonlyArray<StatusBarProviderSegmentModel> {
  return cluster.kind === "segments" ? cluster.segments : NO_SEGMENTS;
}

/**
 * Why one provider's reading is dimmed, dashed or missing, in one sentence.
 *
 * Lives beside the readings rather than inside the segment because two surfaces
 * have to say it and only one of them can say it in a tooltip: the Settings
 * preview's readings are `inert`, so nothing in them can ever open one, and
 * the caption under the frame has to carry the same words. A second phrasing of the same
 * state is how a preview starts disagreeing with the strip it previews.
 */
export function statusBarSegmentTooltip(
  segment: StatusBarProviderSegmentModel,
): string {
  const providerName = statusBarSegmentName(segment);
  if (segment.state === "degraded") {
    return segment.reason === null
      ? `${providerName} · couldn't refresh usage, showing the last reading`
      : `${providerName} · ${formatUnavailableReason(segment.reason)} · showing the last reading`;
  }
  if (segment.state === "unavailable" && segment.reason !== null) {
    return `${providerName} · ${formatUnavailableReason(segment.reason)}`;
  }
  if (segment.state === "cold") return `${providerName} · no reading yet`;
  return providerName;
}

/**
 * What a screen reader hears on a usage trigger - the status bar's, or the
 * tab strip's when the reading lives there: the headline, then the
 * tightest reading for each segment it is showing - named by provider, and by
 * account too where the provider has more than one.
 *
 * One reading per segment rather than every window, because this is a control
 * name and a name is read in full before anything else can happen. The tightest
 * window is the one the segment model selects by default for the same reason -
 * it is the number that decides whether the panel is worth opening. Every
 * segment is in the name whether or not it is currently scrolled into view:
 * what a screen reader hears cannot depend on where the strip is scrolled to.
 */
export function statusBarUsageTriggerName(
  cluster: StatusBarRateLimitCluster,
  percentMode: AmountMode,
): string {
  if (cluster.kind !== "segments") return "Usage limits";
  const readings = cluster.segments.flatMap((segment) =>
    segment.tightest === null
      ? []
      : [
          `${statusBarSegmentName(segment)} ${windowPercentText(
            segment.tightest.usedPercent,
            percentMode,
          )}`,
        ],
  );
  if (readings.length === 0) return "Usage limits";
  return `Usage limits: ${readings.join(", ")}`;
}
