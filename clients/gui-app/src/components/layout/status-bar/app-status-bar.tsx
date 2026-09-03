import { use, useRef, type ReactNode } from "react";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import {
  HostSwitcher,
  type HostSwitcherAction,
} from "@/components/settings/host-scope/host-switcher";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { useScopedStreamBinding } from "@/components/settings/host-scope/use-scoped-stream-binding";
import {
  useHostScopeFor,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { ResourceMonitorPopover } from "@/components/resources/resource-monitor-popover";
import { useStatusBarDensity } from "@/components/layout/status-bar/status-bar-density";
import { StatusBarResourceSegment } from "@/components/layout/status-bar/status-bar-resource-segment";
import { HostRuntimeContext, useHostBinding } from "@/lib/host";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import { useWatchHostStore } from "@/stores/host-scope/watch-host-store";
import { useLayoutStore } from "@/stores/settings/layout-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/**
 * The app's bottom strip: provider usage on the left (T3), the watched host and
 * its resource readout on the right.
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
  const scopedHostId = useWatchHostStore((state) => state.scopedHostId);
  const setScopedHostId = useWatchHostStore((state) => state.setScopedHostId);
  const scope = useHostScopeFor({ scopedHostId, setScopedHostId });
  const scopedBinding = useScopedHostBinding(scope);
  const ambientBinding = useHostBinding();
  const scopedStreamBinding = useScopedStreamBinding(scope);
  const ambientStreamBinding = use(StreamRuntimeContext);
  return (
    <HostRuntimeContext.Provider value={scopedBinding ?? ambientBinding}>
      <StreamRuntimeContext.Provider
        value={scopedStreamBinding ?? ambientStreamBinding}
      >
        <ScopedAppStatusBar
          scope={scope}
          hasExplicitPick={scopedHostId !== null}
        />
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
  const resourcesEnabled = useLayoutStore(
    (state) => state.statusBar.resources.enabled,
  );
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
    // Two boxes, not one. The row is exactly `h-6`; the bottom inset is
    // ADDITIONAL space under it. Putting `pb-safe-bottom` on an `h-6` box would
    // make the padding eat the row instead of extending past it, since `h-6`
    // fixes the total height. `#root` reserves the top and both sides app-wide
    // and deliberately not the bottom, so this strip owns that edge.
    <div
      ref={barRef}
      data-testid="app-status-bar"
      className="shrink-0 border-t border-border/90 bg-canvas pb-safe-bottom text-canvas-foreground"
    >
      <div className="flex h-6 items-center gap-2 px-2 text-ui-xs tabular-nums">
        {scopedToOwnHost ? (
          // T3 fills this with the provider segments. It reserves the slot now
          // so the right-hand cluster does not shift into place when they land.
          <span data-testid="status-bar-rate-limit-slot" />
        ) : (
          <StatusBarHostNotice scope={scope} />
        )}
        <span className="flex-1" />
        <StatusBarHostChip scope={scope} />
        {scopedToOwnHost && resourcesEnabled ? (
          <ResourceMonitorPopover
            trigger="custom"
            contentSide="top"
            triggerNode={
              <StatusBarResourceSegment
                density={density}
                hostId={scope.hostId}
                hostLabel={scope.hostLabel}
              />
            }
          />
        ) : null}
      </div>
    </div>
  );
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
        className="shrink-0 rounded-md px-1 text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        data-testid="status-bar-host-return-to-active"
      >
        Show the active host
      </button>
    </span>
  );
}
