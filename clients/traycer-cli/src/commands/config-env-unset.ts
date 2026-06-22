import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { setEnvOverride } from "../store/config-store";

// Runner-aware `traycer config env unset --key KEY`. Records an explicit
// removal of a host-process env var, distinct from `delete` which removes
// the config row entirely.
export interface ConfigEnvUnsetArgs {
  readonly key: string;
}

const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildConfigEnvUnsetCommand(
  args: ConfigEnvUnsetArgs,
): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    if (!VALID_KEY.test(args.key)) {
      throw cliError({
        code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
        message: `config env unset: invalid key '${args.key}'. Keys must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
        details: { key: args.key },
        exitCode: 1,
      });
    }
    await setEnvOverride(args.key, null);
    return {
      data: { key: args.key, value: null },
      human: ctx.runtime.json ? null : `unset ${args.key}`,
      exitCode: 0,
    };
  };
}
