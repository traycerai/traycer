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
  // A window authors its own per-window state, so it already holds whatever it
  // just sent us. Echoing that write straight back to the same window is at best
  // redundant and at worst harmful: the echo is in flight for a while (the
  // renderer debounces outbound writes), so one that lands after a newer local
  // edit clobbers it - e.g. it resurrects a landing draft the window closed a
  // moment earlier, leaving a phantom "New" tab. While we apply a window's own
  // update we suppress the "change" push back to that window; MAIN-initiated
  // changes (initial restore, move-tab) carry no origin and still push normally.
  //
  // `PerWindowState.update` emits only after its disk write succeeds. Keep the
  // suppression entry through that await so the durable acknowledgement cannot
  // race its own echo back into the renderer.
  //
  // This is a per-window DEPTH, not a set of ids: a set entry is idempotent, so
  // two overlapping updates from the same window shared one entry and whichever
  // settled first deleted it - un-suppressing the other update's own echo while
  // it was still in flight, which is exactly the clobber this guard exists to
  // prevent. Counting keeps a window suppressed until its last in-flight update
  // has drained, and keeps windows independent of each other.
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
    // A `clear` is a window-teardown wipe. Never push its empty snapshot to a
    // renderer: for a genuinely-closed window the send would no-op anyway, but a
    // window that dropped from the registry snapshot while its BrowserWindow is
    // still alive (a reload / re-registration) would be clobbered with an empty
    // snapshot — wiping a live draft and, downstream, reaping its image bytes.
    // The durable delete still happened (genuine close cleanup is preserved); the
    // "Clear local app state" path reloads the window, so it needs no echo.
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
