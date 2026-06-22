import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { deleteEnvOverride } from "../store/config-store";

// Runner-aware `traycer config env delete --key KEY` (host-process scope).
// JSON mode emits a single terminal `result` event; human mode prints
// `deleted KEY` on success. Deleting an absent key is a `CONFIG_MISSING_KEY`
// error so callers can disambiguate it from a successful delete.
export interface ConfigEnvDeleteArgs {
  readonly key: string;
}

export function buildConfigEnvDeleteCommand(
  args: ConfigEnvDeleteArgs,
): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const removed = await deleteEnvOverride(args.key);
    if (!removed) {
      throw cliError({
        code: CLI_ERROR_CODES.CONFIG_MISSING_KEY,
        message: `(no override for ${args.key})`,
        details: { key: args.key },
        exitCode: 1,
      });
    }
    return {
      data: { key: args.key, deleted: true },
      human: ctx.runtime.json ? null : `deleted ${args.key}`,
      exitCode: 0,
    };
  };
}
