/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ Access and setup).
 * Update that file whenever this settings surface changes.
 */
import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { RemoteAccessState } from "@traycer/protocol/host/environment-schemas";
import {
  REMOTE_ACCESS_TEXT,
  shownRemoteAccess,
} from "@/components/settings/host-scope/host-access-model";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useRemoteAccessSetMutation } from "@/hooks/environment/use-remote-access-set-mutation";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Remote access on the picked host: whether other devices and agents on the
 * person's account can reach this computer, and the switch.
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
}): ReactNode {
  const writable =
    useHostMethodSupport(props.hostId, "host.remoteAccess.set") === true;
  // The host's last answer to a switch made here.
  const [lastAnswer, setLastAnswer] = useState<RemoteAccessState | null>(null);
  // Once the host reports `off`, the answer has done its job.
  if (lastAnswer === "turning_off" && props.status === "off") {
    setLastAnswer(null);
  }
  const set = useRemoteAccessSetMutation(props.client, setLastAnswer);
  const shown = shownRemoteAccess(props.status, lastAnswer);
  return (
    <SettingsGroup
      group={HOST_OVERVIEW.definitions.remoteAccess}
      showTitle
      tone="default"
      dataTestId="remote-access-section"
      fill={false}
    >
      <SettingsRow
        row={HOST_OVERVIEW.definitions.remoteAccessRow}
        status={
          <span data-testid="remote-access-state" data-state={shown}>
            {REMOTE_ACCESS_TEXT[shown]}
          </span>
        }
        control={
          !writable ? null : (
            <RemoteAccessControl
              shown={shown}
              pending={set.isPending}
              onSet={(enabled) => set.mutate({ enabled })}
            />
          )
        }
      />
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
