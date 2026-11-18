import { getEnvOverride } from "../store/config-store";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";

// Runner-aware `traycer config env get` (host-process scope). JSON mode
// emits exactly one terminal `result` event. Human mode prints just the value
// on stdout.
//
// Missing key is a structured error (`CONFIG_MISSING_KEY`, exit=1) so scripts
// and Desktop can switch on the code rather than parsing the human "(no
// override for …)" line.
export interface ConfigEnvGetArgs {
  readonly key: string;
}

export function buildConfigEnvGetCommand(args: ConfigEnvGetArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const value = await getEnvOverride(args.key);
    if (value === undefined) {
      throw cliError({
        code: CLI_ERROR_CODES.CONFIG_MISSING_KEY,
        message: `(no override for ${args.key})`,
        details: { key: args.key },
        exitCode: 1,
      });
    }
    return {
      data: { key: args.key, value },
      human: ctx.runtime.json ? null : (value ?? "<unset>"),
      exitCode: 0,
    };
  };
}
