import { validateStoredCredentials } from "../auth/validate";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";

// Runner-aware `traycer whoami`. JSON mode emits exactly one terminal
// NDJSON `result` event; human mode prints a single line on stdout (or
// stderr for the network-error path) and the runner owns process.exit.
//
// Exit-code contract (matches the runner.ts "exitCode can be non-zero
// on a successful 'we did our job' result" example):
//   - no-credentials → result.ok, data.status="no-credentials", exit=1
//   - rejected       → result.ok, data.status="rejected",       exit=1
//   - valid          → result.ok, data.status="valid", ...,      exit=0
//   - network-error  → throws CliError(AUTH_NETWORK), exit=2 (true failure)
//
// Reason: callers want to discriminate "logged out / token rejected" from
// "could not reach authn" in scripts - the first two are stable states
// the user can act on; the network error is transient and behaves like
// every other transient CLI failure (NDJSON error envelope, non-zero
// exit, machine-readable code).
export const whoamiCommand: CommandFn = async (ctx): Promise<CommandResult> => {
  const result = await validateStoredCredentials();
  if (result.kind === "network-error") {
    throw cliError({
      code: CLI_ERROR_CODES.AUTH_NETWORK,
      message: "Could not reach the authn service; check your network.",
      details: null,
      exitCode: 2,
    });
  }
  if (result.kind === "no-credentials") {
    return {
      data: { status: "no-credentials" as const },
      human: ctx.runtime.json
        ? null
        : "Not logged in. Run `traycer login` to authenticate.",
      exitCode: 1,
    };
  }
  if (result.kind === "rejected") {
    return {
      data: { status: "rejected" as const },
      human: ctx.runtime.json
        ? null
        : "Stored credentials were rejected by the authn service. Run `traycer login` to re-authenticate.",
      exitCode: 1,
    };
  }
  const creds = result.credentials;
  return {
    data: {
      status: "valid" as const,
      user: creds.user,
      authnBaseUrl: creds.authnBaseUrl,
    },
    human: ctx.runtime.json
      ? null
      : `Logged in as ${creds.user.email || creds.user.name || creds.user.id}.`,
    exitCode: 0,
  };
};
