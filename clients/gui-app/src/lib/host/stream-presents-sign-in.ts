import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";

/** Only the server pool's stream presents the sign-in; nothing a host says starts sign-in recovery. */
export function streamPresentsSignIn(hostId: string): boolean {
  return hostId === POOL_HOST_ID;
}

export function signInRecoveryForStream(
  hostId: string,
  recover: () => void,
): (() => void) | null {
  return streamPresentsSignIn(hostId) ? recover : null;
}
