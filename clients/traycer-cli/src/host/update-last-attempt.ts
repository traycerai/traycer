import type { HostUpdateAttemptOutcome } from "@traycer-clients/shared/host-update";
import { HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE } from "@traycer/protocol/host/lifecycle-constants";
import { CLI_ERROR_CODES, CliError } from "../runner/errors";

/**
 * The outcome a thrown run reports. `disturbed`: it had reached work that
 * changes the host, so a throw from there failed and did not merely refuse.
 */
export function outcomeOfThrow(
  err: unknown,
  disturbed: boolean,
): HostUpdateAttemptOutcome {
  if (
    err instanceof CliError &&
    (err.exitCode === HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE ||
      err.code === CLI_ERROR_CODES.HOST_BUSY)
  ) {
    return "parked";
  }
  return disturbed ? "failed" : "refused";
}

export function errorFacts(err: unknown): {
  readonly code: string | null;
  readonly message: string;
} {
  return err instanceof CliError
    ? { code: err.code, message: err.message }
    : { code: null, message: err instanceof Error ? err.message : String(err) };
}
