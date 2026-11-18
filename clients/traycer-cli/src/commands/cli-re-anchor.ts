import type { CommandFn, CommandResult } from "../runner/runner";
import { writeMarkSource } from "./cli-mark-source";

// `traycer cli re-anchor --binary-path <path> --installed-version <version>` -
// user-facing command for support paths where the operator manually
// moved or replaced the CLI binary and wants the system to start
// trusting that file as the active install. Always writes
// `source=manual`, never a package-manager source - passing a PM source
// here would lock the user out of `cli upgrade`.
//
// Distinct from `cli mark-source` (which is the hidden PM hook). The
// split prevents the upgrade-lockout footgun: a user running
// `cli mark-source --source homebrew --binary-path /usr/local/bin/traycer`
// on a manually-installed binary would silently route every future
// upgrade through `brew upgrade traycer`, which won't find the
// install.
export interface CliReAnchorArgs {
  readonly binaryPath: string;
  readonly version: string;
}

export function buildCliReAnchorCommand(args: CliReAnchorArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    return writeMarkSource({
      ctx,
      source: "manual",
      binaryPath: args.binaryPath,
      version: args.version,
      reason: "cli-re-anchor",
    });
  };
}
