import { useMemo, type ReactNode } from "react";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import { HostScopeConnecting } from "@/components/settings/host-scope/host-scope-gate";
import {
  onboardingHostReadiness,
  type OnboardingHostPicker,
} from "@/components/onboarding/onboarding-host-picker-model";
import { useRegisteredHostsPollLiveness } from "@/hooks/auth/use-registered-hosts-query";
import { cn } from "@/lib/utils";

/** No words before the name: the card or wizard beneath already says what the act is about, and "Agent guide
 * for ⟨host⟩" over a card headed "Agent selection guide" said it twice. */
export function OnboardingHostPickerBar(props: {
  readonly picker: OnboardingHostPicker;
  readonly trafficLights: boolean;
  readonly className: string;
}): ReactNode {
  const { scope } = props.picker;
  // Every host the tour cannot reach, with the word its row would carry if the status column were silent. The
  // row's own status word ("offline", "stopped") speaks first when it has one; this only makes the row inert.
  const refusalByHostId = useMemo(
    (): ReadonlyMap<string, string> =>
      new Map(
        scope.hosts
          .filter((host) => !host.connectable)
          .map((host) => [host.hostId, "unreachable"]),
      ),
    [scope.hosts],
  );
  // During the tour this bar is the only host-list surface on screen, so it carries the same opt-in for as long
  // as it is up.
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
      {scope.hosts.length === 1 && scope.hosts[0]?.hostId === scope.hostId ? (
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
            // A refusal rather than the `pin` intent, which would gate the same rows: `pin` also drops the active tag and
            // the "currently viewing" mark, and the tour has exactly the distinction those carry.
            refusalByHostId={refusalByHostId}
            inertExceptHostId={null}
            // No trailing "Manage hosts" row: the tour renders outside the app shell, so the Settings overlay that row
            // would open has no surface to appear on until the tour is over.
            action={null}
            surface="panel-header"
            intent="view"
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

/** Why a stage is showing nothing rather than showing another machine's work under the name in the bar above
 * it. */
export function OnboardingHostUnavailableNotice(props: {
  readonly picker: OnboardingHostPicker;
  /** A caller sets it only once the host is otherwise usable, since a host with no client has negotiated nothing
   * to refuse with. */
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
