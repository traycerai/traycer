import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

/**
 * The host's refusals of a person's standing, and authn's as the app's own
 * reads code them (`HOST_CODE_OF`): 401 `UNAUTHORIZED`, a seated person's role
 * refused 403 `E_ROLE_FORBIDDEN`, an environment not theirs to read 404
 * `NOT_FOUND`. A malformed request (`E_INVALID_ARGUMENT`) is none of these.
 */
const AUTHORITY_REFUSALS = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "E_ROLE_FORBIDDEN",
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
