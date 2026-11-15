import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

/**
 * The host's refusals of a person's standing, and authn's as the app's own
 * reads code them (`HOST_CODE_OF`): 401 `UNAUTHORIZED`, and an environment
 * authn says is not theirs to read (`not_readable`, its 404
 * `environment_not_found` or 403 `environment_action_forbidden`)
 * `E_ENVIRONMENT_NOT_A_MEMBER`.
 * A malformed request (`E_INVALID_ARGUMENT`) and a 403 without authn's code
 * (`E_ROLE_FORBIDDEN`) are none of these.
 */
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
  if (
    error?.fatalDetails?.retryable !== true &&
    (AUTHORITY_REFUSALS.has(error?.code ?? "") ||
      AUTHORITY_REFUSALS.has(error?.fatalDetails?.code ?? ""))
  )
    return undefined;
  return query.data;
}
