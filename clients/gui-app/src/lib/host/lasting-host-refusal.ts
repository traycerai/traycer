import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

/**
 * A refusal only a change elsewhere can mend, by what mends it: the person
 * signing in again (`signed-out`), being given access (`access-refused`), or
 * the host itself changing (`cannot-serve`). Asking again at once gets the
 * same answer.
 */
export type LastingHostRefusal =
  | "signed-out"
  | "access-refused"
  | "cannot-serve";

/**
 * The lasting refusal `error` is, or `null` for any other failure. An
 * `UNAUTHORIZED` the host marks retryable is its own passing trouble (the
 * bearer is fine), not a sign-in the person has lost; one the auth layer
 * could not recover by revalidating is.
 */
export function lastingHostRefusal(error: unknown): LastingHostRefusal | null {
  if (!(error instanceof HostRpcError)) return null;
  switch (error.code) {
    case "UNAUTHORIZED":
      return error.fatalDetails?.retryable === true ? null : "signed-out";
    case "FORBIDDEN":
    case "VERB_NOT_ALLOWED":
      return "access-refused";
    case "E_HOST_UNSUPPORTED":
    case "DOWNGRADE_UNSUPPORTED":
    case "INCOMPATIBLE":
    case "E_CLOUD_CREDENTIAL_WITHDRAWN":
      return "cannot-serve";
    default:
      return null;
  }
}
