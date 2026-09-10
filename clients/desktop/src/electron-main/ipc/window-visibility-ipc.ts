import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { IpcManagedWindow, RunnerIpcBridge } from "./runner-ipc-bridge";

/**
 * Whether a window is on screen at all, as MAIN sees it: shown and not
 * minimised. Renderer parking needs this from main because the renderer's own
 * Page Visibility API cannot supply it here. Every GUI window is created with
 * `backgroundThrottling: false` (`windows/window-factory.ts`, for the WebRTC
 * receiver), and Electron documents that setting as keeping
 * `document.visibilityState` at `"visible"` through minimise, hide and
 * occlusion alike. So the signal this app can actually observe is the
 * BrowserWindow's own `minimize` / `restore` / `show` / `hide` transitions,
 * which the window registry already relays as `geometry` and `change`.
 *
 * Occlusion (a window fully covered by another app's) is NOT detected on any
 * platform; a covered window keeps its epics resident, which is the pre-existing
 * cost of the throttling choice and is accepted.
 *
 * `isMinimized` is optional on {@link IpcManagedWindow} so test doubles need
 * not model it; absent, the window counts as not minimised, which fails toward
 * NOT parking.
 */
export function windowOnScreen(window: IpcManagedWindow): boolean {
  if (window.isDestroyed()) return false;
  const minimised = window.isMinimized?.() ?? false;
  return window.isVisible() && !minimised;
}

/**
 * One invoke in - a window asking about ITSELF - and one event out, sent to
 * each window about itself only. Nothing cross-window: what other windows show
 * travels on `epicVisibility`, and a hidden window withdraws its claim there
 * by reporting the empty set once the renderer learns it is hidden through
 * this channel.
 */
export function registerWindowVisibilityIpc(bridge: RunnerIpcBridge): void {
  // The startup read. `replayCurrentStateToWindow` also pushes this on the
  // preload's synchronous `windowId` read, before any renderer effect has
  // subscribed, so the renderer's install reads it explicitly - the same
  // reason `epicVisibility` and `ownership` carry a `snapshot()`.
  bridge.handleInvoke(RunnerHostInvoke.windowVisibilitySnapshot, (event) => {
    const windowId = bridge.resolveSenderWindowId(event);
    const record =
      windowId === null ? null : bridge.windowRegistry.getRecordById(windowId);
    // An unattributable sender is answered "visible": the cost of a wrong
    // "visible" is a deferred reclaim, the cost of a wrong "hidden" is a park
    // of something the user is looking at.
    return record === null ? true : windowOnScreen(record.window);
  });

  // The registry's `geometry` (minimize/restore/(un)maximize) and `change`
  // (show/hide, among others) events carry no window id, so every event
  // re-derives each window's answer and sends only the ones that moved. The
  // per-window memo is what keeps a maximize, a focus or a title change from
  // becoming an event in the renderer. A window with no memo entry counts as
  // `true`, which is the renderer's own default until told otherwise, so a
  // window that has never left the screen is never told anything.
  const lastSent = new Map<string, boolean>();
  const publish = (): void => {
    const live = new Set<string>();
    for (const record of bridge.windowRegistry.records()) {
      live.add(record.windowId);
      const onScreen = windowOnScreen(record.window);
      if ((lastSent.get(record.windowId) ?? true) === onScreen) continue;
      lastSent.set(record.windowId, onScreen);
      bridge.safeSendToWindow(
        record.windowId,
        RunnerHostEvent.windowVisibilityChange,
        onScreen,
      );
    }
    for (const windowId of Array.from(lastSent.keys())) {
      if (!live.has(windowId)) lastSent.delete(windowId);
    }
  };
  bridge.windowRegistry.on("geometry", publish);
  bridge.windowRegistry.on("change", publish);
  bridge.disposeFns.push(() => {
    bridge.windowRegistry.off("geometry", publish);
    bridge.windowRegistry.off("change", publish);
    lastSent.clear();
  });
}
