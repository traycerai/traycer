import { readDoorReason } from "@traycer/protocol/framework/door-reason";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";

/**
 * Whether a host's refusal is about the credential this connection presented,
 * whatever code carries it, and so goes to the connection's auth recovery.
 * A host at the door-reason protocol sends `not_admitted` and
 * `session_revoked` as `FORBIDDEN`; an older host and every expired token
 * send `UNAUTHORIZED`.
 */
export function isCredentialRefusal(details: FatalErrorDetails): boolean {
  if (details.code === "UNAUTHORIZED") return true;
  const reason = readDoorReason(details.doorReason);
  return reason === "not_admitted" || reason === "session_revoked";
}
