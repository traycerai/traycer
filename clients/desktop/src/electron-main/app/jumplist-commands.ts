import { app } from "electron";
import type { MenuCommandId } from "../../ipc-contracts/window-types";
import { log } from "./logger";

/**
 * Maps the argv a Windows jump-list task launches with (see
 * `installWindowsJumplistTasks` in recent-documents.ts) to the command it
 * stands for. The launch always lands in the primary instance as
 * `second-instance` argv - the single-instance lock quits the freshly
 * launched process before it runs any startup - so the flags must be
 * interpreted here, in the surviving instance.
 */
export function findJumplistCommandInArgv(
  argv: readonly string[],
): MenuCommandId | null {
  if (argv.includes("--new-epic")) return "epic.newWindow";
  if (argv.includes("--open-settings")) return "app.openSettings";
  return null;
}

export interface JumplistCommandSink {
  dispatch(command: MenuCommandId): void;
  focusMainWindow(): void;
}

/**
 * Handles relaunches of an already-running app. Every second launch surfaces
 * the main window first - jump-list tasks, deep links, and plain
 * double-launches all mean "bring Traycer forward" - then a recognized
 * jump-list flag dispatches its command. Cold-start flags are handled by the
 * startup orchestrator instead: the second-instance event never fires for
 * the first launch.
 */
export function registerJumplistCommandHandling(
  sink: JumplistCommandSink,
): void {
  app.on("second-instance", (_event, argv) => {
    sink.focusMainWindow();
    const command = findJumplistCommandInArgv(argv);
    if (command !== null) {
      log.info("[jumplist] dispatching second-instance command", { command });
      sink.dispatch(command);
    }
  });
}
