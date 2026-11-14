import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { SessionDoorObserver } from "@traycer/protocol/host-transport/remote/auth";
import {
  hostDoorStateOfRefusal,
  type HostDoorStateKind,
} from "@traycer-clients/shared/host-transport/host-door-state";
import {
  clearHostDoorState,
  clearHostDoorStateOfKind,
  noteHostDoorState,
} from "@/stores/host/host-door-state-store";

/**
 * The one place a host's refusal at any of its three doors becomes this app's
 * state of that host, and an admitted open clears it. A relay's own session
 * kill never comes through here.
 */
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
      clearHostDoorState(hostId);
    },
  };
}

/** A state the app raises itself: from a mint, or a repeated refusal. */
export function noteHostTokenRefusal(
  hostId: string,
  kind: HostDoorStateKind,
): void {
  noteHostDoorState({ hostId, kind, detail: null });
}

/**
 * A renewal's answer for one host: authn unreachable raises
 * `access-check-delayed`, and a later renewal that succeeds clears it.
 */
export function noteHostTokenRenewal(hostId: string, delayed: boolean): void {
  if (delayed) noteHostTokenRefusal(hostId, "access-check-delayed");
  else clearHostDoorStateOfKind(hostId, "access-check-delayed");
}
