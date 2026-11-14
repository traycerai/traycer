/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ Access and setup).
 * Update that file whenever this settings surface changes.
 */
import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentStatusResponse,
  RemoteAccessState,
} from "@traycer/protocol/host/environment-schemas";
import {
  remoteAccessText,
  remoteAccessFailureText,
  shownRemoteAccess,
} from "@/components/settings/host-scope/host-access-model";
import { RemoteAccessQuestion } from "@/components/settings/host-scope/remote-access-question";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useRemoteAccessSetMutation } from "@/hooks/environment/use-remote-access-set-mutation";
import { useRemoteAccessTurnOnMutation } from "@/hooks/environment/use-remote-access-turn-on-mutation";
import { useCanSetRemoteAccess } from "@/hooks/environment/use-can-set-remote-access";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Remote access on the picked host: whether other devices and agents on the
 * person's account or team can reach this computer, and the switch.
 *
 * Off is visible while it happens: the host answers `turning_off` until it
 * has closed every session (within 30 seconds), and the section says so until
 * the host's own status reports `off`.
 */
export function RemoteAccessSection(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  /** The host's own report, from `environment.status`. */
  readonly status: RemoteAccessState;
  readonly principal: EnvironmentStatusResponse["principal"];
}): ReactNode {
  const writable = useCanSetRemoteAccess(
    props.client,
    props.hostId,
    props.principal,
    true,
  );
  // The host's last answer to a switch made here.
  const [lastAnswer, setLastAnswer] = useState<RemoteAccessState | null>(null);
  // Once the host reports `off`, the answer has done its job.
  if (lastAnswer === "turning_off" && props.status === "off") {
    setLastAnswer(null);
  }
  const set = useRemoteAccessSetMutation(props.client, setLastAnswer);
  const turnOn = useRemoteAccessTurnOnMutation(props.client, props.hostId);
  const failure = turnOn.error ?? set.error;
  const shown = shownRemoteAccess(props.status, lastAnswer);
  return (
    <SettingsGroup
      group={HOST_OVERVIEW.definitions.remoteAccess}
      showTitle
      tone="default"
      dataTestId="remote-access-section"
      fill={false}
    >
      <RemoteAccessQuestion client={props.client} hostId={props.hostId} enabled>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-ui-sm">
          <span
            className="min-w-0 flex-1 text-muted-foreground"
            data-testid="remote-access-state"
            data-state={shown}
          >
            {remoteAccessText(shown, props.principal)}
          </span>
          {!writable ? null : (
            <RemoteAccessControl
              shown={shown}
              pending={set.isPending || turnOn.isPending}
              onSet={(enabled) => {
                if (enabled) turnOn.mutate();
                else set.mutate({ enabled: false });
              }}
            />
          )}
        </div>
      </RemoteAccessQuestion>
      {failure !== null ? (
        <p role="alert" className="px-5 py-3 text-ui-sm text-destructive">
          {remoteAccessFailureText(failure.code)}
        </p>
      ) : null}
    </SettingsGroup>
  );
}

function RemoteAccessControl(props: {
  readonly shown: RemoteAccessState;
  readonly pending: boolean;
  readonly onSet: (enabled: boolean) => void;
}): ReactNode {
  if (props.shown === "turning_off") {
    return (
      <AgentSpinningDots
        className={undefined}
        testId="remote-access-turning-off"
        variant={undefined}
        tone="muted"
      />
    );
  }
  const enabling = props.shown === "off";
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={props.pending}
      onClick={() => props.onSet(enabling)}
    >
      {enabling ? "Turn on" : "Turn off"}
      {props.pending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      ) : null}
    </Button>
  );
}
