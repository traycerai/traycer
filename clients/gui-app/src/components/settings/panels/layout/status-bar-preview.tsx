import { useCallback, useRef, useState, type ReactNode } from "react";
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
  type StatusBarUsageLadder,
  type StatusBarUsageStop,
} from "@/components/layout/status-bar/status-bar-usage-ladder";
import {
  providerReadingText,
  statusBarClusterSegments,
  statusBarSegmentTooltip,
  statusBarUsageContentClass,
  useStatusBarUsageDisplay,
  type StatusBarUsageDisplay,
} from "@/components/layout/status-bar/status-bar-usage-display";
import { StatusBarUsageReadings } from "@/components/layout/status-bar/status-bar-usage-readings";
import { useStatusBarResourceMetricViews } from "@/components/layout/status-bar/use-status-bar-resource-views";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
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
  // Placement is only half of "is the strip on screen". Below `md` the shell
  // does not mount it whatever placement says, and the header keeps both
  // controls (`AppShell`) - so the frame is a picture of a surface that is not
  // drawn at this width either, and saying so is the same honesty the
  // header-placement caption already owes.
  const narrowViewport = useIsMobileViewport();
  const stripDrawn = placement === "status-bar" && !narrowViewport;
  const { sentinelRef, stickyRef } = useStuckAttribute();
  const stripRef = useRef<HTMLDivElement | null>(null);
  const density = useStatusBarDensity(stripRef);
  const display = useStatusBarUsageDisplay();
  const cluster = usePreviewCluster();
  const segments = statusBarClusterSegments(cluster);
  // Stepped HERE rather than inside the frame, because both halves of the
  // preview need the verdict: the frame draws the rung, and the notes outside
  // it have to name the providers that rung FOLDED - the `+N` chip's tooltip is
  // the one explanation `inert` puts out of reach.
  const ladder = useStatusBarUsageLadder({
    ceiling: statusBarUsageDetailCeiling(density),
    levels: statusBarUsageLadderLevels(display),
    segmentCount: segments.length,
    enabled: segments.length > 0,
  });
  return (
    <>
      {/*
        The sticky block's own tripwire: it sits where the block sits when
        nothing is pinned, so the frame is pinned exactly when this is clipped
        out of the settings scroll container. `h-px` because a zero-height
        target never intersects anything, and `-mb-px` so the hairline it costs
        is given straight back.

        It reports at every width, which is why what it drives is `md:`-gated
        rather than the attribute itself: below `md` the block never leaves
        flow, so `data-stuck` there says only that the sentinel has scrolled
        away.
      */}
      <div ref={sentinelRef} className="-mb-px h-px" />
      <div
        ref={stickyRef}
        data-stuck="false"
        data-testid="status-bar-preview-block"
        className={cn(
          // Pinned to the settings scroll container's top edge and released by
          // the group's own bottom: a sticky box is positioned against the
          // nearest SCROLLPORT - the settings `overflow-y-auto` box, which is
          // padding-less in both the modal and the tab, hence `top-0` - and
          // confined to its CONTAINING BLOCK, which is `SettingsGroup`'s card.
          // That is why the card is `overflow-clip` rather than
          // `overflow-hidden`, which would make the card itself the scrollport.
          // Pinning is what lets a reader flip a provider switch four rows down
          // and watch the strip answer.
          //
          // From `md` up only, and the gate is the same breakpoint `AppShell`
          // mounts the strip on. Below it this block is a dimmed, `inert`
          // picture of a surface the shell does not draw, and it is tall - the
          // header row, the frame, the notes and two captions, all of which
          // wrap. Pinned on a landscape phone it would take most of the
          // scrollport, and a sticky box taller than its scrollport pins its
          // TOP, so its own last caption would be unreachable: scrolling is
          // exactly what the pin cancels.
          "md:sticky md:top-0 md:z-10 space-y-3 border-b border-border/40",
          // Opaque and lifted only while pinned: unpinned this block IS part of
          // the card and has to look like it, pinned it has rows travelling
          // underneath and a translucent fill would let them through. Gated on
          // `md` with the pin, because the sentinel keeps reporting on a block
          // that is not pinned there - a static block whose sentinel has
          // scrolled out would otherwise paint the stuck fill mid-card.
          //
          // The fill is the card's own COMPOSITE rather than one flat token,
          // which is the trap a pinned child inside a `bg-card/40` pane falls
          // into (see the model-providers tab, which gave up its sticky search
          // over exactly this): the card's tint paints behind this block, so
          // repainting it opaque hides the tint the rows below still have. The
          // surface under the card is `bg-background` in both the modal and the
          // tab, so the base is that and the tint is restored on a `-z-10`
          // pseudo - element background, then pseudo, then content, the same
          // three layers in the same order the rest of the card gets.
          "md:data-[stuck=true]:bg-background md:data-[stuck=true]:shadow-sm",
          "md:data-[stuck=true]:before:absolute md:data-[stuck=true]:before:inset-0 md:data-[stuck=true]:before:-z-10 md:data-[stuck=true]:before:bg-card/40",
          compact ? "px-4 py-2.5" : "px-5 py-4",
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="min-w-[50%] flex-1 space-y-1">
            <div className="font-medium text-foreground">Preview</div>
            <p className="max-w-[72ch] text-pretty text-ui-sm text-muted-foreground">
              The strip as these settings draw it. Narrow it to see what
              collapses first on a small window.
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
          surface rather than the surface: every control in it is a real one
          that would be a dead end here, and the rows below this are where each
          of them is actually configured. `inert` takes them out of the tab
          order and stops the tooltips inside from ever opening; `aria-hidden`
          keeps a screen reader from reading the strip's contents a second time
          under a control that does nothing. What those tooltips would have
          said is in the caption below instead - see `StatusBarPreviewNotes`.
        */}
        <div
          inert
          aria-hidden
          data-testid="status-bar-preview-frame"
          data-preview-width={width}
          className={cn(
            "w-full overflow-hidden rounded-md border border-border/70 bg-canvas text-canvas-foreground",
            PREVIEW_WIDTH_CLASS[width],
            // Greyed, not hidden: wherever the strip is not the surface currently
            // drawn - header placement, or a window too narrow for it - these
            // settings still describe a real strip, and a preview that vanished
            // would read as the settings having no effect.
            !stripDrawn && "opacity-50",
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
              cluster={cluster}
              display={display}
              ladder={ladder}
            />
          </div>
        </div>
        {/*
          Dimmed with the frame whenever the frame is, for the same reason it
          is: they explain a strip that is not the one currently drawn, and
          full-strength explanations under a greyed picture read as the two
          disagreeing about which of them is live.
        */}
        <StatusBarPreviewNotes
          density={density}
          scope={props.scope}
          hasExplicitPick={props.hasExplicitPick}
          cluster={cluster}
          display={display}
          stop={ladder.stop}
          dimmed={!stripDrawn}
        />
        {stripDrawn ? null : (
          <p className="text-ui-sm text-muted-foreground">
            {/* The narrow case gets its own sentence because the other one
              would be a false promise there: flipping placement changes
              nothing at this width. */}
            {narrowViewport
              ? "The strip is not shown at this window width; the header keeps its controls."
              : "Shown when placement is Status bar."}
          </p>
        )}
        <p className="text-ui-sm text-muted-foreground">
          {`Live data from ${props.scope.hostLabel}. Refresh happens from the strip or the usage panel, not from here.`}
        </p>
      </div>
    </>
  );
}

interface StuckAttribute {
  /** The tripwire, rendered immediately ABOVE the sticky element. */
  readonly sentinelRef: (node: HTMLElement | null) => (() => void) | undefined;
  /** The sticky element itself, whose `data-stuck` this writes. */
  readonly stickyRef: (node: HTMLElement | null) => undefined;
}

/**
 * `data-stuck` on a pinned element, written by an `IntersectionObserver` and
 * never by React.
 *
 * The attribute exists because CSS still cannot ask whether a `position:
 * sticky` box is currently pinned, and the styling it drives (an opaque fill
 * and a hairline lift, so rows do not travel through the frame) is only
 * correct while it is. Every other way to answer that question reads the
 * scroll position, which means a listener on a scrolling container writing
 * React state - a re-render of the whole preview per scrolled pixel, on the
 * one surface that is already re-rendering to a ladder and a 1 Hz sampler.
 *
 * So the verdict is a DOM WRITE from an observer callback, exactly as the
 * usage ladder keeps its measurement out of an effect: the sentinel is clipped
 * out of the settings scroll container at the moment the block pins, and
 * `IntersectionObserver` computes intersection through every clipping
 * ancestor, so the default `root` answers about the scrollport without this
 * having to name it.
 *
 * Both refs are CALLBACK refs and both are stable, so React never detaches and
 * rebuilds the observer for an unrelated re-render.
 */
function useStuckAttribute(): StuckAttribute {
  const stickyNodeRef = useRef<HTMLElement | null>(null);
  const stickyRef = useCallback((node: HTMLElement | null) => {
    stickyNodeRef.current = node;
    return undefined;
  }, []);
  const sentinelRef = useCallback((node: HTMLElement | null) => {
    if (node === null) return undefined;
    const observer = new IntersectionObserver((entries) => {
      const sticky = stickyNodeRef.current;
      if (sticky === null) return;
      for (const entry of entries) {
        sticky.dataset.stuck = entry.isIntersecting ? "false" : "true";
      }
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);
  return { sentinelRef, stickyRef };
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
  readonly cluster: StatusBarRateLimitCluster;
  readonly display: StatusBarUsageDisplay;
  readonly ladder: StatusBarUsageLadder;
}): ReactNode {
  const rateLimitsEnabled = useLayoutStore(
    (state) => state.statusBar.rateLimits.enabled,
  );
  const resourcesEnabled = useLayoutStore(
    (state) => state.statusBar.resources.enabled,
  );
  const { cluster, display } = props;
  const { stop, roomRef, reservedRef, contentRef } = props.ladder;
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
            {/*
              The refresh control's BOX without the control: the ladder
              subtracts whatever shares the room with the readings, so a
              preview that drew nothing here would measure ~24px more room than
              the strip has and keep one rung of detail the strip has already
              given up - at the Narrow width, which exists to show exactly
              where that happens. Composed the way the strip composes it
              (`pl-1` gap plus the button's `size-5`) rather than as one width,
              so the two are read from the same two numbers. The real
              `RefreshIconButton` would close it too, but it would render
              disabled here - a passive reader has nothing to refresh - which
              misrepresents a live control.
            */}
            <span
              ref={reservedRef}
              data-testid="status-bar-preview-reserved"
              className="flex shrink-0 items-center pl-1"
            >
              <span className="block size-5" />
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
 * dashes where the resource numbers should be, a dimmed reading behind a
 * warning glyph, or a `+2` chip with no way to see which two. One line each,
 * from the same builders the tooltips use, so the caption and the strip can
 * never word the same state differently.
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
  readonly cluster: StatusBarRateLimitCluster;
  readonly display: StatusBarUsageDisplay;
  /** The rung the frame settled on, and with it which providers it folded. */
  readonly stop: StatusBarUsageStop;
  /**
   * The strip is not the surface currently drawn - header placement, or a
   * window too narrow for one.
   */
  readonly dimmed: boolean;
}): ReactNode {
  const rateLimitsEnabled = useLayoutStore(
    (state) => state.statusBar.rateLimits.enabled,
  );
  const resourcesEnabled = useLayoutStore(
    (state) => state.statusBar.resources.enabled,
  );
  const usageNotes = rateLimitsEnabled
    ? statusBarPreviewUsageNotes(props.cluster, props.stop, props.display)
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

/**
 * The usage half of the caption: why a reading is not live, then which
 * providers the current rung folded away.
 *
 * The folded line is the `+N` chip's tooltip, said outside the frame. `+2` with
 * no way to see which two is at its worst at the Narrow width, which is the one
 * width a reader picks precisely to find out what folds - and it is built from
 * the chip's own `providerReadingText`, so the two can never disagree.
 */
function statusBarPreviewUsageNotes(
  cluster: StatusBarRateLimitCluster,
  stop: StatusBarUsageStop,
  display: StatusBarUsageDisplay,
): ReadonlyArray<string> {
  const segments = statusBarClusterSegments(cluster);
  const notes = segments
    .filter((segment) => segment.state !== "live")
    .map(statusBarSegmentTooltip);
  if (stop.foldedCount === 0) return notes;
  const folded = segments
    .slice(segments.length - stop.foldedCount)
    .map((segment) => providerReadingText(segment, display.percentMode));
  return [...notes, `Folded: ${folded.join(", ")}`];
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
 * Resolved ONCE, at the component both halves of the preview hang off, and
 * handed to each as a prop: the strip that draws the readings and the caption
 * that explains them have to agree about which providers the current rung
 * folded, and a fold is a property of the LADDER, which only one of them can
 * own. Two calls would still resolve to the same TanStack observers over the
 * same keys - the cost was never duplicate reads - but the ladder cannot be
 * stepped twice against two boxes and asked for one answer.
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
