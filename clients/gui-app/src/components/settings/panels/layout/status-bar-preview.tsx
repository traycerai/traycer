import { useRef, useState, type ReactNode } from "react";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { SettingsSegmentedControl } from "@/components/settings/controls/settings-segmented-control";
import {
  useStatusBarDensity,
  type StatusBarDensity,
} from "@/components/layout/status-bar/status-bar-density";
import { StatusBarResourceSegment } from "@/components/layout/status-bar/status-bar-resource-segment";
import {
  statusBarUsageDetailCeiling,
  statusBarUsageLadderLevels,
  useStatusBarUsageLadder,
} from "@/components/layout/status-bar/status-bar-usage-ladder";
import {
  statusBarClusterSegments,
  statusBarSegmentTooltip,
  statusBarUsageContentClass,
  useStatusBarUsageDisplay,
} from "@/components/layout/status-bar/status-bar-usage-display";
import { StatusBarUsageReadings } from "@/components/layout/status-bar/status-bar-usage-readings";
import { useStatusBarResourceMetricViews } from "@/components/layout/status-bar/use-status-bar-resource-views";
import { useRateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import {
  useStatusBarRateLimitSegments,
  useStatusBarWindowedProviders,
  type StatusBarRateLimitCluster,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { useLayoutStore } from "@/stores/settings/layout-store";

/**
 * How wide the preview pretends to be. Component state, never persisted: it is
 * a way of LOOKING at the strip, not a preference about it, and a persisted
 * copy would outlive the question it was asked for.
 *
 * The three options are the strip's three DENSITY RUNGS rather than three
 * arbitrary widths, which is why the frame's own chrome does not spoil them:
 * the strip's thresholds are `< 500` icon-only and `< 900` compact, and the
 * frame's border takes 2px off whatever it is capped at - so 480 measures 478
 * (`icon-only`), 900 measures 898 (`compact`), and only the uncapped option
 * can measure past 900 and reach `full`.
 *
 * `wide` is therefore the default. At `compact` the ladder ceiling is
 * `no-timers`, where the mode word, the mini bar and the countdown are all off
 * whatever the store says - so a preview that opened there would answer "these
 * switches do nothing" to the first three switches a user tries.
 */
export type StatusBarPreviewWidth = "narrow" | "normal" | "wide";

const PREVIEW_WIDTH_CLASS: Record<StatusBarPreviewWidth, string> = {
  narrow: "max-w-[480px]",
  normal: "max-w-[900px]",
  wide: "max-w-full",
};

/**
 * The status bar as the settings on this page draw it, from the watched host's
 * real readings.
 *
 * **It never causes one.** Every usage observer under it is passive (see
 * `useStatusBarRateLimitSegments`'s `mode`), it mounts no cold-start refresh, no
 * refresh control, no popover, no resource stream and no
 * `RateLimitQueueProvider` consumer, and it registers no keyboard handler. What
 * it shows is exactly what the strip and the usage panel have already put in
 * the shared cache - which is why the caption says where a refresh comes from
 * instead of offering one.
 *
 * Two things it DOES do, both stated here because the list above is only worth
 * reading if it is exhaustive:
 *
 * - under the Desktop-app resource scope, AND only while the resource monitor
 *   is switched on, it inherits the segment's `useDesktopAppResourceUsage`,
 *   whose module-level 1 Hz IPC sampler then runs for as long as this page is
 *   open. Local IPC, shared and refcounted with the strip's own subscriber, and
 *   the preview genuinely renders those numbers. With the monitor off nothing
 *   under here subscribes - which is why the note that explains a dashed
 *   reading is its own component rather than a gated result.
 * - it does NOT re-provide `StreamRuntimeContext`, because acquiring a scoped
 *   stream binding would open a transport. The numbers stay correct regardless
 *   (`attributedProjection` keys on the watched host, so a foreign projection
 *   cannot print); only `useGlobalResourcesPreCheckUnsupported` answers for the
 *   ambient host, and it only chooses which sentence a DASHED metric gets.
 *
 * That also makes it honest rather than idealised: a provider with no reading
 * yet renders its cold track here, an account with none renders the strip's
 * "connect a provider" line, and with no global resource stream mounted the
 * resource segment renders its dashes. A preview that fetched to fill those in
 * would be showing a strip the user does not have.
 */
export function StatusBarPreview(props: {
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
}): ReactNode {
  const compact = useSettingsDensity() === "compact";
  const [width, setWidth] = useState<StatusBarPreviewWidth>("wide");
  const placement = useLayoutStore((state) => state.statusBar.placement);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const density = useStatusBarDensity(stripRef);
  return (
    <div
      className={cn(
        "space-y-3 border-b border-border/40",
        compact ? "px-4 py-2.5" : "px-5 py-4",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-[50%] flex-1 space-y-1">
          <div className="font-medium text-foreground">Preview</div>
          <p className="max-w-[72ch] text-pretty text-ui-sm text-muted-foreground">
            The strip as these settings draw it. Narrow it to see what collapses
            first on a small window.
          </p>
        </div>
        <div className="ml-auto flex max-w-full shrink-0 justify-end">
          <SettingsSegmentedControl
            value={width}
            options={[
              { value: "narrow", label: "Narrow" },
              { value: "normal", label: "Normal" },
              { value: "wide", label: "Wide" },
            ]}
            onChange={setWidth}
            ariaLabel="Preview width"
          />
        </div>
      </div>
      {/*
        `aria-hidden` and `inert` together, because this is a picture of a
        surface rather than the surface: every control in it is a real one that
        would be a dead end here, and the rows below this are where each of
        them is actually configured. `inert` takes them out of the tab order
        and stops the tooltips inside from ever opening; `aria-hidden` keeps a
        screen reader from reading the strip's contents a second time under a
        control that does nothing. What those tooltips would have said is in
        the caption below instead - see `StatusBarPreviewNotes`.
      */}
      <div
        inert
        aria-hidden
        data-testid="status-bar-preview-frame"
        data-preview-width={width}
        className={cn(
          "w-full overflow-hidden rounded-md border border-border/70 bg-canvas text-canvas-foreground",
          PREVIEW_WIDTH_CLASS[width],
          // Greyed, not hidden: in header placement these settings still
          // describe a real strip, just not the one currently drawn - and a
          // preview that vanished would read as the settings having no effect.
          placement === "header" && "opacity-50",
        )}
      >
        {/*
          The measured box, and the counterpart of the strip's own outer div:
          density is a fact about how much room the bar HAS, so it is read
          from the box the padding sits inside rather than from the padded row
          - exactly where `AppStatusBar` reads it.
        */}
        <div ref={stripRef} data-testid="status-bar-preview">
          <StatusBarPreviewStrip
            density={density}
            scope={props.scope}
            hasExplicitPick={props.hasExplicitPick}
          />
        </div>
      </div>
      {/*
        Dimmed with the frame under header placement, for the same reason it
        is: they explain a strip that is not the one currently drawn, and
        full-strength explanations under a greyed picture read as the two
        disagreeing about which of them is live.
      */}
      <StatusBarPreviewNotes
        density={density}
        scope={props.scope}
        hasExplicitPick={props.hasExplicitPick}
        dimmed={placement === "header"}
      />
      {placement === "header" ? (
        <p className="text-ui-sm text-muted-foreground">
          Shown when placement is Status bar.
        </p>
      ) : null}
      <p className="text-ui-sm text-muted-foreground">
        {`Live data from ${props.scope.hostLabel}. Refresh happens from the strip or the usage panel, not from here.`}
      </p>
    </div>
  );
}

/**
 * The strip itself, at the same `h-6` and with the same two clusters.
 *
 * Density is measured from THIS box rather than from the window, which is what
 * makes the width control mean something: the ladder answers the same question
 * it answers in the real strip - "does what I am holding fit the room I have" -
 * against a container the user just resized.
 */
function StatusBarPreviewStrip(props: {
  readonly density: StatusBarDensity;
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
}): ReactNode {
  const rateLimitsEnabled = useLayoutStore(
    (state) => state.statusBar.rateLimits.enabled,
  );
  const resourcesEnabled = useLayoutStore(
    (state) => state.statusBar.resources.enabled,
  );
  const display = useStatusBarUsageDisplay();
  const cluster = usePreviewCluster();
  const segments = statusBarClusterSegments(cluster);
  const { stop, roomRef, contentRef } = useStatusBarUsageLadder({
    ceiling: statusBarUsageDetailCeiling(props.density),
    levels: statusBarUsageLadderLevels(display),
    segmentCount: segments.length,
    enabled: segments.length > 0,
  });
  return (
    <div className="flex h-6 items-center gap-2 px-2 text-ui-xs tabular-nums">
      {/*
        The row's GROWER, exactly as the strip's usage slot is: the ladder
        records how much ROOM the readings have, and a slot sized by its own
        content would report the readings measuring themselves - a ladder that
        can only ever go down. It is why there is no separate spacer here; the
        spare room has to be absorbed by one box, and it may as well be the one
        that needs to know how much of it there is.
      */}
      <span className="flex min-w-0 flex-1 items-center gap-1">
        {rateLimitsEnabled ? (
          <span
            ref={roomRef}
            data-testid="status-bar-preview-usage"
            className="flex min-w-0 flex-1 items-center"
          >
            {/*
              The strip's trigger without the trigger: same box, same overflow
              rule, so the ladder measures what it measures there. A plain span
              because a `PopoverTrigger` outside a `Popover` throws, and a
              preview has nothing to open anyway.
            */}
            <span
              data-usage-detail={stop.detail}
              className="inline-flex h-6 min-w-0 items-center overflow-hidden text-muted-foreground"
            >
              {/* Its own testid rather than the strip's: Settings can be open
                while the real strip is mounted below it, and one id naming two
                live boxes is a trap for the next test that queries it. */}
              <span
                ref={contentRef}
                data-testid="status-bar-preview-content"
                className={statusBarUsageContentClass(cluster)}
              >
                <StatusBarUsageReadings
                  cluster={cluster}
                  stop={stop}
                  display={display}
                />
              </span>
            </span>
          </span>
        ) : null}
      </span>
      {resourcesEnabled ? (
        <StatusBarResourceSegment
          density={props.density}
          hostId={props.scope.hostId}
          hostLabel={props.scope.hostLabel}
          hasExplicitPick={props.hasExplicitPick}
        />
      ) : null}
    </div>
  );
}

/**
 * What the frame's tooltips would have said, said outside it.
 *
 * `inert` removes the frame from hit testing, so every `TooltipWrapper` in
 * there is unreachable by construction - and the states those tooltips exist
 * for are exactly the ones a preview reads as broken without them: three bare
 * dashes where the resource numbers should be, or a dimmed reading behind a
 * warning glyph. One line each, from the same builders the tooltips use, so
 * the caption and the strip can never word the same state differently.
 *
 * Two siblings rather than one list, because the resource half has to be able
 * to not exist: reading it costs a hook that SUBSCRIBES (see
 * `StatusBarPreviewResourceNote`), so it is mounted under the switch that says
 * whether anything renders those numbers at all. A single list could only do
 * that by rendering an empty one whenever the resources are healthy, which is
 * the common case.
 *
 * Silent when everything is reporting.
 */
function StatusBarPreviewNotes(props: {
  readonly density: StatusBarDensity;
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
  /** Header placement: these explain a strip that is not currently drawn. */
  readonly dimmed: boolean;
}): ReactNode {
  const rateLimitsEnabled = useLayoutStore(
    (state) => state.statusBar.rateLimits.enabled,
  );
  const resourcesEnabled = useLayoutStore(
    (state) => state.statusBar.resources.enabled,
  );
  const cluster = usePreviewCluster();
  const usageNotes = rateLimitsEnabled
    ? statusBarClusterSegments(cluster)
        .filter((segment) => segment.state !== "live")
        .map(statusBarSegmentTooltip)
    : NO_NOTES;
  return (
    <>
      {usageNotes.length === 0 ? null : (
        <ul
          data-testid="status-bar-preview-notes"
          className={cn(NOTE_CLASS, "space-y-1", props.dimmed && "opacity-50")}
        >
          {usageNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {resourcesEnabled ? (
        <StatusBarPreviewResourceNote
          density={props.density}
          scope={props.scope}
          hasExplicitPick={props.hasExplicitPick}
          dimmed={props.dimmed}
        />
      ) : null}
    </>
  );
}

/** One empty list, so a preview with nothing to explain re-renders for nothing. */
const NO_NOTES: ReadonlyArray<string> = [];

const NOTE_CLASS = "text-ui-sm text-muted-foreground";

/**
 * Why the resource segment has no number, when it has none.
 *
 * Its own component, and mounted only while the resource monitor is switched
 * on, because `useStatusBarResourceMetricViews` reaches
 * `useDesktopAppResourceUsage`, and SUBSCRIBING to that is what starts a 1 Hz
 * IPC poll of the shell. Gating the hook's RESULT rather than its mount would
 * run that poll for as long as this page is open, under a scope whose numbers
 * nothing on screen is drawing - the exact thing that hook's contract asks
 * callers not to do. The same "its own component so the hook count stays
 * fixed" move `StatusBarProviderMountRefresh` makes in the cluster.
 *
 * One reason, not one per dashed metric: the causes are scope-level far more
 * often than metric-level, so a segment with no stream behind it would
 * otherwise repeat the same sentence three times.
 */
function StatusBarPreviewResourceNote(props: {
  readonly density: StatusBarDensity;
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
  readonly dimmed: boolean;
}): ReactNode {
  const views = useStatusBarResourceMetricViews({
    density: props.density,
    hostId: props.scope.hostId,
    hostLabel: props.scope.hostLabel,
    hasExplicitPick: props.hasExplicitPick,
  });
  const reason = views.find(
    (view) => view.unavailableReason !== null,
  )?.unavailableReason;
  if (reason === undefined || reason === null) return null;
  return (
    <p
      data-testid="status-bar-preview-resource-note"
      className={cn(NOTE_CLASS, props.dimmed && "opacity-50")}
    >
      {reason}
    </p>
  );
}

/**
 * The preview's segments, read passively.
 *
 * Called by both halves of the preview - the strip that draws them and the
 * caption that explains them - rather than resolved once and passed down,
 * because the notes sit outside the frame in the DOM and threading a model
 * through the frame to reach them would put the two on opposite sides of a
 * component whose whole job is to be inert. Both calls resolve to the same
 * TanStack observers over the same keys, so there is one set of readings
 * however many readers ask.
 */
function usePreviewCluster(): StatusBarRateLimitCluster {
  const providers = useStatusBarWindowedProviders();
  const profileSelection = useRateLimitProfileSelection();
  const { cluster } = useStatusBarRateLimitSegments({
    providers,
    profileSelection,
    mode: "passive",
  });
  return cluster;
}
