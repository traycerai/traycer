import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { setEnvOverride } from "../store/config-store";

// Runner-aware `traycer config env set --key KEY --value VAL`.
// Sets a host-process env override (harness-scoped env now lives per-provider in the host's provider-overrides, set over the `providers.*` RPC).
export interface ConfigEnvSetArgs {
  readonly key: string;
  readonly value: string;
}

const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildConfigEnvSetCommand(args: ConfigEnvSetArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    if (!VALID_KEY.test(args.key)) {
      throw cliError({
        code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
        message: `config env set: invalid key '${args.key}'. Keys must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
        details: { key: args.key },
        exitCode: 1,
      });
    }
    await setEnvOverride(args.key, args.value);
    return {
      data: { key: args.key, value: args.value },
      human: ctx.runtime.json ? null : `${args.key}=${args.value}`,
      exitCode: 0,
    };
  };
}
