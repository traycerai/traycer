import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitCluster,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { providerDisplayName } from "@/lib/provider-ordering";
import { formatUnavailableReason } from "@/lib/provider-rate-limit-content";
import {
  useLayoutStore,
  type PercentMode,
} from "@/stores/settings/layout-store";

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

/** One empty list for the three cluster states that draw no segments. */
const NO_SEGMENTS: ReadonlyArray<StatusBarProviderSegmentModel> = [];

/**
 * Everything about the readings that the user chose.
 *
 * One value because two surfaces draw these readings - the strip and the
 * Settings preview - and both need the same four answers to one question:
 * what a segment prints. Passing them together is what keeps a preview from
 * being a second opinion about the settings it exists to show. Which of a
 * provider's limits are drawn is NOT here: that is resolved into the segment
 * model itself, so a segment already carries the windows it should draw.
 */
export interface StatusBarUsageDisplay {
  readonly percentMode: PercentMode;
  readonly showModeWord: boolean;
  readonly showBar: boolean;
  readonly showTimer: boolean;
}

/**
 * What a reading is made of, as three independent answers the render path
 * can test rather than a preference object it would have to interpret.
 *
 * The strip draws every drawn account at exactly this detail at every width -
 * the percentage and the window's label are always printed, and nothing is
 * taken away to make room, because what does not fit scrolls into view
 * instead. So the parts are the preferences and nothing else: a part is off
 * only when the user switched it off.
 */
export interface StatusBarUsageParts {
  readonly modeWord: boolean;
  readonly bar: boolean;
  readonly timer: boolean;
}

export function statusBarUsageParts(
  display: StatusBarUsageDisplay,
): StatusBarUsageParts {
  return {
    modeWord: display.showModeWord,
    bar: display.showBar,
    timer: display.showTimer,
  };
}

/**
 * Field by field rather than one object selector: a selector returning a fresh
 * object every call makes `useSyncExternalStore` see a new snapshot on each
 * read and re-render forever.
 */
export function useStatusBarUsageDisplay(): StatusBarUsageDisplay {
  const percentMode = useLayoutStore(
    (state) => state.statusBar.rateLimits.percentMode,
  );
  const showModeWord = useLayoutStore(
    (state) => state.statusBar.rateLimits.showModeWord,
  );
  const showBar = useLayoutStore((state) => state.statusBar.rateLimits.showBar);
  const showTimer = useLayoutStore(
    (state) => state.statusBar.rateLimits.showTimer,
  );
  return { percentMode, showModeWord, showBar, showTimer };
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
