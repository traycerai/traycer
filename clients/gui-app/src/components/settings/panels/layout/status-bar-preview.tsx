import { useCallback, useRef, useState, type ReactNode } from "react";
import { classifyProviderRateLimitWindow } from "@traycer/protocol/host/rate-limit";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { SettingsSegmentedControl } from "@/components/settings/controls/settings-segmented-control";
import { StatusBarResourceSegment } from "@/components/layout/status-bar/status-bar-resource-segment";
import {
  STATUS_BAR_USAGE_CONTENT_CLASS,
  statusBarClusterSegments,
  statusBarSegmentKey,
  statusBarSegmentTooltip,
  useStatusBarUsageDisplay,
  type StatusBarUsageDisplay,
} from "@/components/layout/status-bar/status-bar-usage-display";
import { StatusBarUsageReadings } from "@/components/layout/status-bar/status-bar-usage-readings";
import { StatusBarUsageScroller } from "@/components/layout/status-bar/status-bar-usage-scroller";
import { useStatusBarResourceMetricViews } from "@/components/layout/status-bar/use-status-bar-resource-views";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useRateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import {
  useStatusBarRateLimitSegments,
  useStatusBarWindowedProviders,
  type StatusBarProviderSegmentModel,
  type StatusBarRateLimitCluster,
  type StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { RateLimitWindowKind } from "@/lib/rate-limits/rate-limit-window-catalog";
import { useSampledNow } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { useLayoutStore } from "@/stores/settings/layout-store";

/**
 * How wide the preview pretends to be. Component state, never persisted: it is
 * a way of LOOKING at the strip, not a preference about it, and a persisted
 * copy would outlive the question it was asked for.
 *
 * Each option is a NOMINAL width, and the frame is drawn at exactly that width
 * whenever the settings pane has room for it. That is what makes the control
 * mean what it says: the strip draws every reading in full at every width and
 * scrolls what does not fit, so what the width changes is how much of the
 * cluster is in view before the fade - and Narrow is the option that shows
 * the fade at all, on a strip that would need it.
 *
 * 480 is a narrow window, 880 a normal one, 920 a wide one. Wide is 920 rather
 * than a number that looks wide, because every Settings surface caps at
 * `max-w-5xl` and leaves the frame ~944px at most: a nominal the pane can
 * never draw would put the resource cluster off the right edge at the DEFAULT
 * width. `wide` is the default, so a reader starts from the most room the
 * strip can have - the readings still scroll there when there are more than
 * fit - except below `md`, where `narrow` is, because a phone's footer is
 * narrower still and should open on the closest picture of ITS strip.
 */
export type StatusBarPreviewWidth = "narrow" | "normal" | "wide";

/** The frame's width per option, as a class the frame wears. */
const PREVIEW_FRAME_CLASS: Record<StatusBarPreviewWidth, string> = {
  narrow: "w-[480px]",
  normal: "w-[880px]",
  wide: "w-[920px]",
};

/**
 * The status bar as the settings on this page draw it, from the watched host's
 * real readings.
 *
 * **It never causes one.** Every usage observer under it is passive (see
 * `useStatusBarRateLimitSegments`'s `mode`), it mounts no cold-start refresh, no
 * refresh control, no popover, no resource stream and no
 * `RateLimitPollProvider` consumer, and it registers no keyboard handler. What
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
 * That also makes it honest rather than idealised: an account with no provider
 * renders the strip's "connect a provider" line, and with no global resource
 * stream mounted the resource segment renders its dashes. A preview that
 * fetched to fill those in would be showing a strip the user does not have.
 *
 * The one place it draws numbers the host has not reported is a cluster with
 * NO reading in it at all, where the providers that have none are COLD - which
 * is the steady state under `header` placement for the http-lane providers
 * nothing but the popover ever fetches. A cold segment is an icon over an
 * empty track and ignores every switch on this page, so a preview of nothing
 * but cold tracks is a preview of nothing. It gives the first two cold
 * providers a fixed SAMPLE reading instead, says so in a caption, and still
 * fetches nothing. An `unavailable` provider is not touched: it has ANSWERED
 * that it cannot report usage, so a percentage over it would be a stronger
 * invention than the cold case and the caption's own sentence would be false
 * for it.
 */
export function StatusBarPreview(props: {
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
}): ReactNode {
  const compact = useSettingsDensity() === "compact";
  const placement = useLayoutStore((state) => state.statusBar.placement);
  const mobileFooter = useLayoutStore((state) => state.statusBar.mobileFooter);
  // Below `md` the shell answers with `mobileFooter` and ignores placement
  // entirely (`AppShell`), because the header keeps both controls at that
  // width whatever placement says - so the frame is a picture of a surface
  // that is only drawn there once the switch is on, and saying so is the same
  // honesty the header-placement caption already owes.
  const narrowViewport = useIsMobileViewport();
  const stripDrawn = narrowViewport ? mobileFooter : placement === "status-bar";
  // `narrow` rather than `wide` below `md`, and only as the STARTING width: a
  // phone's footer is narrower than any option here, so the picture closest
  // to it is the one whose readings scroll. The control still moves freely
  // from there - it is a way of looking at the strip, not a claim about it.
  const [width, setWidth] = useState<StatusBarPreviewWidth>(
    narrowViewport ? "narrow" : "wide",
  );
  const { sentinelRef, stickyRef } = useStuckAttribute();
  const display = useStatusBarUsageDisplay();
  const liveCluster = usePreviewCluster(props.scope.hostId);
  // The same 60s clock the countdowns read, so the sample's reset instants are
  // always the same distance from the `now` they are formatted against and the
  // sample never ticks.
  const now = useSampledNow();
  const sample = statusBarPreviewSample(liveCluster, now);
  const cluster = sample?.cluster ?? liveCluster;
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
          // mounts the strip on. Below it this block is a dimmed picture of
          // a surface the shell does not draw, and it is tall - the
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
              The strip as these settings draw it. Narrow it to see how the
              readings scroll when a window is short of room.
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
        <StatusBarPreviewFrame
          width={width}
          dimmed={!stripDrawn}
          scope={props.scope}
          hasExplicitPick={props.hasExplicitPick}
          cluster={cluster}
          display={display}
        />
        {sample === null ? null : (
          <p
            data-testid="status-bar-preview-sample-note"
            className={cn(NOTE_CLASS, !stripDrawn && "opacity-50")}
          >
            {SAMPLE_READINGS_CAPTION}
          </p>
        )}
        {/*
          Dimmed with the frame whenever the frame is, for the same reason it
          is: they explain a strip that is not the one currently drawn, and
          full-strength explanations under a greyed picture read as the two
          disagreeing about which of them is live.
        */}
        <StatusBarPreviewNotes
          scope={props.scope}
          hasExplicitPick={props.hasExplicitPick}
          liveCluster={liveCluster}
          sampledSegmentKeys={sample?.segmentKeys ?? NO_SAMPLED_SEGMENTS}
          dimmed={!stripDrawn}
        />
        {stripDrawn ? null : (
          <p className="text-ui-sm text-muted-foreground">
            {/* The narrow case gets its own sentence because the other one
              would be a false promise there: flipping placement changes
              nothing at this width, and the switch that does is the one named
              here. */}
            {narrowViewport
              ? "Shown at this window width when Footer status bar is on."
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
 * one surface that is already re-rendering to a 60s clock and a 1 Hz sampler.
 *
 * So the verdict is a DOM WRITE from an observer callback: the sentinel is
 * clipped out of the settings scroll container at the moment the block pins, and
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
 * The frame the preview's strip is drawn in: the SIMULATED VIEWPORT.
 *
 * The option's width is on it, so the border hugs the strip the control
 * named, and `max-w-full` is what keeps that honest. Every Settings surface
 * caps at `max-w-5xl`, so the box this sits in is at most ~944px wide however
 * large the window is - a frame drawn wider than that would push the resource
 * cluster off the right edge with nothing on screen saying so. Capped, the
 * drawn strip is narrower than the nominal width on a small pane and its
 * readings scroll against the room it can actually see.
 *
 * The frame itself is LIVE, not `inert`: the usage cluster inside it scrolls,
 * and a wheel or a swipe over the frame has to reach the scroller, which an
 * inert ancestor would swallow. What is inert is the CONTENT - the readings
 * inside the scroller and the resource control beside it (see
 * `StatusBarPreviewStrip`) - so nothing in the picture can be clicked,
 * focused or hovered into a tooltip, while the picture itself still moves.
 *
 * Exported so a layout check can draw exactly this frame at exactly this
 * width without the preview's host-bound hooks around it.
 */
export function StatusBarPreviewFrame(props: {
  readonly width: StatusBarPreviewWidth;
  /**
   * The strip is not the surface currently drawn - header placement, or a
   * window too narrow for one.
   */
  readonly dimmed: boolean;
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
  readonly cluster: StatusBarRateLimitCluster;
  readonly display: StatusBarUsageDisplay;
}): ReactNode {
  return (
    <div
      data-testid="status-bar-preview-frame"
      data-preview-width={props.width}
      className={cn(
        "max-w-full overflow-hidden rounded-md border border-border/70 bg-canvas text-canvas-foreground",
        PREVIEW_FRAME_CLASS[props.width],
        // Greyed, not hidden: wherever the strip is not the surface currently
        // drawn - header placement, or a window too narrow for it - these
        // settings still describe a real strip, and a preview that vanished
        // would read as the settings having no effect.
        props.dimmed && "opacity-50",
      )}
    >
      {/* The counterpart of the strip's own outer div. */}
      <div data-testid="status-bar-preview">
        <StatusBarPreviewStrip
          scope={props.scope}
          hasExplicitPick={props.hasExplicitPick}
          cluster={props.cluster}
          display={props.display}
        />
      </div>
    </div>
  );
}

/**
 * The strip itself, at the same `h-6` and with the same two clusters, the
 * usage cluster in the same scroller the strip uses - so at the Narrow width
 * the frame shows the fade the strip would show, over the readings the strip
 * would draw, and scrolls them the way the strip would.
 *
 * `aria-hidden` and `inert` sit on the CONTENTS rather than on the strip,
 * because this is a picture of a surface rather than the surface: every
 * control in it is a real one that would be a dead end here, and the rows
 * below are where each of them is actually configured. `inert` takes them out
 * of the tab order and stops the tooltips inside from ever opening -
 * what those tooltips would have said is in the caption below instead, see
 * `StatusBarPreviewNotes` - and `aria-hidden` keeps a screen reader from
 * reading the strip's contents a second time under a control that does
 * nothing. The scroller around the readings stays live so the picture can be
 * scrolled: an inert element is skipped by hit testing, so a wheel or a swipe
 * over the readings lands on the scroller, which is exactly where it should.
 */
function StatusBarPreviewStrip(props: {
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
  readonly cluster: StatusBarRateLimitCluster;
  readonly display: StatusBarUsageDisplay;
}): ReactNode {
  const rateLimitsEnabled = useLayoutStore(
    (state) => state.statusBar.rateLimits.enabled,
  );
  const resourcesEnabled = useLayoutStore(
    (state) => state.statusBar.resources.enabled,
  );
  const { cluster, display } = props;
  return (
    <div className="flex h-6 items-center gap-2 px-2 text-ui-xs tabular-nums">
      {/*
        The row's GROWER, exactly as the strip's usage slot is: the spare room
        has to be absorbed by one box, and it is this one, so the scroller
        inside has the room the strip's scroller would have and no more.
      */}
      <span className="flex min-w-0 flex-1 items-center gap-1">
        {rateLimitsEnabled ? (
          <>
            {/* Its own testid rather than the strip's: Settings can be open
              while the real strip is mounted below it, and one id naming two
              live boxes is a trap for the next test that queries it. */}
            <StatusBarUsageScroller
              hostId={props.scope.hostId}
              cluster={cluster}
              testId="status-bar-preview-usage"
            >
              {/*
                The strip's trigger without the trigger: same box, same
                natural width, so the scroller has the same row to scroll. A
                plain span because a `PopoverTrigger` outside a `Popover`
                throws, and a preview has nothing to open anyway. This is the
                inert boundary: everything from here down is picture.
              */}
              <span
                inert
                aria-hidden
                data-testid="status-bar-preview-readings"
                className="inline-flex h-6 shrink-0 items-center text-muted-foreground"
              >
                <span
                  data-testid="status-bar-preview-content"
                  className={STATUS_BAR_USAGE_CONTENT_CLASS}
                >
                  <StatusBarUsageReadings cluster={cluster} display={display} />
                </span>
              </span>
            </StatusBarUsageScroller>
            {/*
              The refresh control's BOX without the control: the strip's
              scroller has only the room that control leaves, so a preview
              that drew nothing here would give its readings ~24px more than
              the strip has and show no fade at a width where the strip
              already scrolls - at Narrow, which exists to show exactly that.
              Composed the way the strip composes it (`pl-1` gap plus the
              button's `size-5`) rather than as one width, so the two are read
              from the same two numbers. The real `RefreshIconButton` would
              close it too, but it would render disabled here - a passive
              reader has nothing to refresh - which misrepresents a live
              control.
            */}
            <span
              aria-hidden
              data-testid="status-bar-preview-reserved"
              className="flex shrink-0 items-center pl-1"
            >
              <span className="block size-5" />
            </span>
          </>
        ) : null}
      </span>
      {resourcesEnabled ? (
        <StatusBarResourceSegment
          inert
          aria-hidden
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
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
  /** The host's own cluster - the one whose readings need explaining. */
  readonly liveCluster: StatusBarRateLimitCluster;
  /** The segments whose reading in the frame is invented. Usually empty. */
  readonly sampledSegmentKeys: ReadonlyArray<string>;
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
    ? statusBarPreviewUsageNotes({
        liveCluster: props.liveCluster,
        sampledSegmentKeys: props.sampledSegmentKeys,
      })
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
          scope={props.scope}
          hasExplicitPick={props.hasExplicitPick}
          dimmed={props.dimmed}
        />
      ) : null}
    </>
  );
}

/**
 * The usage half of the caption: why a reading is not live, one line per
 * provider whose segment is cold, unavailable or degraded.
 *
 * It explains the HOST's readings, which are still cold or unavailable while
 * the sample stands in for them. A provider the sample spoke for is left out:
 * the caption above already says those readings were never fetched, and
 * `Codex · no reading yet` under a frame showing `57% used` reads as the two
 * disagreeing. A provider the sample did NOT speak for keeps its line - an
 * `unavailable` one is drawing its own dash in there, and that dash is what
 * the line explains.
 *
 * Nothing here about a reading being out of view: every segment is drawn in
 * full, and one past the frame's edge is a scroll away rather than a state
 * to explain.
 */
function statusBarPreviewUsageNotes(input: {
  readonly liveCluster: StatusBarRateLimitCluster;
  readonly sampledSegmentKeys: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  return statusBarClusterSegments(input.liveCluster)
    .filter(
      (segment) =>
        segment.state !== "live" &&
        !input.sampledSegmentKeys.includes(statusBarSegmentKey(segment)),
    )
    .map(statusBarSegmentTooltip);
}

/** One empty list, for the usual case of a preview drawing real readings. */
const NO_SAMPLED_SEGMENTS: ReadonlyArray<string> = [];

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
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
  readonly dimmed: boolean;
}): ReactNode {
  const views = useStatusBarResourceMetricViews({
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
 * that explains them have to describe one cluster, and the sample that may
 * stand in for it is decided once, above both.
 */
function usePreviewCluster(hostId: string | null): StatusBarRateLimitCluster {
  const providers = useStatusBarWindowedProviders();
  const profileSelection = useRateLimitProfileSelection(hostId);
  const { cluster } = useStatusBarRateLimitSegments({
    providers,
    profileSelection,
    mode: "passive",
  });
  return cluster;
}

const SAMPLE_READINGS_CAPTION =
  "Sample readings — no usage has been fetched for these providers yet. Open the usage panel or switch placement to Status bar for live numbers.";

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
    usedPercent: 57,
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
function statusBarPreviewSample(
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
