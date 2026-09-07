import { app } from "electron";
import type { MenuCommandId } from "../../ipc-contracts/window-types";
import { log } from "./logger";

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

/** Cold-start flags are handled by the startup orchestrator instead: the second-instance event never fires for the first launch. */
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
