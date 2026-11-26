import {
  readDoorReason,
  type HostDoorReason,
} from "@traycer/protocol/framework/door-reason";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRefusalOf } from "@traycer-clients/shared/host-transport/host-door-state";

// A malformed request (`E_INVALID_ARGUMENT`) and a 403 without authn's code
// (`E_ROLE_FORBIDDEN`) are not lost standing. Typed so an impossible code fails to compile.
const RPC_AUTHORITY_REFUSALS: ReadonlySet<HostRpcError["code"]> = new Set<
  HostRpcError["code"]
>([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "E_ENVIRONMENT_NOT_A_MEMBER",
  "E_ENVIRONMENT_SEAT_NOT_ACCEPTED",
]);

const AUTHORITY_REFUSALS: ReadonlySet<
  NonNullable<HostRpcError["fatalDetails"]>["code"]
> = new Set([
  ...RPC_AUTHORITY_REFUSALS,
  "NOT_FOUND",
  "TEAM_MEMBERSHIP_REQUIRED",
]);

// The others are a condition of the computer or of a renewable token, so the last answer is kept.
const AUTHORITY_LOST_REASONS: ReadonlySet<HostDoorReason> = new Set([
  "not_admitted",
  "membership_removed",
  "session_revoked",
  "host_claimed",
]);

/** A recognised door reason takes precedence over the transport's code. */
export function environmentReadLostAuthority(
  error: HostRpcError | null,
): boolean {
  const refusal = error === null ? null : hostRefusalOf(error);
  if (refusal?.retryable === true) return false;
  const reason = readDoorReason(refusal?.doorReason);
  if (reason !== "absent" && reason !== "unrecognised")
    return AUTHORITY_LOST_REASONS.has(reason);
  return (
    AUTHORITY_REFUSALS.has(error?.code ?? "") ||
    AUTHORITY_REFUSALS.has(refusal?.code ?? "")
  );
}

/** Keep the last answer through outages, but never through lost authority. */
export function environmentReadData<T>(query: {
  readonly data: T | undefined;
  readonly error: HostRpcError | null;
}): T | undefined {
  return environmentReadLostAuthority(query.error) ? undefined : query.data;
}
