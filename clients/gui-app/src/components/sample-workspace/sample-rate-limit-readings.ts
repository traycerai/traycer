import { SAMPLE_USAGE_USED_PERCENT } from "./sample-workspace-scene";
import { classifyProviderRateLimitWindow } from "@traycer/protocol/host/rate-limit";
import { statusBarSegmentKey } from "@/components/layout/status-bar/status-bar-usage-display";
import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitCluster,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { RateLimitWindowKind } from "@/lib/rate-limits/rate-limit-window-catalog";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

interface StatusBarPreviewSampleReading {
  readonly usedPercent: number;
  /** The static name the countdown gives way to when the timer is off. */
  readonly label: string;
  readonly kind: RateLimitWindowKind;
  readonly durationMinutes: number;
  /**
   * How far from `now` the reset sits. Half a bucket past the figure it is
   * meant to print, so the countdown lands on that figure exactly rather than
   * one minute under it.
   */
  readonly resetsInMs: number;
}

/**
 * Two readings that look like readings: a session window part-way through and
 * a weekly one further along, so the mode word, the bar, the countdown and the
 * Used/Remaining flip all have something to change.
 */
const SAMPLE_READINGS: ReadonlyArray<StatusBarPreviewSampleReading> = [
  {
    usedPercent: SAMPLE_USAGE_USED_PERCENT,
    label: "5h",
    kind: "session",
    durationMinutes: 5 * 60,
    resetsInMs: 4 * HOUR_MS + 15 * MINUTE_MS + 30_000,
  },
  {
    usedPercent: 82,
    label: "wk",
    kind: "weekly",
    durationMinutes: 7 * 24 * 60,
    resetsInMs: 2 * DAY_MS + 12 * HOUR_MS,
  },
];

/** The frame's cluster while the sample is speaking, and who it spoke for. */
interface StatusBarPreviewSample {
  readonly cluster: StatusBarRateLimitCluster;
  readonly segmentKeys: ReadonlyArray<string>;
}

/**
 * The sample, or `null` when the host's own readings are worth drawing.
 *
 * Two conditions, and both are narrow on purpose. Nothing in the cluster may
 * be `live` or `degraded`: one real number is a number, and a preview that put
 * invented ones beside it would be indistinguishable from the strip having
 * fetched them. And something in it must be `cold` - a cluster of nothing but
 * `unavailable` providers is a cluster of providers that ANSWERED, and the
 * caption's "no usage has been fetched" would be false for every one of them.
 *
 * Every segment is kept and every one stays in the strip's own order: the
 * substitution walks the cluster rather than the readings, so the provider
 * count, the icon set and each provider's own switches are the ones the strip
 * would have. `SAMPLE_READINGS` runs out
 * after two, and the cold providers past them keep their cold track - two
 * invented numbers are enough to answer every switch on this page, and a
 * strip of six identical ones would look like data.
 */
export function statusBarPreviewSample(
  cluster: StatusBarRateLimitCluster,
  now: number,
): StatusBarPreviewSample | null {
  if (cluster.kind !== "segments") return null;
  const hasReading = cluster.segments.some(
    (segment) => segment.state === "live" || segment.state === "degraded",
  );
  if (hasReading) return null;
  if (!cluster.segments.some((segment) => segment.state === "cold")) {
    return null;
  }
  // Resolved as a list first, then applied: the position of a segment in this
  // list is also which reading it gets, and the notes below need the same
  // list to know whose line the caption now covers. Keyed by SEGMENT rather
  // than provider, since a provider with two accounts checked is two cold
  // tracks, and both deserve a different number.
  const segmentKeys = cluster.segments
    .filter((segment) => segment.state === "cold")
    .slice(0, SAMPLE_READINGS.length)
    .map(statusBarSegmentKey);
  const segments = cluster.segments.map((segment) => {
    const index = segmentKeys.indexOf(statusBarSegmentKey(segment));
    return index === -1
      ? segment
      : sampleSegment(segment, SAMPLE_READINGS[index], now);
  });
  return { cluster: { kind: "segments", segments }, segmentKeys };
}

function sampleSegment(
  segment: StatusBarProviderSegmentModel,
  reading: StatusBarPreviewSampleReading,
  now: number,
): StatusBarProviderSegmentModel {
  const resetsAt = now + reading.resetsInMs;
  const window: StatusBarRateLimitWindow = {
    windowKey: `${segment.providerId}:sample`,
    label: reading.label,
    labelIsDuration: true,
    kind: reading.kind,
    usedPercent: reading.usedPercent,
    resetsAt,
    // The strip's own classifier over the same three numbers, so the sample
    // is tinted exactly as a real reading of that size would be.
    severity: classifyProviderRateLimitWindow({
      usedPercent: reading.usedPercent,
      resetsAt,
      durationMinutes: reading.durationMinutes,
    }),
  };
  return {
    ...segment,
    state: "live",
    reason: null,
    windows: [window],
    // The one invented reading is also the whole selection: a sample stands in
    // for a provider that has reported nothing, so there is no stored pick to
    // resolve against and nothing for the list to hold back.
    shown: [window],
    tightest: window,
  };
}
