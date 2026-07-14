import { isAbsolute } from "node:path";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { addShell, probeShellPath } from "../store/config-store";

// Runner-aware `traycer config shell add`. Unlike the permissive
// `config shell set` (absolute-path-only), `add` is the picker's gated
// entry point: the path must be absolute AND point at something that exists
// and is executable, otherwise it fails with a config-invalid-value error so
// junk never joins the remembered list. On success it records the program as a
// `shell.entries` launch spec (family-default flags) and selects it in one
// write. JSON mode emits the persisted shape; human mode prints a one-line
// confirmation.
export function buildConfigShellAddCommand(args: {
  readonly path: string;
}): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    if (!isAbsolute(args.path)) {
      throw cliError({
        code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
        message: `config shell add: --path must be an absolute path (got '${args.path}')`,
        details: null,
        exitCode: 1,
      });
    }
    const probe = await probeShellPath(args.path);
    if (!probe.exists || !probe.executable) {
      throw cliError({
        code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
        message: probe.exists
          ? `config shell add: '${args.path}' exists but is not executable`
          : `config shell add: '${args.path}' does not exist on this machine`,
        details: null,
        exitCode: 1,
      });
    }
    const next = await addShell(args.path);
    return {
      data: { path: next.path, entries: next.entries },
      human: ctx.runtime.json
        ? null
        : `shell added and selected (path=${next.path})`,
      exitCode: 0,
    };
  };
}
