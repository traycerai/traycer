import { LIFECYCLE_ORIGIN_COMMANDS } from "@traycer/protocol/config/lifecycle-origin-commands";

/**
 * The bundled-CLI commands that can START the host, and so take the hidden
 * `--lifecycle-origin` flag the CLI carries into its adoption proof -
 * plus `host uninstall`, which starts nothing but refuses the desktop's
 * Remove Traycer over a host a person started in a terminal.
 *
 * EXACTLY the protocol's list, and never the rest: the CLI registers the flag
 * on those commands only and checks its registrations against the same list,
 * and Commander REJECTS an unknown option - passing it to `host download`,
 * `host service uninstall`, `host update-verify`, `host stamp-runtime`,
 * `host purge-stage` or any read command would make that command fail at
 * runtime.
 */
export const DESKTOP_LIFECYCLE_ORIGIN_COMMANDS: readonly (readonly string[])[] =
  LIFECYCLE_ORIGIN_COMMANDS;

const LIFECYCLE_ORIGIN_FLAG = "--lifecycle-origin";

function startsWithCommand(
  args: readonly string[],
  command: readonly string[],
): boolean {
  return command.every((word, index) => args[index] === word);
}

/**
 * `args` with `--lifecycle-origin desktop` appended when they name one of
 * {@link DESKTOP_LIFECYCLE_ORIGIN_COMMANDS}, and unchanged otherwise (or when
 * the caller already passed an origin). Applied once, at the controller's
 * single CLI choke point, so no call site can forget it or add it where the
 * CLI would refuse it.
 */
export function withDesktopLifecycleOrigin(
  args: readonly string[],
): readonly string[] {
  if (args.includes(LIFECYCLE_ORIGIN_FLAG)) return args;
  const startCapable = DESKTOP_LIFECYCLE_ORIGIN_COMMANDS.some((command) =>
    startsWithCommand(args, command),
  );
  return startCapable ? [...args, LIFECYCLE_ORIGIN_FLAG, "desktop"] : args;
}
