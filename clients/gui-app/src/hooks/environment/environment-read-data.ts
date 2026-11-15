import {
  readDoorReason,
  type HostDoorReason,
} from "@traycer/protocol/framework/door-reason";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRefusalOf } from "@traycer-clients/shared/host-transport/host-door-state";

/**
 * The codes that say a person's standing is gone: the host's own, and
 * authn's as the app's own reads code them (`HOST_CODE_OF`), which are a 401
 * as `UNAUTHORIZED` and an environment authn says is not theirs to read
 * (`not_readable`: its 404 `environment_not_found` or its 403
 * `environment_action_forbidden`) as `E_ENVIRONMENT_NOT_A_MEMBER`. A
 * malformed request (`E_INVALID_ARGUMENT`) and a 403 without authn's code
 * (`E_ROLE_FORBIDDEN`) are none of these. Typed as the error's own code, so a
 * code no error can carry fails the compile here.
 */
const RPC_AUTHORITY_REFUSALS: ReadonlySet<HostRpcError["code"]> = new Set<
  HostRpcError["code"]
>([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "E_ENVIRONMENT_NOT_A_MEMBER",
  "E_ENVIRONMENT_SEAT_NOT_ACCEPTED",
]);

/**
 * Those, and the session-fatal codes a refusal's fatal details carry that are
 * no RPC error code. Typed as that field's own code.
 */
const AUTHORITY_REFUSALS: ReadonlySet<
  NonNullable<HostRpcError["fatalDetails"]>["code"]
> = new Set([
  ...RPC_AUTHORITY_REFUSALS,
  "NOT_FOUND",
  "TEAM_MEMBERSHIP_REQUIRED",
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
