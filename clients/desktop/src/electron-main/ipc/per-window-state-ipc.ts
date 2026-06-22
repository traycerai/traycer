import { log } from "../app/logger";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import {
  createEmptyPerWindowSnapshot,
  type PerWindowStateChange,
} from "../windows/per-window-state";
import { parsePerWindowStatePatch } from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

export function registerPerWindowStateIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(RunnerHostInvoke.perWindowStateGet, (event) => {
    const windowId = bridge.resolveSenderWindowId(event);
    return windowId === null
      ? createEmptyPerWindowSnapshot()
      : bridge.perWindowState.get(windowId);
  });

  bridge.handleInvoke(
    RunnerHostInvoke.perWindowStateUpdate,
    (event, patch: unknown) => {
      const windowId = bridge.resolveSenderWindowId(event);
      if (windowId === null) {
        log.warn("[runner-ipc] perWindowState.update from unknown window", {});
        return;
      }
      bridge.perWindowState.update(windowId, parsePerWindowStatePatch(patch));
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.perWindowStateClear, (event) => {
    const windowId = bridge.resolveSenderWindowId(event);
    if (windowId === null) {
      log.warn("[runner-ipc] perWindowState.clear from unknown window", {});
      return;
    }
    bridge.perWindowState.clear(windowId);
  });

  const onPerWindowStateChange = (change: PerWindowStateChange): void => {
    bridge.safeSendToWindow(
      change.windowId,
      RunnerHostEvent.perWindowStateChange,
      change.snapshot,
    );
  };
  bridge.perWindowState.on("change", onPerWindowStateChange);
  bridge.disposeFns.push(() => {
    bridge.perWindowState.off("change", onPerWindowStateChange);
  });
}
