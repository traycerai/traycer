/**
 * The bundled-CLI commands that take the hidden `--lifecycle-origin` flag:
 * every command Traycer Desktop runs that can START the host, plus `host stop`,
 * which is on the same invocation path, and `host uninstall`, which starts
 * nothing but refuses Desktop's Remove Traycer over a host a person started in
 * a terminal.
 *
 * ONE list, read by both sides, because Commander REJECTS an unknown option:
 *
 *  - Traycer Desktop appends `--lifecycle-origin desktop` to exactly these
 *    (`clients/desktop/.../host/lifecycle-origin-args.ts`). Appending it to any
 *    other command - `host download`, `host service uninstall`, a read
 *    command - makes that command fail at runtime.
 *  - The CLI registers the flag on exactly these, and checks its own
 *    registrations against this list every time it builds its program
 *    (`clients/traycer-cli/src/index.ts`). A command on the list without the
 *    flag would fail every Desktop call to it; a command with the flag and
 *    off the list would record Desktop's starts as `terminal`.
 *
 * Each entry is the command path under the root program, as typed.
 */
export const LIFECYCLE_ORIGIN_COMMANDS: readonly (readonly string[])[] = [
  ["host", "ensure"],
  ["host", "install"],
  ["host", "apply"],
  ["host", "service", "install"],
  ["host", "service", "start"],
  ["host", "restart"],
  ["host", "free-port-and-restart"],
  ["host", "stop"],
  ["host", "uninstall"],
];
