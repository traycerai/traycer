import { use, useEffect, useRef, useState, type ReactNode } from "react";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import {
  HostSwitcher,
  type HostSwitcherAction,
} from "@/components/settings/host-scope/host-switcher";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { useScopedStreamBinding } from "@/components/settings/host-scope/use-scoped-stream-binding";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { RateLimitPopover } from "@/components/layout/header/rate-limit-popover";
import { ResourceMonitorPopover } from "@/components/resources/resource-monitor-popover";
import {
  useStatusBarDensity,
  type StatusBarDensity,
} from "@/components/layout/status-bar/status-bar-density";
import { StatusBarRateLimitCluster } from "@/components/layout/status-bar/status-bar-rate-limit-cluster";
import { StatusBarResourceSegment } from "@/components/layout/status-bar/status-bar-resource-segment";
import {
  STATUS_BAR_MENU_EXEMPT_ATTRIBUTE,
  StatusBarVisibilityMenu,
  type StatusBarMenuProvider,
} from "@/components/layout/status-bar/status-bar-visibility-menu";
import { useWatchHostScope } from "@/hooks/host-scope/use-watch-host-scope";
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
import { useLayoutStore } from "@/stores/settings/layout-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/** Stable identity, so a strip with no list to offer never re-renders on one. */
const NO_MENU_PROVIDERS: ReadonlyArray<StatusBarMenuProvider> = [];

/**
 * The app's bottom strip: provider usage on the left, the watched host and its
 * resource readout on the right.
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
 * fresh one, taking the open state of anything inside it (the host list, the
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
  const barRef = useRef<HTMLDivElement | null>(null);
  const density = useStatusBarDensity(barRef);
  const rateLimitsEnabled = useLayoutStore(
    (state) => state.statusBar.rateLimits.enabled,
  );
  const resourcesEnabled = useLayoutStore(
    (state) => state.statusBar.resources.enabled,
  );
  // Resolved here rather than in the cluster because it has two readers on
  // opposite sides of the gate below: the segments, and the right-click menu
  // that wraps the whole strip. One resolution is what keeps the menu's list
  // and the segments beside it from ever naming different providers.
  //
  // It is also the one rate-limit hook mounted outside that gate, which is safe
  // for exactly one reason: it cannot fetch a reading. Its usage observers are
  // `enabled: false` and the `providers.list` read under them is the same one
  // the app-shell queue already keeps subscribed. Everything that CAN pull -
  // the usage batches, the queued mount refresh - lives inside the gate, where
  // the binding is provably the watched host's.
  const windowedProviders = useStatusBarWindowedProviders();
  const [usageOpen, setUsageOpen] = useState(false);
  // One subscription bridge for the segments and the panel alike, resolved
  // where both can reach it - the same shape the header trigger uses.
  const profileSelection = useRateLimitProfileSelection();
  // `app.rate-limits.open` has one handler slot and two possible owners, and
  // they are mutually exclusive by placement: `RateLimitIconButton` owns it in
  // the header and is not mounted while the usage controls live down here.
  useEffect(
    () =>
      registerDynamicActionHandler("app.rate-limits.open", () => {
        setUsageOpen(true);
      }),
    [],
  );
  // While the panel is open, let the header drop its title-bar drag regions so
  // a click on the (otherwise event-swallowing) drag area dismisses it. The id
  // is the header trigger's own: the two are mutually exclusive by placement,
  // so they can never both be claiming it.
  useTitleBarDragSuppression("rate-limits", usageOpen);
  const scope = props.scope;
  // A PICK that has not resolved to its own client leaves this subtree on the
  // AMBIENT binding, so mounting the live segments would draw one host's
  // numbers beside a chip naming another - and keeping the hooks out of the
  // tree, rather than discarding their output, also stops them opening a
  // stream against the host the user did not choose.
  //
  // Without a pick there is no second host to confuse this one with: the
  // ambient binding is the only thing the strip has ever meant, and an
  // `unreachable` active host is the routine blip the resource stream rides
  // out. Blanking it there would be a regression paid by every single-host
  // user for a picker they never opened.
  const scopedToOwnHost =
    !props.hasExplicitPick || isHostScopeUsable(scope.status);

  return (
    // The menu wraps the strip's ROOT, so a right-click anywhere on it lands -
    // including the padding under the row. The controls that own their own
    // pointer behaviour opt out of it individually rather than the menu
    // guessing at their bounds.
    <StatusBarVisibilityMenu
      providers={
        // Only what this strip can actually show, on both counts. An unresolved
        // pick leaves the subtree on the ambient binding, whose providers belong
        // to a host the chip is not naming - so the menu offers nothing rather
        // than a list borrowed from the wrong machine. And with usage switched
        // off entirely there is no segment for a per-provider checkbox to
        // govern: it would toggle a preference with no visible effect and no
        // item beside it explaining why. Settings, one item down, is where that
        // switch lives.
        scopedToOwnHost && rateLimitsEnabled
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
        ref={barRef}
        data-testid="app-status-bar"
        className="shrink-0 border-t border-border/90 bg-canvas pb-safe-bottom text-canvas-foreground"
      >
        <div className="flex h-6 items-center gap-2 px-2 text-ui-xs tabular-nums">
          {/*
            The panel and its chord live HERE, above everything that can hide
            the segments, because the panel stays meaningful in every state the
            segments do not survive: it carries its own host notice and its own
            way back. A handler owned by the cluster would go missing exactly
            when a user reaches for it - with usage switched off in Settings, or
            with a pick that cannot be reached - which is the argument the
            placement toggle's own bridge already makes for itself.

            The anchor is the slot rather than the trigger for the same reason:
            there is not always a trigger, and the panel still has to open at
            the left end of the strip.
          */}
          <Popover open={usageOpen} onOpenChange={setUsageOpen}>
            <PopoverAnchor asChild>
              {/*
                Reserved even when it holds nothing, so the right-hand cluster
                does not shift into place when the segments land - or when the
                preference that hides them is flipped. The notice for an
                unresolved pick takes the same slot.
              */}
              <span
                data-testid="status-bar-rate-limit-slot"
                className="flex min-w-0 items-center gap-1"
              >
                <StatusBarUsageSlot
                  scopedToOwnHost={scopedToOwnHost}
                  rateLimitsEnabled={rateLimitsEnabled}
                  providers={windowedProviders}
                  density={density}
                  profileSelection={profileSelection}
                  scope={scope}
                />
              </span>
            </PopoverAnchor>
            <RateLimitPopover
              side="top"
              align="start"
              onClose={() => setUsageOpen(false)}
              profileSelection={profileSelection}
              scope={scope}
              hasExplicitPick={props.hasExplicitPick}
            />
          </Popover>
          <span className="flex-1" />
          {/*
            The chip is a bare `HostSwitcher` with no pass-through for a
            `data-*`, and it owns a list of its own that a menu over it would
            swallow - so the exemption goes on a wrapper around it.
          */}
          <span
            {...{ [STATUS_BAR_MENU_EXEMPT_ATTRIBUTE]: "" }}
            className="flex min-w-0 items-center"
          >
            <StatusBarHostChip scope={scope} />
          </span>
          {/*
            Gated on the PREFERENCE only, never on the pick - the mirror of the
            usage panel above, and for the same reason. This component is the
            sole registrant of `app.resources.open` and the only thing that
            renders the resource panel's own "can't reach this host" notice, so
            unmounting it under an unresolved pick would take the chord and the
            explanation away exactly when they are wanted, and would lose a
            behaviour the header placement keeps.
            Nothing leaks by staying mounted: the panel opens its stream only
            when the binding is genuinely the picked host's, and the segment
            runs the window's projection through the same attribution check
            before printing a number, so an unresolved pick reads as dashes
            rather than as the ambient host's figures.
          */}
          {resourcesEnabled ? (
            <ResourceMonitorPopover
              trigger="custom"
              contentSide="top"
              triggerNode={
                <StatusBarResourceSegment
                  {...{ [STATUS_BAR_MENU_EXEMPT_ATTRIBUTE]: "" }}
                  density={density}
                  hostId={scope.hostId}
                  hostLabel={scope.hostLabel}
                  hasExplicitPick={props.hasExplicitPick}
                />
              }
            />
          ) : null}
        </div>
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
  readonly density: StatusBarDensity;
  readonly profileSelection: RateLimitProfileSelection;
  readonly scope: HostScope;
}): ReactNode {
  if (!props.scopedToOwnHost)
    return <StatusBarHostNotice scope={props.scope} />;
  if (!props.rateLimitsEnabled) return null;
  return (
    <StatusBarRateLimitCluster
      providers={props.providers}
      density={props.density}
      profileSelection={props.profileSelection}
    />
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
 * The watched host, and the one action the strip owes it.
 *
 * `HostSwitcher` carries selection and exactly one trailing action, and the
 * caller owns what that action DOES — so the strip ends its list in Activate
 * when it is watching a machine that is not the active one, and in the same
 * link to Settings the two header popovers use when it is not.
 *
 * `scope.isActivating` gates the row rather than only `makeActive`'s own latch:
 * that latch is silent, and a live-looking row that does nothing is a different
 * defect from the double write it prevents.
 *
 * Deliberately NOT calling `useRegisteredHostsPollLiveness`. The popovers do,
 * because they are the only host-list surface mounted while they are OPEN; this
 * chip is mounted for the life of the window, and opting the whole session into
 * the liveness poll to keep a dot fresh inside a list nobody has opened is a
 * cost with no reader. `HostSwitcher` refreshes the directory on open, which is
 * when the rows are actually looked at.
 */
function StatusBarHostChip(props: { readonly scope: HostScope }): ReactNode {
  const { openSettings } = useSystemTabModalActions();
  const scope = props.scope;
  const resolvedHostId = scope.hostId;
  const manageHosts: HostSwitcherAction = {
    kind: "manage-hosts",
    disabled: false,
    onSelect: () => {
      // The displayed host travels with the jump - one rule, one
      // implementation, shared with the popovers' CTAs.
      carryViewedHostIntoSettingsScope(scope.hostId);
      openSettings({ section: "host", resetToGeneral: false });
    },
  };
  const action: HostSwitcherAction =
    // No resolved host is no host to activate — and it is also the state the
    // switcher's zero-host branch renders, which offers the trailing action as
    // a plain button with no pending state of its own. Falling back to Manage
    // hosts is what keeps `activate-host` out of a branch that cannot express
    // it.
    resolvedHostId === null || scope.isViewingActive
      ? manageHosts
      : {
          kind: "activate-host",
          disabled: scope.isActivating,
          onSelect: () => scope.makeActive(resolvedHostId),
        };
  return (
    <HostSwitcher
      hosts={scope.hosts}
      selected={scope.host}
      activeHostId={scope.activeHostId}
      onSelect={scope.setHostId}
      refusalByHostId={NO_HOST_OPTION_REFUSALS}
      inertExceptHostId={null}
      action={action}
      surface="status-bar"
      intent="view"
      disabled={false}
      isLoading={scope.isLoading}
      listsFailed={scope.listsFailed}
      onRetryLists={scope.retryLists}
      // Fleet update badges are Settings' business - the same `null` the two
      // header popovers and the landing selector pass.
      updateViewForHost={null}
    />
  );
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
 */
function StatusBarHostNotice(props: { readonly scope: HostScope }): ReactNode {
  const scope = props.scope;
  if (scope.status === "connecting") {
    return (
      <span
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
        // over it and leaves the platform's alone - the same exemption the
        // chip and the two panel triggers carry.
        {...{ [STATUS_BAR_MENU_EXEMPT_ATTRIBUTE]: "" }}
        className="shrink-0 rounded-md px-1 text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        data-testid="status-bar-host-return-to-active"
      >
        Show the active host
      </button>
    </span>
  );
}
