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
  // race its own echo back into the renderer. A per-window Set (rather than a
  // single scalar) keeps suppression correct when two windows update at once.
  const suppressEchoWindowIds = new Set<string>();

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
      suppressEchoWindowIds.add(windowId);
      try {
        return await bridge.perWindowState.update(
          windowId,
          parsePerWindowStatePatch(patch),
        );
      } finally {
        suppressEchoWindowIds.delete(windowId);
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
    if (suppressEchoWindowIds.has(change.windowId)) return;
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
