import { isAbsolute } from "node:path";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { removeShell } from "../store/config-store";

// Runner-aware `traycer config shell remove`. Forgets a `shell.entries` launch
// spec; if it was the selected shell, the selection falls back to the
// synthesised OS default. Removing a path that was never remembered is a
// successful no-op. JSON mode emits the resulting shape; human mode prints a
// one-line confirmation.
export function buildConfigShellRemoveCommand(args: {
  readonly path: string;
}): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    // The remembered list only ever holds absolute paths, so a relative path
    // can never match one - reject it up front rather than silently no-op.
    if (!isAbsolute(args.path)) {
      throw cliError({
        code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
        message: `config shell remove: --path must be an absolute path (got '${args.path}')`,
        details: null,
        exitCode: 1,
      });
    }
    const next = await removeShell(args.path);
    return {
      data: { removed: next.removed, path: next.path },
      human: ctx.runtime.json
        ? null
        : next.removed
          ? `shell removed (${args.path})`
          : `shell not in the added list; nothing to remove (${args.path})`,
      exitCode: 0,
    };
  };
}
