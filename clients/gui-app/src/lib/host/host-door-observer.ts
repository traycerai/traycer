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
  processReleasedHosts,
  type HostInstance,
} from "@traycer-clients/shared/host-transport/released-sign-on";
import {
  clearHostDoorState,
  clearHostDoorStateOfKind,
  hostDoorStateFor,
  noteHostDoorState,
} from "@/stores/host/host-door-state-store";

/**
 * How many of this app's connections each host process instance has admitted
 * and not yet lost, across every transport: renderer streams, unary calls,
 * one-shot streams and relay sessions. No report, a refusal's or a mint's,
 * covers a host while its CURRENT instance has one admitted: a cover over a
 * working connection is never true. Once another instance of the host id is
 * observed, the earlier one's admissions no longer count, and their late
 * releases change only that instance's count.
 */
const admittedNow = new WeakMap<HostInstance, number>();

function hostAdmittedNow(hostId: string): boolean {
  return (
    (admittedNow.get(processReleasedHosts.currentInstance(hostId)) ?? 0) > 0
  );
}

function admit(instance: HostInstance): DoorAdmissionRelease {
  admittedNow.set(instance, (admittedNow.get(instance) ?? 0) + 1);
  const hostId = instance.hostId;
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
    const left = (admittedNow.get(instance) ?? 0) - 1;
    if (left > 0) admittedNow.set(instance, left);
    else admittedNow.delete(instance);
  };
}

/** Which of a host's doors answered: this machine's socket, or a session to a computer. */
type DoorPlane = "local" | "remote";

function noteRefusal(
  hostId: string,
  details: FatalErrorDetails,
  plane: DoorPlane,
): void {
  if (hostAdmittedNow(hostId)) return;
  const kind = hostDoorStateOfRefusal(details);
  if (kind === null) return;
  // Only a computer's remote door says nobody is signed in there.
  if (plane === "local" && kind === "nobody-signed-in") return;
  noteHostDoorState({
    hostId,
    kind,
    detail: {
      code: details.code,
      doorReason: details.doorReason ?? null,
    },
  });
}

/**
 * The one place a host's refusal becomes this app's state of it. A relay's own
 * session kill never comes here. A one-host door (the relay's) names no
 * instance: it is credited to the host's current one, which for a host reached
 * only through the relay is its one and only.
 */
export function appHostDoorObserver(hostId: string): HostDoorObserver {
  return hostDoorObserver(hostId, "remote");
}

/** {@link appHostDoorObserver} for this machine's socket. */
export function appLocalHostDoorObserver(hostId: string): HostDoorObserver {
  return hostDoorObserver(hostId, "local");
}

function hostDoorObserver(hostId: string, plane: DoorPlane): HostDoorObserver {
  return {
    refused: (details) => {
      noteRefusal(hostId, details, plane);
    },
    admitted: () => admit(processReleasedHosts.currentInstance(hostId)),
  };
}

/** {@link appLocalHostDoorObserver} for the local stream client, which names the host instance each answer came from. */
export const appStreamDoorObserver: StreamDoorObserver = {
  refused: (details, instance) => {
    noteRefusal(instance.hostId, details, "local");
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
