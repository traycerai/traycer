import type { ReactNode } from "react";
import type {
  PushPermissionState,
  PushRegistrationState,
} from "@traycer-clients/shared/platform/runner-host";
import { ALERTS } from "@/components/settings/panels/alerts-settings.definitions";
import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
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
import { usePushRegistrationRetryMutation } from "@/hooks/runner/use-push-registration-retry-mutation";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";

type PushPermissionView =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind:
        | Exclude<PushPermissionState, "granted">
        | PushRegistrationState;
    };

const STATE_DESCRIPTIONS = {
  registered: "Only the kinds turned on below are sent.",
  pending: "Setting up push notifications…",
  failed: "Push notifications couldn’t be set up. Try again.",
  denied: "Turned off for Traycer in system Settings.",
  prompt: "Allow Traycer to send push notifications.",
};

const READ_FAILED = "Couldn't read the notification permission.";

/**
 * The OS permission and last registration result for this app. The severities
 * the phone is pushed for are the Push column of the same page
 * (`usePushSeveritySwitches`). Both belong under Application → Alerts because
 * they never vary with the selected host.
 *
 * The permission row exists because the OS remembers a refusal forever - the
 * app asks once, and after a "Don't Allow" no amount of relaunching can
 * re-prompt. Without this row nothing in Traycer says so, and the only repair
 * (the OS Settings app) is undiscoverable. On every shell without OS push -
 * desktop, dev web, tests - `pushPermission` is `null` and this renders
 * nothing at all, so the panel is byte-identical there.
 *
 * The row carries no "on this device" qualifier: in this GUI "device" is the
 * UI word for a HOST (Settings → Devices lists hosts), so "this device" would
 * read as one more host-scoped setting - the exact confusion the row is here
 * to end - and "this phone" is wrong on a tablet. The row sits in the Alerts
 * page's System group, which the panel draws.
 *
 * The gate is the only thing rendered above it: every hook the row uses
 * reaches the runner host, which throws in a host-less shell, so they live in
 * the child and run only once the gate has passed.
 */
export function PushPermissionSection(): ReactNode {
  const availability = useSettingsAvailabilityContext();
  if (!ALERTS.definitions.pushNotifications.availableWhen(availability)) {
    return null;
  }
  return <PushPermissionRow />;
}

function PushPermissionRow(): ReactNode {
  const view = pushPermissionView(usePushPermissionQuery());
  const request = usePushPermissionRequestMutation();
  const openSettings = usePushPermissionOpenSettingsMutation();
  return (
    <SettingsRow
      row={ALERTS.definitions.pushNotifications}
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
  const retry = usePushRegistrationRetryMutation();
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
  if (kind === "pending") {
    return (
      <AgentSpinningDots
        className={undefined}
        testId="push-registration-pending"
        variant={undefined}
        tone="muted"
      />
    );
  }
  if (kind === "failed") {
    return (
      <PushPermissionAction
        label="Retry"
        pending={retry.isPending}
        onClick={() => retry.mutate()}
      />
    );
  }
  if (kind === "registered") {
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
 * A last-known state outranks a failed REFETCH. The row reports the OS
 * permission and local registration result, and a stale-but-real answer with its working button beats
 * replacing both with an apology; the error copy is for the case that has
 * nothing to show, which is the first read failing.
 */
function pushPermissionView(query: PushPermissionQuery): PushPermissionView {
  if (query.data !== undefined) {
    const { permission, registration } = query.data;
    return { kind: permission === "granted" ? registration : permission };
  }
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
