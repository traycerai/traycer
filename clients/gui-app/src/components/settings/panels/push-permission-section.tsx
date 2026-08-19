import type { ReactNode } from "react";
import type { PushPermissionState } from "@traycer-clients/shared/platform/runner-host";
import { SettingsGroup } from "@/components/settings/settings-group";
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
import { useRunnerHost } from "@/providers/use-runner-host";

type PushPermissionView =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: PushPermissionState };

const STATE_DESCRIPTIONS: { readonly [K in PushPermissionState]: string } = {
  granted: "Delivered to this phone when an agent needs you.",
  denied:
    "Turned off for Traycer in system Settings. Turn them on to get buzzed when an agent needs you.",
  prompt: "Get buzzed when an agent needs you.",
};

const READ_FAILED = "Couldn't read this phone's notification setting.";

/**
 * The one row in Settings → Notifications that is NOT about a host: the OS
 * push permission of the phone this renderer runs on.
 *
 * It exists because the OS remembers a refusal forever - the app asks once,
 * and after a "Don't Allow" no amount of relaunching can re-prompt. Without
 * this row nothing in Traycer says so, and the only repair (the OS Settings
 * app) is undiscoverable. On every shell without OS push - desktop, dev web,
 * tests - `pushPermission` is `null` and this renders nothing at all, so the
 * panel is byte-identical there.
 *
 * The group is titled "This phone", never "This device": in this GUI "device"
 * is the UI word for a HOST (Settings → Devices lists hosts), so "This device"
 * would read as one more host-scoped setting - the exact confusion the row is
 * here to end.
 */
export function PushPermissionSection(): ReactNode {
  const { pushPermission } = useRunnerHost();
  const query = usePushPermissionQuery();
  const request = usePushPermissionRequestMutation();
  const openSettings = usePushPermissionOpenSettingsMutation();

  if (pushPermission === null) return null;

  const view = pushPermissionView(query);
  return (
    <SettingsGroup
      title="This phone"
      tone="default"
      dataTestId="push-permission-section"
      fill={false}
    >
      <SettingsRow
        label="Push notifications"
        description={viewDescription(view)}
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
    </SettingsGroup>
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
        className="text-muted-foreground"
        testId="push-permission-checking"
        variant={undefined}
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
