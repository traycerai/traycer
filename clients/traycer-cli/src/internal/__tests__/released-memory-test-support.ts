import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";

/** The host answers an open naming a reason, as the stream records it: the instance this process now sees for `hostId`. */
export function nameReason(hostId: string): void {
  processReleasedHosts.refusedNamingReason(
    processReleasedHosts.currentInstance(hostId),
    false,
  );
}

/** The host invites the person's sign-in (`owner_sign_in`) from the instance this process now sees for `hostId`. */
export function inviteReason(hostId: string): void {
  processReleasedHosts.refusedNamingReason(
    processReleasedHosts.currentInstance(hostId),
    true,
  );
}
