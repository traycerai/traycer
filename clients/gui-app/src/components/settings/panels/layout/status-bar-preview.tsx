import { useCallback, useRef, useState, type ReactNode } from "react";
import { classifyProviderRateLimitWindow } from "@traycer/protocol/host/rate-limit";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { SettingsSegmentedControl } from "@/components/settings/controls/settings-segmented-control";
import {
  statusBarDensityForWidth,
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
  type StatusBarProviderSegmentModel,
  type StatusBarRateLimitCluster,
  type StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
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
 * mean what it says. Density (`statusBarDensityForWidth`) is read from the
 * nominal width, never from the frame's measured box: inside the Settings
 * modal that box is `min(pane, 1024) − chrome`, which is `compact` on any
 * window under ~1560px, and at the `compact` ceiling the ladder drops the mode
 * word, the mini bar and the countdown whatever the store says. A preview
 * measuring itself there answered "these switches do nothing" to the first
 * three switches a user tries - in the modal only, since the promoted tab has
 * less padding and reached `full`.
 *
 * The three widths sit inside the strip's three density bands (`< 500`
 * icon-only, `< 900` compact, else full): 480 is a narrow window, 880 a normal
 * one just short of `full`, 920 a wide one. Wide is 920 rather than a number
 * that looks wide, because every Settings surface caps at `max-w-5xl` and
 * leaves the frame ~944px at most: a nominal the pane can never draw would put
 * the resource cluster off the right edge at the DEFAULT width, which is the
 * reported bug moved one cluster over. `wide` is the default, so the first
 * thing a reader sees is every switch doing something.
 */
export type StatusBarPreviewWidth = "narrow" | "normal" | "wide";

interface StatusBarPreviewWidthOption {
  /** The width the strip is drawn at, and the one its density is read from. */
  readonly widthPx: number;
  /** `widthPx` as the frame's class. A pair, so the two cannot drift. */
  readonly frameClass: string;
}

const PREVIEW_WIDTHS: Record<
  StatusBarPreviewWidth,
  StatusBarPreviewWidthOption
> = {
  narrow: { widthPx: 480, frameClass: "w-[480px]" },
  normal: { widthPx: 880, frameClass: "w-[880px]" },
  wide: { widthPx: 920, frameClass: "w-[920px]" },
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
  const widthOption = PREVIEW_WIDTHS[width];
  const density = statusBarDensityForWidth(widthOption.widthPx);
  const display = useStatusBarUsageDisplay();
  const liveCluster = usePreviewCluster();
  // The same 60s clock the countdowns read, so the sample's reset instants are
  // always the same distance from the `now` they are formatted against and the
  // sample never ticks.
  const now = useSampledNow();
  const sample = statusBarPreviewSample(liveCluster, now);
  const cluster = sample?.cluster ?? liveCluster;
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

          The frame is the SIMULATED VIEWPORT, so the option's width is on it:
          the border hugs the strip the control named, and `max-w-full` is what
          keeps that honest. Every Settings surface caps at `max-w-5xl`, so the
          box this sits in is at most ~944px wide however large the window is -
          a frame drawn wider than that would push the resource cluster off the
          right edge with nothing on screen saying so, which is the reported
          bug again one cluster to the right. Capped, the drawn strip is
          narrower than the nominal width on a small pane and the ladder folds
          against the room it can actually see.
        */}
        <div
          inert
          aria-hidden
          data-testid="status-bar-preview-frame"
          data-preview-width={width}
          data-preview-density={density}
          className={cn(
            "max-w-full overflow-hidden rounded-md border border-border/70 bg-canvas text-canvas-foreground",
            widthOption.frameClass,
            // Greyed, not hidden: wherever the strip is not the surface currently
            // drawn - header placement, or a window too narrow for it - these
            // settings still describe a real strip, and a preview that vanished
            // would read as the settings having no effect.
            !stripDrawn && "opacity-50",
          )}
        >
          {/*
            The counterpart of the strip's own outer div, and no longer a
            measured one: density is a fact about the width the control named,
            and what the ladder measures is the usage slot inside this box.
          */}
          <div data-testid="status-bar-preview">
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
          density={density}
          scope={props.scope}
          hasExplicitPick={props.hasExplicitPick}
          liveCluster={liveCluster}
          drawnCluster={cluster}
          sampledProviderIds={sample?.providerIds ?? NO_SAMPLED_PROVIDERS}
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
 * Its density arrives as a prop, read from the width the control named; what
 * the ladder measures is the usage slot inside THIS box, so it answers the
 * same question it answers in the real strip - "does what I am holding fit the
 * room I have" - against the room a strip that wide would actually have.
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
  /** The host's own cluster - the one whose readings need explaining. */
  readonly liveCluster: StatusBarRateLimitCluster;
  /** The cluster in the frame, which the sample may have stood in for. */
  readonly drawnCluster: StatusBarRateLimitCluster;
  /** The providers whose reading in the frame is invented. Usually empty. */
  readonly sampledProviderIds: ReadonlyArray<RateLimitProviderId>;
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
    ? statusBarPreviewUsageNotes({
        liveCluster: props.liveCluster,
        drawnCluster: props.drawnCluster,
        sampledProviderIds: props.sampledProviderIds,
        stop: props.stop,
        display: props.display,
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
 *
 * Two clusters because they can differ: the first half explains the HOST's
 * readings, which are still cold or unavailable while the sample stands in for
 * them, and the fold is a property of whatever the frame is actually drawing.
 *
 * A provider the sample spoke for is left out of the first half: the caption
 * above already says those readings were never fetched, and `Codex · no
 * reading yet` under a frame showing `57% used` reads as the two disagreeing.
 * A provider the sample did NOT speak for keeps its line - an `unavailable`
 * one is drawing its own dash in there, and that dash is what the line
 * explains.
 */
function statusBarPreviewUsageNotes(input: {
  readonly liveCluster: StatusBarRateLimitCluster;
  readonly drawnCluster: StatusBarRateLimitCluster;
  readonly sampledProviderIds: ReadonlyArray<RateLimitProviderId>;
  readonly stop: StatusBarUsageStop;
  readonly display: StatusBarUsageDisplay;
}): ReadonlyArray<string> {
  const notes = statusBarClusterSegments(input.liveCluster)
    .filter(
      (segment) =>
        segment.state !== "live" &&
        !input.sampledProviderIds.includes(segment.providerId),
    )
    .map(statusBarSegmentTooltip);
  if (input.stop.foldedCount === 0) return notes;
  const drawn = statusBarClusterSegments(input.drawnCluster);
  const folded = drawn.slice(drawn.length - input.stop.foldedCount);
  const readings = folded.map((segment) =>
    providerReadingText(segment, input.display.percentMode),
  );
  // Marked when one of the numbers in it is invented, since this line is the
  // one place a folded reading appears and the caption above it names
  // providers the fold has just taken off the strip.
  const sampled = folded.some((segment) =>
    input.sampledProviderIds.includes(segment.providerId),
  );
  return [
    ...notes,
    `Folded: ${readings.join(", ")}${sampled ? " (sample)" : ""}`,
  ];
}

/** One empty list, for the usual case of a preview drawing real readings. */
const NO_SAMPLED_PROVIDERS: ReadonlyArray<RateLimitProviderId> = [];

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
  readonly providerIds: ReadonlyArray<RateLimitProviderId>;
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
 * count, the icon set, each provider's own switches and the `+N` fold's
 * arithmetic are the ones the strip would have. `SAMPLE_READINGS` runs out
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
  // Resolved as a list first, then applied: one segment per provider, so the
  // position of a provider in this list is also which reading it gets, and the
  // notes below need the same list to know whose line the caption now covers.
  const providerIds = cluster.segments
    .filter((segment) => segment.state === "cold")
    .slice(0, SAMPLE_READINGS.length)
    .map((segment) => segment.providerId);
  const segments = cluster.segments.map((segment) => {
    const index = providerIds.indexOf(segment.providerId);
    return index === -1
      ? segment
      : sampleSegment(segment.providerId, SAMPLE_READINGS[index], now);
  });
  return { cluster: { kind: "segments", segments }, providerIds };
}

function sampleSegment(
  providerId: RateLimitProviderId,
  reading: StatusBarPreviewSampleReading,
  now: number,
): StatusBarProviderSegmentModel {
  const resetsAt = now + reading.resetsInMs;
  const window: StatusBarRateLimitWindow = {
    windowKey: `${providerId}:sample`,
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
    providerId,
    state: "live",
    reason: null,
    windows: [window],
    tightest: window,
  };
}
