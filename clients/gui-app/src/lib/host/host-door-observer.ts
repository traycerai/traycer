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

/**
 * When each host last admitted one of this app's connections, by `Date.now()`.
 * A mint that started before then and failed says nothing about a connection
 * that works.
 */
const lastAdmittedAtMs = new Map<string, number>();

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
      lastAdmittedAtMs.set(hostId, Date.now());
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

/** `HostTokenStateSink`: dropped when the host admitted a connection at or after the mint started. */
export function noteHostTokenRefusal(
  hostId: string,
  kind: HostDoorStateKind,
  mintStartedAtMs: number,
): void {
  const admittedAtMs = lastAdmittedAtMs.get(hostId);
  if (admittedAtMs !== undefined && admittedAtMs >= mintStartedAtMs) return;
  noteHostDoorState({ hostId, kind, detail: null });
}

export function noteHostTokenRenewal(hostId: string, delayed: boolean): void {
  if (delayed)
    noteHostDoorState({ hostId, kind: "access-check-delayed", detail: null });
  else clearHostDoorStateOfKind(hostId, "access-check-delayed");
}
