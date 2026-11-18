import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { deleteEnvOverride, getEnvOverride } from "../store/config-store";
import { writeConfigViaRunningHost } from "../internal/config-host-write";

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
    const existing = await getEnvOverride(args.key);
    let removed = false;
    if (existing !== undefined) {
      const response = await writeConfigViaRunningHost("config.env.delete", {
        key: args.key,
      });
      removed =
        response === null
          ? await deleteEnvOverride(args.key)
          : response.deleted;
    }
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
