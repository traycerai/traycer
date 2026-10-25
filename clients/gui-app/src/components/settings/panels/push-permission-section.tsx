import type { ReactNode } from "react";
import type {
  PushPermissionState,
  PushSeverity,
} from "@traycer-clients/shared/platform/runner-host";
import { APP_NOTIFICATIONS } from "@/components/settings/panels/app-notifications-settings.definitions";
import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { usePushMutedSeveritiesMutation } from "@/hooks/runner/use-push-muted-severities-mutation";
import { usePushMutedSeveritiesQuery } from "@/hooks/runner/use-push-muted-severities-query";
import {
  usePushPermissionOpenSettingsMutation,
  type PushPermissionOpenSettingsMutation,
} from "@/hooks/runner/use-push-permission-open-settings-mutation";
import {
  usePushPermissionQuery,
  type PushPermissionQuery,
} from "@/hooks/runner/use-push-permission-query";
import {
  usePushPermissionRequestMutation,
  type PushPermissionRequestMutation,
} from "@/hooks/runner/use-push-permission-request-mutation";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import type { SettingsRowDefinition } from "@/lib/settings-search/settings-definitions";
import { useAuthStore } from "@/stores/auth/auth-store";

type PushPermissionView =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: PushPermissionState };

// The events that reach the phone are the ones each host has turned on under
// Notification events (the row below), so the copy points there rather than
// naming a subset of them.
const STATE_DESCRIPTIONS: { readonly [K in PushPermissionState]: string } = {
  granted:
    "Delivered to this phone for the events turned on under Notification events.",
  denied: "Turned off for Traycer in system Settings.",
  prompt:
    "Get buzzed on this phone for the events turned on under Notification events.",
};

const READ_FAILED = "Couldn't read this phone's notification setting.";

// In the chime rows' order, so the two lists read alike.
const SEVERITY_ROWS: ReadonlyArray<{
  readonly severity: PushSeverity;
  readonly row: SettingsRowDefinition;
}> = [
  {
    severity: "needs_action",
    row: APP_NOTIFICATIONS.definitions.pushNeedsAction,
  },
  { severity: "failure", row: APP_NOTIFICATIONS.definitions.pushFailure },
  { severity: "done", row: APP_NOTIFICATIONS.definitions.pushDone },
  { severity: "info", row: APP_NOTIFICATIONS.definitions.pushInfo },
];

/**
 * The OS push permission of the phone this renderer runs on, and under it the
 * severities that phone is pushed for. They belong under Application → Sounds
 * because they never vary with the selected host.
 *
 * The permission row exists because the OS remembers a refusal forever - the
 * app asks once, and after a "Don't Allow" no amount of relaunching can
 * re-prompt. Without this row nothing in Traycer says so, and the only repair
 * (the OS Settings app) is undiscoverable. On every shell without OS push -
 * desktop, dev web, tests - `pushPermission` is `null` and this renders
 * nothing at all, so the panel is byte-identical there.
 *
 * The row is labelled "on this phone", never "on this device": in this GUI
 * "device" is the UI word for a HOST (Settings → Devices lists hosts), so
 * "this device" would read as one more host-scoped setting - the exact
 * confusion the row is here to end. Its rows sit in the Sounds page's
 * Notifications group, which the panel draws.
 *
 * The gate is the only thing rendered above them: every hook the rows use
 * reaches the runner host, which throws in a host-less shell, so they live in
 * the children and run only once the gate has passed.
 */
export function PushPermissionSection(): ReactNode {
  const availability = useSettingsAvailabilityContext();
  if (
    !APP_NOTIFICATIONS.definitions.pushNotifications.availableWhen(availability)
  ) {
    return null;
  }
  return <PushPermissionRows />;
}

function PushPermissionRows(): ReactNode {
  const view = pushPermissionView(usePushPermissionQuery());
  return (
    <>
      <PushPermissionRow view={view} />
      <PushSeverityRows granted={view.kind === "granted"} />
    </>
  );
}

function PushPermissionRow(props: {
  readonly view: PushPermissionView;
}): ReactNode {
  const { view } = props;
  const request = usePushPermissionRequestMutation();
  const openSettings = usePushPermissionOpenSettingsMutation();
  return (
    <SettingsRow
      row={APP_NOTIFICATIONS.definitions.pushNotifications}
      status={viewDescription(view)}
      control={
        <div
          data-testid="push-permission-state"
          data-state={view.kind}
          className="flex items-center gap-2"
        >
          <PushPermissionControl
            kind={view.kind}
            request={request}
            openSettings={openSettings}
          />
        </div>
      }
    />
  );
}

function PushPermissionControl(props: {
  readonly kind: PushPermissionView["kind"];
  readonly request: PushPermissionRequestMutation;
  readonly openSettings: PushPermissionOpenSettingsMutation;
}): ReactNode {
  const { kind, request, openSettings } = props;
  if (kind === "loading") {
    return (
      <AgentSpinningDots
        className={undefined}
        testId="push-permission-checking"
        variant={undefined}
        tone="muted"
      />
    );
  }
  // Granted needs no control - there is nothing left to do here, and a button
  // that only ever leads back to the OS would invite people to go turn it off.
  if (kind === "granted") {
    return <span className="text-ui-xs text-muted-foreground">On</span>;
  }
  if (kind === "denied") {
    return (
      <PushPermissionAction
        label="Open Settings"
        pending={openSettings.isPending}
        onClick={() => {
          openSettings.mutate();
        }}
      />
    );
  }
  if (kind === "prompt") {
    return (
      <PushPermissionAction
        label="Enable"
        pending={request.isPending}
        onClick={() => {
          request.mutate();
        }}
      />
    );
  }
  // `error`: the description carries what went wrong, and there is no action
  // worth offering against a device whose setting we could not even read.
  return null;
}

function PushPermissionAction(props: {
  readonly label: string;
  readonly pending: boolean;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <Button
      type="button"
      variant="default"
      size="sm"
      disabled={props.pending}
      data-testid="push-permission-action"
      onClick={props.onClick}
    >
      {props.pending ? (
        <AgentSpinningDots
          className={undefined}
          testId="push-permission-action-spinner"
          variant={undefined}
        />
      ) : null}
      {props.label}
    </Button>
  );
}

/**
 * A switch is on while its severity is NOT muted, and shows what the phone
 * stored for the signed-in account. The switches only narrow what the hosts
 * already send, so they move only while pushes are on: in every other state
 * there is nothing for them to narrow, and the row above says why.
 *
 * They also move only once this account's set has been read since the rows
 * started showing it. A toggle sends a whole set derived from the loaded one,
 * so an answer still in flight - or one cached before a change made while the
 * rows were not showing - must not be the base it is derived from.
 */
function PushSeverityRows(props: { readonly granted: boolean }): ReactNode {
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const query = usePushMutedSeveritiesQuery();
  const mutation = usePushMutedSeveritiesMutation();
  const loaded =
    query.isSuccess && query.isFetchedAfterMount ? query.data : undefined;
  const editing =
    !props.granted ||
    mutation.isPending ||
    userId === null ||
    loaded === undefined
      ? null
      : { userId, muted: loaded };
  const shown = query.data ?? [];
  return (
    <>
      {SEVERITY_ROWS.map((entry) => (
        <SettingsRow
          key={entry.severity}
          row={entry.row}
          control={
            <Switch
              checked={!shown.includes(entry.severity)}
              disabled={editing === null}
              aria-label={`${entry.row.label} push notifications`}
              onCheckedChange={(delivered) => {
                if (editing === null) return;
                mutation.mutate({
                  userId: editing.userId,
                  severities: nextMutedSeverities(
                    editing.muted,
                    entry.severity,
                    delivered,
                  ),
                });
              }}
            />
          }
        />
      ))}
    </>
  );
}

function nextMutedSeverities(
  muted: readonly PushSeverity[],
  severity: PushSeverity,
  delivered: boolean,
): readonly PushSeverity[] {
  const others = muted.filter((entry) => entry !== severity);
  return delivered ? others : [...others, severity];
}

/**
 * A last-known state outranks a failed REFETCH. The row's job is to report the
 * OS switch, and a stale-but-real answer with its working button beats
 * replacing both with an apology; the error copy is for the case that has
 * nothing to show, which is the first read failing.
 */
function pushPermissionView(query: PushPermissionQuery): PushPermissionView {
  if (query.data !== undefined) return { kind: query.data };
  if (query.error !== null) {
    return { kind: "error", message: query.error.message };
  }
  return { kind: "loading" };
}

function viewDescription(view: PushPermissionView): string {
  if (view.kind === "loading") return "Checking…";
  if (view.kind === "error") {
    return view.message === "" ? READ_FAILED : `${READ_FAILED} ${view.message}`;
  }
  return STATE_DESCRIPTIONS[view.kind];
}
