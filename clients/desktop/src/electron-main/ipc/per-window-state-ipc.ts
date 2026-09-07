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
  // Keep the suppression entry through that await so the durable acknowledgement cannot race its own echo back into the renderer.
  const echoSuppressionDepth = new Map<string, number>();
  const beginEchoSuppression = (windowId: string): void => {
    echoSuppressionDepth.set(
      windowId,
      (echoSuppressionDepth.get(windowId) ?? 0) + 1,
    );
  };
  const endEchoSuppression = (windowId: string): void => {
    const depth = echoSuppressionDepth.get(windowId);
    if (depth === undefined) return;
    if (depth <= 1) {
      echoSuppressionDepth.delete(windowId);
      return;
    }
    echoSuppressionDepth.set(windowId, depth - 1);
  };

  bridge.handleInvoke(RunnerHostInvoke.perWindowStateGet, (event) => {
    const windowId = bridge.resolveSenderWindowId(event);
    return windowId === null
      ? createEmptyPerWindowSnapshot()
      : bridge.perWindowState.get(windowId);
  });

  bridge.handleInvoke(RunnerHostInvoke.perWindowStateCapabilities, () =>
    bridge.perWindowState.capabilities(),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.perWindowStateUpdate,
    async (event, patch: unknown) => {
      const windowId = bridge.resolveSenderWindowId(event);
      if (windowId === null) {
        log.warn("[runner-ipc] perWindowState.update from unknown window", {});
        return;
      }
      beginEchoSuppression(windowId);
      try {
        return await bridge.perWindowState.update(
          windowId,
          parsePerWindowStatePatch(patch),
        );
      } finally {
        endEchoSuppression(windowId);
      }
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
    // Don't bounce a window's own update back to it (see suppress note above).
    if (echoSuppressionDepth.has(change.windowId)) return;
    // Never push its empty snapshot to a renderer: for a genuinely-closed window the send would no-op anyway, but a window that dropped from the registry snapshot while its.
    if (change.origin === "clear") return;
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
