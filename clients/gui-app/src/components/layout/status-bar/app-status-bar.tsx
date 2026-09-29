import {
  Fragment,
  use,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { GhostRegion } from "@/components/layout-editor/ghost-region";
import { LayoutRegionContextMenu } from "@/components/layout-editor/region-quick-verbs";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { useScopedStreamBinding } from "@/components/settings/host-scope/use-scoped-stream-binding";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  RateLimitPopover,
  RateLimitPopoverRoot,
} from "@/components/layout/header/rate-limit-popover";
import { ResourceMonitorPopover } from "@/components/resources/resource-monitor-popover";
import { StatusBarRateLimitCluster } from "@/components/layout/status-bar/status-bar-rate-limit-cluster";
import { StatusBarResourceSegment } from "@/components/layout/status-bar/status-bar-resource-segment";
import {
  STATUS_BAR_MENU_EXEMPT_ATTRIBUTE,
  StatusBarVisibilityMenu,
  type StatusBarMenuProvider,
} from "@/components/layout/status-bar/status-bar-visibility-menu";
import { useWatchHostScope } from "@/hooks/host-scope/use-watch-host-scope";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import {
  useRateLimitProfileSelection,
  type RateLimitProfileSelection,
} from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { useStatusBarWindowedProviders } from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { HostRuntimeContext, useHostBinding } from "@/lib/host";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { providerDisplayName } from "@/lib/provider-ordering";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import { useBarPlacements, useRegionShown } from "@/lib/layout-overrides";
import {
  barClusterRegionsAt,
  type BarPlacement,
  type BarRegionId,
  type EdgeSide,
} from "@/lib/layout/layout-arrangement";

/** Stable identity, so a strip with no list to offer never re-renders on one. */
const NO_MENU_PROVIDERS: ReadonlyArray<StatusBarMenuProvider> = [];

/**
 * The app's bottom strip: two clusters, one at each end, holding whichever of
 * the usage cluster and the resource readout named this bar and that side
 * (L-156). It ships with usage on the left and the readout on the right, and
 * it is on screen for as long as either of the two is still here.
 *
 * It carries no host control of its own. Both panels it opens already end their
 * list in a `HostSwitcher` over this same watch pick, so a third one in the
 * strip would be a third way to write one value — and the strip is the one
 * surface with no room to say what picking does.
 *
 * The watch host is resolved ONCE, here, above every segment — and re-provided
 * as this subtree's `HostRuntimeContext` and `StreamRuntimeContext`. That pair
 * of swaps is what re-targets the whole strip: the unary context moves the RPC
 * reads and their query keys, the streaming one moves `resources.subscribe`.
 * Swapping only the first is how a surface ends up reading host B's RPCs beside
 * host A's live stream, which is why both are here rather than one being left
 * to whichever segment happens to need it.
 *
 * Both providers are rendered unconditionally, and that is load-bearing rather
 * than tidiness — the same reason `RateLimitIconButton` states. Mounting one
 * only when a scoped binding exists changes the element type at this position
 * the moment a pick resolves, so React unmounts the whole subtree and mounts a
 * fresh one, taking the open state of anything inside it (the usage panel, the
 * resource panel) with it. The fallback re-provides the ambient binding
 * VERBATIM, never a copy, so an unscoped strip still sees ambient updates.
 */
export function AppStatusBar(): ReactNode {
  const { scope, hasExplicitPick } = useWatchHostScope();
  const scopedBinding = useScopedHostBinding(scope);
  const ambientBinding = useHostBinding();
  const scopedStreamBinding = useScopedStreamBinding(scope);
  const ambientStreamBinding = use(StreamRuntimeContext);
  return (
    <HostRuntimeContext.Provider value={scopedBinding ?? ambientBinding}>
      <StreamRuntimeContext.Provider
        value={scopedStreamBinding ?? ambientStreamBinding}
      >
        <ScopedAppStatusBar scope={scope} hasExplicitPick={hasExplicitPick} />
      </StreamRuntimeContext.Provider>
    </HostRuntimeContext.Provider>
  );
}

function ScopedAppStatusBar(props: {
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
}): ReactNode {
  // Read for the chord ownership below, not for how the strip is drawn: a
  // phone's footer draws the same readings as a desktop strip and scrolls
  // them under a finger, so the viewport decides who holds a shortcut and
  // nothing about what is on screen.
  const narrowViewport = useIsMobileViewport();
  const rateLimitsEnabled = useRegionShown("usageLimits");
  const resourcesEnabled = useRegionShown("resourceMonitor");
  const editing = useLayoutEditorStore((state) => state.session !== null);
  // Where both readings say they are: this strip draws the ones that named IT,
  // which is why moving usage limits up no longer takes the monitor with it
  // (L-156).
  const placements = useBarPlacements();
  // Except on a narrow viewport, where the footer draws BOTH whatever they
  // name (L-51, L-162). There is one bar on a phone and the mobile header
  // keeps its own copies, so a footer that honoured a header pick would drop
  // a readout with nowhere to put it. The picks themselves are untouched, so
  // the desktop window they were made in still honours them - and the ENDS
  // still do, here, because a side is a fact about the bar the reading is
  // drawn in.
  const drawn: Readonly<Record<BarRegionId, BarPlacement>> = narrowViewport
    ? {
        usageLimits: { host: "status-bar", side: placements.usageLimits.side },
        resourceMonitor: {
          host: "status-bar",
          side: placements.resourceMonitor.side,
        },
      }
    : placements;
  const usageInStrip = drawn.usageLimits.host === "status-bar";
  const stripRegions: ReadonlyArray<BarRegionId> = [
    ...barClusterRegionsAt(drawn, "status-bar", "left"),
    ...barClusterRegionsAt(drawn, "status-bar", "right"),
  ];
  // Resolved here rather than in the cluster because it has two readers on
  // opposite sides of the gate below: the segments, and the right-click menu
  // that wraps the whole strip. One resolution is what keeps the menu's list
  // and the segments beside it from ever naming different providers.
  //
  // It is also the one rate-limit hook mounted outside that gate, which is safe
  // for exactly one reason: it cannot fetch a reading. Its usage observers are
  // `enabled: false` and the `providers.list` read under them is the same one
  // the app-shell poll already keeps subscribed. Everything that CAN pull -
  // the usage batches, the mount refresh - lives inside the gate, where the
  // binding is provably the watched host's.
  const windowedProviders = useStatusBarWindowedProviders();
  const usageAnchorRef = useRef<HTMLSpanElement>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  // One subscription bridge for the segments and the panel alike, resolved
  // where both can reach it - the same shape the header trigger uses - and
  // keyed by the WATCHED host, since the accounts it names are that host's.
  const profileSelection = useRateLimitProfileSelection(props.scope.hostId);
  // `app.rate-limits.open` has one handler slot and two possible owners, and
  // on desktop they are mutually exclusive by placement: `RateLimitIconButton`
  // owns it in the header and is not mounted while the usage controls live
  // down here.
  //
  // A mobile viewport is the one shell where BOTH are on screen - the mobile
  // header keeps its gauge whatever the footer does - so the strip stands
  // down and leaves the slot to the header. It is not a coin toss: the slot
  // holds ONE handler and an unregister only clears its own, so the later
  // registrant would silently displace the header's and then, on unmounting
  // for the keyboard or the drawer, take the chord away entirely - the header
  // button still on screen would have no handler and no way to get one back,
  // since its effect does not re-run. Nothing is lost by standing down: the
  // cluster's own `PopoverTrigger` is a tap away, and the two panels are the
  // same panel.
  //
  // It also stands down while the usage cluster is drawing in the HEADER
  // (L-156): the strip can now be on screen for the resource monitor alone,
  // and the panel this slot would open has no anchor here at all.
  useEffect(() => {
    if (narrowViewport || !usageInStrip) return;
    return registerDynamicActionHandler("app.rate-limits.open", () => {
      setUsageOpen(true);
    });
  }, [narrowViewport, usageInStrip]);
  // `app.resources.open` has one handler slot, and on a desktop viewport the
  // two possible owners are exclusive by placement: the monitor draws HERE or
  // in the header (L-156), never both. A narrow viewport is the one shell
  // where both are on screen - this footer draws the readout whatever it
  // names (L-162) and the mobile header keeps its own - so the strip stands
  // down there and leaves the slot to the header, which survives the
  // keyboard. With the monitor hidden nothing below mounts, so nobody
  // registers, which is correct: there is no panel to open.
  const claimsResourcesAction = !narrowViewport;
  // While the panel is open, let the header drop its title-bar drag regions so
  // a click on the (otherwise event-swallowing) drag area dismisses it. The id
  // is the header trigger's own: the two are mutually exclusive by placement
  // wherever a title bar exists at all, so they can never both be claiming it.
  //
  // The panel's open state reconciled with the cluster's placement, in the
  // render AND in the state.
  //
  // The anchor and the content both unmount with the cluster, so the popover never
  // fires `onOpenChange` on the way out: without this, `usageOpen` stays true
  // for the life of the strip, `useTitleBarDragSuppression` below holds the
  // header's own slot under a value nothing can clear, and a reading that
  // comes back down reopens a panel nobody asked for. The derived value is
  // what the render reads, so there is never a frame with an open panel and
  // no anchor; the reset below is what forgets the request, because a request
  // for a panel in this bar does not survive the cluster leaving it. Adjusted
  // during render rather than from an effect: the condition is already false
  // by the time this render commits, so there is no cascading second pass.
  const usagePanelOpen = usageOpen && usageInStrip;
  if (usageOpen && !usageInStrip) setUsageOpen(false);
  useTitleBarDragSuppression("rate-limits", usagePanelOpen);
  const scope = props.scope;
  // A PICK that has not resolved to its own client leaves this subtree on the
  // AMBIENT binding, so mounting the live segments would draw one host's
  // numbers under the name of the host the user picked - and keeping the hooks
  // out of the tree, rather than discarding their output, also stops them
  // opening a stream against the host the user did not choose.
  //
  // Without a pick there is no second host to confuse this one with: the
  // ambient binding is the only thing the strip has ever meant, and an
  // `unreachable` active host is the routine blip the resource stream rides
  // out. Blanking it there would be a regression paid by every single-host
  // user for a picker they never opened.
  const scopedToOwnHost =
    !props.hasExplicitPick || isHostScopeUsable(scope.status);

  // Hidden and pointed at: the passive depiction in place, never the live
  // segment - which opens a stream (L-14, L-62).
  const resources = !resourcesEnabled ? (
    <GhostRegion regionId="resourceMonitor" />
  ) : (
    // The segment's own quick verbs (L-144). It is the resource popover's
    // trigger, so it carries the exemption that makes the strip's own menu
    // stand down over it - and that menu names `usageLimits`, which is the
    // segment BESIDE this one. Without a menu of its own the readout was the
    // one piece of the strip that answered no right-click.
    //
    // Around the popover rather than inside its `triggerNode`: the popover
    // hands that node straight to `PopoverTrigger render`, and a popup root
    // in that slot would swallow the trigger's props instead of forwarding
    // them to the button, taking the left click with it. Wrapping out here
    // leaves the trigger seam untouched and gives the context menu the
    // `display: contents` span it hangs its own handlers on.
    <LayoutRegionContextMenu regionId="resourceMonitor">
      <ResourceMonitorPopover
        trigger="custom"
        contentSide="top"
        claimsOpenAction={claimsResourcesAction}
        triggerNode={
          <StatusBarResourceSegment
            {...{ [STATUS_BAR_MENU_EXEMPT_ATTRIBUTE]: "" }}
            hostId={scope.hostId}
            hostLabel={scope.hostLabel}
            hasExplicitPick={props.hasExplicitPick}
            interactive
          />
        }
      />
    </LayoutRegionContextMenu>
  );

  // The usage cluster, anchored where it draws. The anchor is the SLOT rather
  // than a trigger for the same reason it always was - there is not always a
  // trigger - and it travels with the cluster, so the panel opens at the end
  // of the strip the cluster is actually on (L-156).
  const usage = (
    // Reserved even when it holds nothing, so nothing beside it shifts into
    // place when the segments land - or when the preference that hides them
    // is flipped. The notice for an unresolved pick takes the same slot.
    <span
      ref={usageAnchorRef}
      data-testid="status-bar-rate-limit-slot"
      className="flex min-w-0 items-center gap-1"
    >
      <StatusBarUsageSlot
        scopedToOwnHost={scopedToOwnHost}
        rateLimitsEnabled={rateLimitsEnabled}
        providers={windowedProviders}
        profileSelection={profileSelection}
        scope={scope}
        editing={editing}
      />
      {/* Hidden and pointed at: the passive depiction takes the slot the
          segments left empty (L-14, L-62). */}
      {rateLimitsEnabled ? null : <GhostRegion regionId="usageLimits" />}
    </span>
  );

  /**
   * One end of the strip: the readings that named this bar and this side, in
   * the order `barClusterRegionsAt` puts them in - usage limits first where
   * both sit together (L-156).
   */
  const cluster = (side: EdgeSide): ReactNode =>
    barClusterRegionsAt(drawn, "status-bar", side).map((region) => (
      <Fragment key={region}>
        {region === "usageLimits" ? usage : resources}
      </Fragment>
    ));

  return (
    // The menu wraps the strip's ROOT, so a right-click anywhere on it lands -
    // including the padding under the row. The controls that own their own
    // pointer behaviour opt out of it individually rather than the menu
    // guessing at their bounds.
    <StatusBarVisibilityMenu
      // What this strip is actually holding, in the order it draws them: the
      // menu names those and nothing else (L-159). It used to name the usage
      // region by literal and offer the monitor's switch unconditionally,
      // which since L-156 could govern a reading drawn in the top bar.
      regions={stripRegions}
      providers={
        // Only what this strip can actually show, on both counts. An unresolved
        // pick leaves the subtree on the ambient binding, whose providers belong
        // to a host the strip is not watching - so the menu offers nothing
        // rather than a list borrowed from the wrong machine. And with usage
        // switched off entirely - or drawn in the header, where its own menu
        // serves it - there is no segment here for a per-provider checkbox to
        // govern: it would toggle a preference with no visible effect and no
        // item beside it explaining why. Settings, one item down, is where that
        // switch lives.
        scopedToOwnHost && rateLimitsEnabled && usageInStrip
          ? menuProviders(windowedProviders)
          : NO_MENU_PROVIDERS
      }
    >
      {/*
        Two boxes, not one. The row is exactly `h-6`; the bottom inset is
        ADDITIONAL space under it. Putting `pb-safe-bottom` on an `h-6` box
        would make the padding eat the row instead of extending past it, since
        `h-6` fixes the total height. `#root` reserves the top and both sides
        app-wide and deliberately not the bottom, so this strip owns that edge.
      */}
      <div
        data-testid="app-status-bar"
        className="shrink-0 border-t border-border/90 bg-canvas pb-safe-bottom text-canvas-foreground"
      >
        {/*
          The panel and its chord live HERE, above everything that can hide the
          segments, because the panel stays meaningful in every state the
          segments do not survive: it carries its own host notice and its own
          way back. A handler owned by the cluster would go missing exactly
          when a user reaches for it - with usage switched off in Settings, or
          with a pick that cannot be reached.
        */}
        {/* Keyed on the cluster's bar: the panel's content unmounts with the
            cluster while this root stays, and a Base root closed with no
            content left waits on an exit that never finishes. A fresh root
            when the cluster comes back mounts closed outright. */}
        <RateLimitPopoverRoot
          key={usageInStrip ? "usage-in-strip" : "usage-elsewhere"}
          open={usagePanelOpen}
          onOpenChange={setUsageOpen}
        >
          <div className="flex h-6 items-center gap-2 px-2 text-ui-xs tabular-nums">
            {cluster("left")}
            {/*
              The row's one GROWER: the spare room has to be absorbed by
              exactly one box, and a box of its own is the one answer that
              works for all four placements - it holds each cluster against
              its own edge, and it is the first thing to give when the
              readings need the room, so the usage scroller inside gets
              exactly what the readout beside it leaves and never pushes it
              off the edge.
            */}
            <span className="flex-1" />
            {cluster("right")}
          </div>
          {/* Not while the cluster is in the header: the panel is the same
            panel, and the button up there mounts its own. Two of them is two
            subscriptions and two owners for one chord. */}
          {usageInStrip ? (
            <RateLimitPopover
              anchor={usageAnchorRef}
              side="top"
              align={drawn.usageLimits.side === "left" ? "start" : "end"}
              onClose={() => setUsageOpen(false)}
              profileSelection={profileSelection}
              scope={scope}
              hasExplicitPick={props.hasExplicitPick}
            />
          ) : null}
        </RateLimitPopoverRoot>
      </div>
    </StatusBarVisibilityMenu>
  );
}

/**
 * What the reserved slot is holding, in the order the three answers rule each
 * other out: a strip that may not read its host says so and shows nothing else;
 * a strip whose usage is switched off shows nothing at all (the slot keeps its
 * place, and the panel it anchors is still one chord away); otherwise, the
 * segments.
 */
function StatusBarUsageSlot(props: {
  readonly scopedToOwnHost: boolean;
  readonly rateLimitsEnabled: boolean;
  readonly providers: ReadonlyArray<ConfiguredRateLimitProvider>;
  readonly profileSelection: RateLimitProfileSelection;
  readonly scope: HostScope;
  readonly editing: boolean;
}): ReactNode {
  return (
    <>
      {!props.scopedToOwnHost ? (
        <StatusBarHostNotice scope={props.scope} />
      ) : null}
      {props.scopedToOwnHost && props.rateLimitsEnabled ? (
        <StatusBarRateLimitCluster
          hostId={props.scope.hostId}
          providers={props.providers}
          profileSelection={props.profileSelection}
          editing={props.editing}
        />
      ) : null}
    </>
  );
}

/**
 * The menu names providers; the segments read them. Same list, one order, so a
 * provider can never be togglable in one and absent from the other.
 */
function menuProviders(
  providers: ReadonlyArray<ConfiguredRateLimitProvider>,
): ReadonlyArray<StatusBarMenuProvider> {
  return providers.map((provider) => ({
    providerId: provider.providerId,
    label: providerDisplayName(provider.providerId),
  }));
}

/**
 * Why the strip is showing no numbers rather than showing the ACTIVE host's
 * numbers under the picked host's name.
 *
 * Same three states and same remedies as the popovers' notice, at one line:
 * `vanished` needs the pick dropped, `unreachable` needs the machine back, and
 * `connecting` needs a moment — which is why it alone offers no button. A
 * strip is not the place to explain a plan restriction or a host version, so
 * those keep landing in the popover, where there is room for the sentence.
 *
 * It is passive chrome for the layout editor (4.2): it takes the slot the
 * usage segments would occupy and is not a region of its own.
 */
function StatusBarHostNotice(props: { readonly scope: HostScope }): ReactNode {
  const scope = props.scope;
  if (scope.status === "connecting") {
    return (
      <span
        data-layout-passive
        className="truncate text-muted-foreground"
        data-testid="status-bar-host-connecting"
      >
        Finding {scope.hostLabel}…
      </span>
    );
  }
  return (
    <span
      role="status"
      data-layout-passive
      className="flex min-w-0 items-center gap-2"
      data-testid="status-bar-host-unavailable"
    >
      <span className="truncate text-muted-foreground">
        {scope.status === "vanished"
          ? `${scope.hostLabel} is no longer connected`
          : `Can't reach ${scope.hostLabel}`}
      </span>
      <button
        type="button"
        onClick={scope.returnToActive}
        // The one way out of this state, so the strip's own menu stands down
        // over it and leaves the platform's alone - the same exemption the two
        // panel triggers carry.
        {...{ [STATUS_BAR_MENU_EXEMPT_ATTRIBUTE]: "" }}
        className="shrink-0 rounded-md px-1 text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        data-testid="status-bar-host-return-to-active"
      >
        Show the active host
      </button>
    </span>
  );
}
