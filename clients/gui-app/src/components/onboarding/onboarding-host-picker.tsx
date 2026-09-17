import { useMemo, type ReactNode } from "react";
import { Monitor } from "lucide-react";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import { HostScopeConnecting } from "@/components/settings/host-scope/host-scope-gate";
import {
  onboardingHostReadiness,
  type OnboardingHostPicker,
} from "@/components/onboarding/onboarding-host-picker-model";
import { useRegisteredHostsPollLiveness } from "@/hooks/auth/use-registered-hosts-query";
import { cn } from "@/lib/utils";
import "./onboarding-host-picker.css";

/** A device picker for live panels; a single device needs only its name. */
export function OnboardingHostPickerBar(props: {
  readonly picker: OnboardingHostPicker;
  readonly className: string;
}): ReactNode {
  const { scope } = props.picker;
  // Every host the tour cannot reach, with the word its row would carry if
  // the status column were silent. The row's own status word ("offline",
  // "stopped") speaks first when it has one; this only makes the row inert.
  const refusalByHostId = useMemo(
    (): ReadonlyMap<string, string> =>
      new Map(
        scope.hosts
          .filter((host) => !host.connectable)
          .map((host) => [host.hostId, "unreachable"]),
      ),
    [scope.hosts],
  );
  // The host rows are served by a NON-polling observer; the Settings sidebar
  // is normally what opts a window into the liveness poll. During the tour
  // this bar is the only host-list surface on screen, so it carries the same
  // opt-in for as long as it is up.
  useRegisteredHostsPollLiveness();
  return (
    <header
      data-testid="onboarding-host-picker-bar"
      className={cn(
        "onboarding-host-control flex min-w-0 shrink-0 items-center text-foreground",
        props.className,
      )}
    >
      <Monitor
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 size-3.5 shrink-0 text-muted-foreground"
      />
      {scope.hosts.length === 1 && scope.hosts[0]?.hostId === scope.hostId ? (
        <span
          data-testid="onboarding-host-name"
          className="min-w-0 break-words py-1.5 pl-8 pr-2.5 text-[0.8125rem]"
        >
          {scope.hostLabel}
        </span>
      ) : (
        <div className="flex min-w-0 flex-1">
          <HostSwitcher
            hosts={scope.hosts}
            selected={scope.host}
            activeHostId={scope.activeHostId}
            onSelect={props.picker.onSelectHost}
            // The tour WRITES to the picked host - it imports sessions onto
            // it and configures its providers - so a host with no route is
            // refused here rather than offered as a click that lands on a
            // dead stage. A refusal rather than the `pin` intent, which
            // would gate the same rows: `pin` also drops the ACTIVE tag and
            // the "currently viewing" mark, and the tour has exactly the
            // distinction those carry - following this window's host, or
            // looking at another one - the same way the usage popover does.
            refusalByHostId={refusalByHostId}
            inertExceptHostId={null}
            // No trailing "Manage hosts" row: the tour renders outside the
            // app shell, so the Settings overlay that row would open has no
            // surface to appear on until the tour is over. Managing hosts is
            // Settings' job; the tour only picks among the ones that exist.
            action={null}
            surface="inline"
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

/** Keep another device's data hidden while the selected one connects. */
export function OnboardingHostUnavailableNotice(props: {
  readonly picker: OnboardingHostPicker;
  /**
   * A refusal only the STAGE can state - the session-import step's "this host
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
              ? "Reconnect this device to continue."
              : `Update Traycer on ${scope.hostLabel}.`}
          </p>
        </div>
      )}
    </div>
  );
}
