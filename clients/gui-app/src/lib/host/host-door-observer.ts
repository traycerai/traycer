import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import {
  HOST_DOOR_STATE_POLICY,
  hostDoorStateOfRefusal,
  type DoorAdmissionRelease,
  type HostDoorObserver,
  type HostDoorStateKind,
  type StreamDoorObserver,
} from "@traycer-clients/shared/host-transport/host-door-state";
import {
  clearHostDoorState,
  clearHostDoorStateOfKind,
  hostDoorStateFor,
  noteHostDoorState,
} from "@/stores/host/host-door-state-store";

/**
 * How many of this app's connections each host has admitted and not yet lost,
 * across every transport: renderer streams, unary calls, one-shot streams and
 * relay sessions. No report, a refusal's or a mint's, covers a host while one
 * of them is admitted: a cover over a working connection is never true.
 */
const admittedNow = new Map<string, number>();

function hostAdmittedNow(hostId: string): boolean {
  return (admittedNow.get(hostId) ?? 0) > 0;
}

function admit(hostId: string): DoorAdmissionRelease {
  admittedNow.set(hostId, (admittedNow.get(hostId) ?? 0) + 1);
  // An open on the held token says nothing about authn: a state only a renewal clears stays.
  const state = hostDoorStateFor(hostId);
  if (
    state === null ||
    HOST_DOOR_STATE_POLICY[state.kind].clears !== "renewal-succeeded"
  )
    clearHostDoorState(hostId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (admittedNow.get(hostId) ?? 0) - 1;
    if (left > 0) admittedNow.set(hostId, left);
    else admittedNow.delete(hostId);
  };
}

function noteRefusal(hostId: string, details: FatalErrorDetails): void {
  if (hostAdmittedNow(hostId)) return;
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
}

/** The one place a host's refusal becomes this app's state of it. A relay's own session kill never comes here. */
export function appHostDoorObserver(hostId: string): HostDoorObserver {
  return {
    refused: (details) => {
      noteRefusal(hostId, details);
    },
    admitted: () => admit(hostId),
  };
}

/** {@link appHostDoorObserver} for a stream, which names the host each answer came from. */
export const appStreamDoorObserver: StreamDoorObserver = {
  refused: (details, hostId) => {
    noteRefusal(hostId, details);
  },
  admitted: admit,
};

/** `HostTokenStateSink`: dropped while the host has a connection of this app admitted. */
export function noteHostTokenRefusal(
  hostId: string,
  kind: HostDoorStateKind,
): void {
  if (hostAdmittedNow(hostId)) return;
  noteHostDoorState({ hostId, kind, detail: null });
}

export function noteHostTokenRenewal(hostId: string, delayed: boolean): void {
  if (delayed)
    noteHostDoorState({ hostId, kind: "access-check-delayed", detail: null });
  else clearHostDoorStateOfKind(hostId, "access-check-delayed");
}
