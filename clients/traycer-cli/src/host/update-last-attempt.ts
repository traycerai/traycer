import type { HostUpdateAttemptOutcome } from "@traycer-clients/shared/host-update";
import { CLI_ERROR_CODES, CliError } from "../runner/errors";
import { isUnstartableServiceRefusal } from "./update-service-unstartable";

/**
 * The outcome a thrown run reports. `underway`: it had started the work it was
 * asked for, so a throw from there failed and did not merely refuse.
 */
export function outcomeOfThrow(
  err: unknown,
  underway: boolean,
): HostUpdateAttemptOutcome {
  // The host was verified at the target; only the attempt's own record could
  // not be concluded, and the next run does that.
  if (
    err instanceof CliError &&
    err.code === CLI_ERROR_CODES.HOST_UPDATE_RECORD_NOT_CONCLUDED
  ) {
    return "complete";
  }
  if (
    err instanceof CliError &&
    (isUnstartableServiceRefusal(err) || err.code === CLI_ERROR_CODES.HOST_BUSY)
  ) {
    return "parked";
  }
  return underway ? "failed" : "refused";
}

export function errorFacts(err: unknown): {
  readonly code: string | null;
  readonly message: string;
} {
  return err instanceof CliError
    ? { code: err.code, message: err.message }
    : { code: null, message: err instanceof Error ? err.message : String(err) };
}
