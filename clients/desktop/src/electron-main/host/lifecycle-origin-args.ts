/**
 * The bundled-CLI commands that can START the host, and so take the hidden
 * `--lifecycle-origin` flag the CLI (T03) carries into its adoption proof.
 *
 * EXACTLY these eight, and never the rest. The CLI registers the flag on
 * these commands only, and Commander REJECTS an unknown option: passing it to
 * `host download`, `host uninstall`, `host service uninstall`,
 * `host update-verify`, `host stamp-runtime`, `host purge-stage` or any read
 * command would make that command fail at runtime - a failure a mocked-CLI
 * suite cannot see, which is why the set is pinned by its own test over the
 * spawner's arguments.
 */
export const DESKTOP_LIFECYCLE_ORIGIN_COMMANDS: readonly (readonly string[])[] =
  [
    ["host", "ensure"],
    ["host", "install"],
    ["host", "apply"],
    ["host", "service", "install"],
    ["host", "service", "start"],
    ["host", "restart"],
    ["host", "free-port-and-restart"],
    ["host", "stop"],
  ];

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
