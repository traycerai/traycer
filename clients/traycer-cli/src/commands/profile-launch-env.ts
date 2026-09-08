import { spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";
import {
  providersResolveLaunchEnvRequestSchema,
  providersResolveLaunchEnvResponseSchema,
} from "@traycer/protocol/host/provider-profile-config-schemas";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { cliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer profile launch-env --provider <id> --profile <id> --exec -- <args…>`
 * (hidden, D23/D24). The sole body of the three per-profile launch wrappers
 * the host writes under `<profile>/bin/` - never a command a human types
 * directly, and refused on the readonly agent surface
 * (`READONLY_REFUSED_COMMANDS`) the same as `profile create`/`remove`/`test`/
 * `copy`.
 *
 * Asks the local host (D23: no `--host` flag exists on this CLI - `callHostRpc`
 * always resolves the local host's pid metadata) for the resolved spawn env
 * via `providers.resolveLaunchEnv`, then execs the returned `command` with the
 * caller's own trailing `<args…>` and the resolved env merged onto this
 * process's own. There is no mode that prints the resolved env: the whole
 * point of the `--exec` shape is that the credential it carries (D07's one
 * loopback exception, D24 amended) never reaches a shell history, a pipe, or
 * a captured stdout - only the child process's own environment block.
 */
export function buildProfileLaunchEnvCommand(opts: {
  readonly provider: string;
  readonly profile: string;
  readonly exec: boolean;
  readonly execArgs: readonly string[];
}): CommandFn {
  return async () => {
    if (!opts.exec) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "traycer: profile launch-env only supports --exec - there is no mode that prints the resolved environment.",
        details: null,
        exitCode: 1,
      });
    }
    const providerId = parseUserInput(providerIdSchema, opts.provider);
    const profileId = opts.profile.trim();
    if (profileId.length === 0) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: "traycer: profile launch-env requires --profile <id>.",
        details: null,
        exitCode: 1,
      });
    }
    const request = parseUserInput(providersResolveLaunchEnvRequestSchema, {
      providerId,
      profileId,
    });
    const result = await toAgentCliError(
      callHostRpc("providers.resolveLaunchEnv", request, null),
    );
    const response = parseCanonicalHostResponse(
      "providers.resolveLaunchEnv",
      providersResolveLaunchEnvResponseSchema,
      result,
    );

    // `process.env` is the base because `PATH`/`HOME` are load-bearing for
    // the exec - but spreading onto it resurrects the operator's own value
    // for every key the profile deliberately unset (a stray `GH_TOKEN` would
    // authenticate the wrapped CLI as the wrong identity). The host names
    // those keys; deleting them after the spread is the only thing that
    // makes an unset stick on this transport (D18, wave-5 review H7).
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...response.env };
    for (const key of response.unsetKeys) {
      delete childEnv[key];
    }

    const spawned = spawnSync(
      response.command,
      [...response.args, ...opts.execArgs],
      {
        stdio: "inherit",
        cwd: response.cwd ?? undefined,
        env: childEnv,
      },
    );
    if (spawned.error !== undefined) {
      throw cliError({
        code: CLI_ERROR_CODES.UNEXPECTED,
        message: `traycer: failed to launch the profile CLI: ${spawned.error.message}`,
        details: null,
        exitCode: 1,
      });
    }
    // A signalled child returns `status: null` with `signal` set. Collapsing
    // that to 1 makes a Ctrl-C'd CLI indistinguishable from an ordinary
    // failure to whatever script wraps the wrapper; 128+n is the shell's own
    // encoding for it (wave-5 review O8).
    const signal = spawned.signal ?? null;
    const exitCode =
      signal === null
        ? (spawned.status ?? 1)
        : 128 + (osConstants.signals[signal] ?? 0);
    return { data: { exitCode }, human: null, exitCode };
  };
}
