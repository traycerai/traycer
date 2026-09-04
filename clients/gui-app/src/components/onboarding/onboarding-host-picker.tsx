import type { ReactNode } from "react";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { HostScopeConnecting } from "@/components/settings/host-scope/host-scope-gate";
import {
  onboardingHostReadiness,
  type OnboardingHostPicker,
} from "@/components/onboarding/onboarding-host-picker-model";
import { useRegisteredHostsPollLiveness } from "@/hooks/auth/use-registered-hosts-query";
import { cn } from "@/lib/utils";

/**
 * The title bar of the tour's mini-app window, with the host picker where the
 * static title used to be - centred, the way the login-import window centres
 * its title, so the three live acts read as one window with a different
 * title. No words before the name: the card or wizard beneath already says
 * what the act is about, and "Agent guide for ⟨host⟩" over a card headed
 * "Agent selection guide" said it twice.
 *
 * A single-host account gets plain text: there is nothing to choose, and a
 * chevron that opens a list of one is a control that lies about what it does.
 */
export function OnboardingHostPickerBar(props: {
  readonly picker: OnboardingHostPicker;
  /** The window dots. Off where this bar heads a card inside a window. */
  readonly trafficLights: boolean;
  readonly className: string;
}): ReactNode {
  const { scope } = props.picker;
  // The host rows are served by a NON-polling observer; the Settings sidebar
  // is normally what opts a window into the liveness poll. During the tour
  // this bar is the only host-list surface on screen, so it carries the same
  // opt-in for as long as it is up.
  useRegisteredHostsPollLiveness();
  return (
    <header
      data-testid="onboarding-host-picker-bar"
      className={cn(
        "relative flex h-10 shrink-0 items-center justify-center bg-canvas px-3 text-canvas-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border/90 after:content-['']",
        props.className,
      )}
    >
      {props.trafficLights ? (
        <div
          aria-hidden="true"
          className="absolute left-3 flex items-center gap-1.5"
        >
          <span className="size-2 rounded-full bg-[#ff5f57]" />
          <span className="size-2 rounded-full bg-[#ffbd2e]" />
          <span className="size-2 rounded-full bg-[#28c840]" />
        </div>
      ) : null}
      {scope.hosts.length < 2 ? (
        <span
          data-testid="onboarding-host-name"
          className="min-w-0 truncate px-3 py-2 text-ui-xs text-muted-foreground"
        >
          {scope.hostLabel}
        </span>
      ) : (
        <div className="flex min-w-0 max-w-[70%]">
          <HostSwitcher
            hosts={scope.hosts}
            selected={scope.host}
            activeHostId={scope.activeHostId}
            onSelect={props.picker.onSelectHost}
            refusalByHostId={NO_HOST_OPTION_REFUSALS}
            inertExceptHostId={null}
            // No trailing "Manage hosts" row: the tour renders outside the
            // app shell, so the Settings overlay that row would open has no
            // surface to appear on until the tour is over. Managing hosts is
            // Settings' job; the tour only picks among the ones that exist.
            action={null}
            surface="panel-header"
            // `pin`, not `view`: the tour WRITES to the picked host - it imports
            // sessions onto it and stores the guide on it - so, like every
            // picker that acts on a host, a row with no route is inert rather
            // than a click that lands on a dead stage. `view` is for surfaces
            // that only watch (the usage popover, Settings), where an offline
            // host is still worth opening to read what the registry knows.
            intent="pin"
            disabled={false}
            isLoading={scope.isLoading}
            listsFailed={scope.listsFailed}
            onRetryLists={scope.retryLists}
            updateViewForHost={null}
          />
        </div>
      )}
    </header>
  );
}

/**
 * Why a stage is showing nothing rather than showing another machine's work
 * under the name in the bar above it.
 *
 * No "back to the active host" button on purpose: returning to following is a
 * host switch like any other, and the one path that saves the guide draft
 * before switching goes through the picker directly above this notice.
 */
export function OnboardingHostUnavailableNotice(props: {
  readonly picker: OnboardingHostPicker;
  /**
   * A refusal only the STAGE can state - the session-import act's "this host
   * is too old to scan" - or `null` for the scope's own three states. A caller
   * sets it only once the host is otherwise usable, since a host with no
   * client has negotiated nothing to refuse with.
   */
  readonly refusal: string | null;
}): ReactNode {
  const { scope } = props.picker;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      {onboardingHostReadiness(props.picker) === "connecting" ? (
        <HostScopeConnecting hostName={scope.hostLabel} />
      ) : (
        <div
          role="status"
          data-testid="onboarding-host-unavailable"
          className="flex max-w-[40ch] flex-col items-center gap-2 text-center"
        >
          <p className="text-ui-sm font-medium text-foreground">
            {props.refusal ??
              (scope.status === "vanished"
                ? `${scope.hostLabel} is no longer connected`
                : `Can't reach ${scope.hostLabel}`)}
          </p>
          <p className="text-ui-sm text-muted-foreground">
            {props.refusal === null
              ? "Pick another machine above to carry on."
              : "Update it, or pick another machine above."}
          </p>
        </div>
      )}
    </div>
  );
}
