import { isAbsolute } from "node:path";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { setShell } from "../store/config-store";

// Runner-aware `traycer config shell set`. The entrypoint validates the
// `--clear-args` / positional-args conflict, leaving the command body to
// route a fully-resolved (path, args) pair into the store. JSON mode
// emits a single terminal `result` event whose `data` is the persisted
// shape; human mode prints a one-line confirmation.
export interface ConfigShellSetArgs {
  readonly path: string | null;
  readonly args: readonly string[] | null;
}

export function buildConfigShellSetCommand(
  args: ConfigShellSetArgs,
): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    if (args.path === null && args.args === null) {
      throw cliError({
        code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
        message:
          "config shell set: pass --path, args after `--`, or --clear-args",
        details: null,
        exitCode: 1,
      });
    }
    // The help promises an absolute shell-binary path; enforce it so the
    // stored value matches the contract (a relative path would resolve
    // against the host's cwd at bootstrap, not the user's).
    if (args.path !== null && !isAbsolute(args.path)) {
      throw cliError({
        code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
        message: `config shell set: --path must be an absolute path (got '${args.path}')`,
        details: null,
        exitCode: 1,
      });
    }
    const next = await setShell(args.path, args.args);
    return {
      data: { path: next.path, args: next.args },
      human: ctx.runtime.json
        ? null
        : `shell config saved (path=${next.path ?? "<default>"}, args=${
            next.args !== null ? JSON.stringify(next.args) : "<default>"
          })`,
      exitCode: 0,
    };
  };
}
