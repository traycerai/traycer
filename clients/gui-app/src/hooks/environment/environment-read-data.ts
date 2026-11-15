import {
  readDoorReason,
  type HostDoorReason,
} from "@traycer/protocol/framework/door-reason";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRefusalOf } from "@traycer-clients/shared/host-transport/host-door-state";

const AUTHORITY_REFUSALS = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "TEAM_MEMBERSHIP_REQUIRED",
  "E_ENVIRONMENT_NOT_A_MEMBER",
  "E_ENVIRONMENT_SEAT_NOT_ACCEPTED",
]);

/**
 * The host's reasons that say the person's standing is gone. The others are a
 * condition of the computer or of a token that is renewed, so the last answer
 * is kept through them.
 */
const AUTHORITY_LOST_REASONS: ReadonlySet<HostDoorReason> = new Set([
  "not_admitted",
  "membership_removed",
  "session_revoked",
  "host_claimed",
]);

/**
 * Keep the last answer through outages, but never through lost authority. A
 * recognised reason decides alone; the code decides only when the reason is
 * absent or unrecognised.
 */
export function environmentReadData<T>(query: {
  readonly data: T | undefined;
  readonly error: HostRpcError | null;
}): T | undefined {
  const error = query.error;
  const refusal = error === null ? null : hostRefusalOf(error);
  if (refusal?.retryable === true) return query.data;
  const reason = readDoorReason(refusal?.doorReason);
  if (reason !== "absent" && reason !== "unrecognised")
    return AUTHORITY_LOST_REASONS.has(reason) ? undefined : query.data;
  if (
    AUTHORITY_REFUSALS.has(error?.code ?? "") ||
    AUTHORITY_REFUSALS.has(refusal?.code ?? "")
  )
    return undefined;
  return query.data;
}
