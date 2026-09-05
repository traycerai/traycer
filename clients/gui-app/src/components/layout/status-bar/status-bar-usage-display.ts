import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitCluster,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { providerDisplayName } from "@/lib/provider-ordering";
import { formatUnavailableReason } from "@/lib/provider-rate-limit-content";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { windowPercentText } from "@/lib/rate-limits/status-bar-window-text";
import { cn } from "@/lib/utils";
import {
  useLayoutStore,
  type PercentMode,
} from "@/stores/settings/layout-store";

/**
 * The class the measured content box wears, which is not one class: it depends
 * on whether there is anything to measure.
 *
 * With segments the box is `shrink-0`, so its `scrollWidth` is the width the
 * readings WANT rather than the width they were given - the other half of the
 * ladder's overflow question, and a box that shrank to fit would answer it
 * "no" forever. With one sentence instead there is no ladder (its `enabled` is
 * off in exactly that state), and the sentence should behave like ordinary
 * text in a box too small for it, which `truncate` can only do inside a parent
 * allowed to squeeze it.
 *
 * A function rather than two constants because both boxes that render these
 * readings - the strip and the Settings preview - have to make the same choice
 * from the same input, and a second call site copying the ternary is how the
 * two drift.
 */
export function statusBarUsageContentClass(
  cluster: StatusBarRateLimitCluster,
): string {
  return cn(
    "inline-flex items-center gap-2 px-1.5",
    cluster.kind === "segments" ? "shrink-0" : "min-w-0",
  );
}

/**
 * One provider and its tightest reading, or the provider alone when it has none.
 *
 * Here rather than beside the `+N` chip that draws it, because the Settings
 * preview's caption has to say the same line OUTSIDE its frame - `inert` puts
 * the chip's own tooltip out of reach there - and two spellings of one reading
 * is exactly what this module exists to prevent.
 */
export function providerReadingText(
  segment: StatusBarProviderSegmentModel,
  percentMode: PercentMode,
): string {
  const name = providerDisplayName(segment.providerId);
  if (segment.tightest === null) return name;
  return `${name} ${windowPercentText(segment.tightest.usedPercent, percentMode)}`;
}

/** One empty list for the three cluster states that draw no segments. */
const NO_SEGMENTS: ReadonlyArray<StatusBarProviderSegmentModel> = [];

/**
 * Everything about the readings that the user chose rather than the strip
 * measured.
 *
 * One value because two surfaces draw these readings - the strip and the
 * Settings preview - and both need the same five answers for the same two
 * things: the ladder's active rungs, and what a segment prints at the rung it
 * lands on. Passing them together is what keeps a preview from being a second
 * opinion about the settings it exists to show.
 */
export interface StatusBarUsageDisplay {
  readonly percentMode: PercentMode;
  readonly showModeWord: boolean;
  readonly showBar: boolean;
  readonly showTimer: boolean;
  readonly expandedProviders: ReadonlyArray<RateLimitProviderId>;
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
  const expandedProviders = useLayoutStore(
    (state) => state.statusBar.rateLimits.expandedProviders,
  );
  return { percentMode, showModeWord, showBar, showTimer, expandedProviders };
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
 * preview is `inert`, so nothing inside its frame can ever open one, and the
 * caption under it has to carry the same words. A second phrasing of the same
 * state is how a preview starts disagreeing with the strip it previews.
 */
export function statusBarSegmentTooltip(
  segment: StatusBarProviderSegmentModel,
): string {
  const providerName = providerDisplayName(segment.providerId);
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
