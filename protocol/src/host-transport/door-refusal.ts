import {
  readDoorReason,
  type HostDoorReason,
} from "@traycer/protocol/framework/door-reason";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";

/** The reasons a fresh host-only token, or the sign-out path, answers. */
const CREDENTIAL_REASONS: ReadonlySet<HostDoorReason> = new Set([
  "token_expired",
  "not_admitted",
  "session_revoked",
]);

/**
 * Whether a host's refusal goes to the connection's auth recovery. A
 * recognised `doorReason` decides alone, whatever code carries it; the code
 * decides only when the reason is absent (an older host) or one this client
 * does not know. `clock_skew` is not among them: a fresh token does not fix a
 * clock.
 */
export function isCredentialRefusal(details: FatalErrorDetails): boolean {
  const reason = readDoorReason(details.doorReason);
  if (reason === "absent" || reason === "unrecognised")
    return details.code === "UNAUTHORIZED";
  return CREDENTIAL_REASONS.has(reason);
}
