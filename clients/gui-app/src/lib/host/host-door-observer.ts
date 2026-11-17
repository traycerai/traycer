import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { SessionDoorObserver } from "@traycer/protocol/host-transport/remote/auth";
import {
  HOST_DOOR_STATE_POLICY,
  hostDoorStateOfRefusal,
  type HostDoorStateKind,
} from "@traycer-clients/shared/host-transport/host-door-state";
import {
  clearHostDoorState,
  clearHostDoorStateOfKind,
  hostDoorStateFor,
  noteHostDoorState,
} from "@/stores/host/host-door-state-store";

/** The one place a host's refusal becomes this app's state of it. A relay's own session kill never comes here. */
export function appHostDoorObserver(hostId: string): SessionDoorObserver {
  return {
    refused: (details: FatalErrorDetails) => {
      const kind = hostDoorStateOfRefusal(details);
      if (kind === null) return;
      noteHostDoorState({
        hostId,
        kind,
        detail: {
          code: details.code,
          doorReason: details.doorReason ?? null,
        },
      });
    },
    admitted: () => {
      // An open on the held token says nothing about authn: a state only a renewal clears stays.
      const state = hostDoorStateFor(hostId);
      if (
        state !== null &&
        HOST_DOOR_STATE_POLICY[state.kind].clears === "renewal-succeeded"
      )
        return;
      clearHostDoorState(hostId);
    },
  };
}

export function noteHostTokenRefusal(
  hostId: string,
  kind: HostDoorStateKind,
): void {
  noteHostDoorState({ hostId, kind, detail: null });
}

export function noteHostTokenRenewal(hostId: string, delayed: boolean): void {
  if (delayed) noteHostTokenRefusal(hostId, "access-check-delayed");
  else clearHostDoorStateOfKind(hostId, "access-check-delayed");
}
