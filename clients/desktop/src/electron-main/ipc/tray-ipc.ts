import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import { parseEpics, parseIndicator } from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

export function registerTrayIpc(bridge: RunnerIpcBridge): void {
  // Bridge the tray controller's epic-selected callback back through IPC
  // without giving the controller an `ipcMain` import.
  if (bridge.options.tray !== null) {
    bridge.options.tray.setEpicSelectedHandler((epicId) => {
      bridge.deliverTrayEpicSelected(epicId);
    });
  }

  bridge.handleInvoke(
    RunnerHostInvoke.traySetEpics,
    (_event, epics: unknown) => {
      if (bridge.options.tray === null) {
        return;
      }
      const parsed = parseEpics(epics);
      bridge.options.tray.setEpics(parsed);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traySetIndicator,
    (_event, state: unknown) => {
      if (bridge.options.tray === null) {
        return;
      }
      bridge.options.tray.setIndicator(parseIndicator(state));
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.hostPickerRequestOpen, () => {
    bridge.setHostPickerOpen(true);
  });
  bridge.handleInvoke(RunnerHostInvoke.hostPickerRequestClose, () => {
    bridge.setHostPickerOpen(false);
  });
}
