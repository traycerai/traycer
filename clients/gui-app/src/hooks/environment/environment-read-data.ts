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

/** Keep the last answer through outages, but never through lost authority. */
export function environmentReadData<T>(query: {
  readonly data: T | undefined;
  readonly error: HostRpcError | null;
}): T | undefined {
  const error = query.error;
  const refusal = error === null ? null : hostRefusalOf(error);
  if (
    refusal?.retryable !== true &&
    (AUTHORITY_REFUSALS.has(error?.code ?? "") ||
      AUTHORITY_REFUSALS.has(refusal?.code ?? ""))
  )
    return undefined;
  return query.data;
}
