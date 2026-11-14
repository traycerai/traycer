import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";

/**
 * Whether a stream to `hostId` presents the person's sign-in, so that its
 * closing refused may start the sign-in's recovery. Only the server pool's
 * does. Every other host's stream presents a host-only token, and nothing a
 * host says starts sign-in recovery, whatever its code or reason: a host
 * connection reaches the sign-in only through a 401 on the token's mint and
 * through `session_revoked`, both inside the host-token recovery.
 */
export function streamPresentsSignIn(hostId: string): boolean {
  return hostId === POOL_HOST_ID;
}

/** `recover` for a stream that presents the sign-in, and `null` for any other. */
export function signInRecoveryForStream(
  hostId: string,
  recover: () => void,
): (() => void) | null {
  return streamPresentsSignIn(hostId) ? recover : null;
}
