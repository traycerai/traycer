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
 * A recognised `doorReason` decides alone; the code only when the reason is absent
 * or unknown. `clock_skew` is excluded: a fresh token does not fix a clock.
 */
export function isCredentialRefusal(details: FatalErrorDetails): boolean {
  const reason = readDoorReason(details.doorReason);
  if (reason === "absent" || reason === "unrecognised")
    return details.code === "UNAUTHORIZED";
  return CREDENTIAL_REASONS.has(reason);
}
