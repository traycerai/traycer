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
  // `PerWindowState.update` emits "change" synchronously, so the listener below
  // observes this set within the same call and the `finally` clears the entry
  // before control returns. A per-window Set (rather than a single scalar)
  // keeps suppression correct if two windows' updates ever interleave - e.g. if
  // `update` becomes async - without one window clobbering another's flag.
  const suppressEchoWindowIds = new Set<string>();

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
      suppressEchoWindowIds.add(windowId);
      try {
        bridge.perWindowState.update(windowId, parsePerWindowStatePatch(patch));
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
