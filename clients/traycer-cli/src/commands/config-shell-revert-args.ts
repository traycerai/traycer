import { isAbsolute } from "node:path";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { revertShellArgs } from "../store/config-store";

// Runner-aware `traycer config shell revert-args`. Restores a remembered shell's
// flags to its family default by clearing the entry's deviation (`args: null`)
// while keeping the entry - so the shell stays in the picker list. Reverting a
// path with no entry is a successful no-op. JSON mode emits the resulting shape;
// human mode prints a one-line confirmation.
export function buildConfigShellRevertArgsCommand(args: {
  readonly path: string;
}): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    // Entries only ever hold absolute paths, so a relative path can never match
    // one - reject it up front rather than silently no-op.
    if (!isAbsolute(args.path)) {
      throw cliError({
        code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
        message: `config shell revert-args: --path must be an absolute path (got '${args.path}')`,
        details: null,
        exitCode: 1,
      });
    }
    const next = await revertShellArgs(args.path);
    return {
      data: { path: next.path, reverted: next.reverted },
      human: ctx.runtime.json
        ? null
        : next.reverted
          ? `flags restored to default (${args.path})`
          : `no stored flags to restore (${args.path})`,
      exitCode: 0,
    };
  };
}
