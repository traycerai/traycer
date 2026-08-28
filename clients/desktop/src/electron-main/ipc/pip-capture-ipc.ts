import type { IpcMainInvokeEvent } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { PipCaptureIpcPayload } from "../../ipc-contracts/pip-capture-types";
import type { BrowserViewManager } from "../browser-view/browser-view-manager";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import { browserViewIpcPayload } from "./browser-view-ipc-payload";

/**
 * Native-tab PiP capture IPC. Capture commands stay off the host CDP dispatch
 * path and go directly to `BrowserDebugSession`.
 */
export function registerPipCaptureIpc(
  bridge: RunnerIpcBridge,
  manager: BrowserViewManager,
): void {
  bridge.handleInvoke(
    RunnerHostInvoke.pipCaptureStart,
    async (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      const input = browserViewIpcPayload.pipCaptureStart.parse(payload);
      manager.pip.stop();
      const onFrame = (framePayload: PipCaptureIpcPayload): void => {
        bridge.safeSendToWindow(
          windowId,
          RunnerHostEvent.pipCaptureFrame,
          framePayload,
        );
      };
      const started = await manager.startPipCapture(windowId, input, onFrame);
      if (!started) {
        throw new Error(
          "Electron browser tab is not available for pip capture",
        );
      }
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.pipCaptureStop, () => {
    manager.pip.stop();
  });
}

function readSenderWindowId(
  bridge: RunnerIpcBridge,
  event: IpcMainInvokeEvent,
): string {
  const windowId = bridge.resolveSenderWindowId(event);
  if (windowId === null) {
    throw new Error("Pip capture IPC sender window is not registered");
  }
  return windowId;
}
