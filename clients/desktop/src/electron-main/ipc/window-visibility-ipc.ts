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
 * What each window's renderer was last TOLD about itself, by any route: the
 * snapshot invoke, the startup replay, or a change event. The channel sends a
 * window an event only when the answer differs from this, so a maximize, a
 * focus or a title change (all of which reach the registry's events) is not
 * an edge in the renderer.
 *
 * Keyed on what was TOLD, not on what was last derived, and that distinction
 * is the whole point. An earlier cut memoised only what `publish` had sent and
 * treated an absent entry as the renderer's default (`true`). That premise
 * fails once the snapshot or the replay has said `false`: a window registered
 * `show: false` before the bridge installs, answered `false` at startup and
 * shown afterwards derived `true`, matched the absent-entry default, and was
 * never told - its renderer kept `false` and parked the epic on screen.
 *
 * An absent entry still reads as `true`, because that IS the renderer's
 * default until something here tells it otherwise, and every route that tells
 * it records what it said.
 */
export class WindowVisibilityTold {
  private readonly byWindowId = new Map<string, boolean>();

  lastTold(windowId: string): boolean {
    return this.byWindowId.get(windowId) ?? true;
  }

  record(windowId: string, onScreen: boolean): void {
    this.byWindowId.set(windowId, onScreen);
  }

  forgetAllExcept(live: ReadonlySet<string>): void {
    for (const windowId of Array.from(this.byWindowId.keys())) {
      if (!live.has(windowId)) this.byWindowId.delete(windowId);
    }
  }

  clear(): void {
    this.byWindowId.clear();
  }
}

/**
 * One invoke in - a window asking about ITSELF - and one event out, sent to
 * each window about itself only. Nothing cross-window: what other windows show
 * travels on `epicVisibility`, and a hidden window withdraws its claim there
 * by reporting the empty set once the renderer learns it is hidden through
 * this channel.
 */
export function registerWindowVisibilityIpc(bridge: RunnerIpcBridge): void {
  const told = bridge.windowVisibilityTold;
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
    if (windowId === null || record === null) return true;
    const onScreen = windowOnScreen(record.window);
    told.record(windowId, onScreen);
    return onScreen;
  });

  // The registry's `geometry` (minimize/restore/(un)maximize) and `change`
  // (show/hide, among others) events carry no window id, so every event
  // re-derives each window's answer and sends only the ones whose answer
  // differs from what that window was last told.
  const publish = (): void => {
    const live = new Set<string>();
    for (const record of bridge.windowRegistry.records()) {
      live.add(record.windowId);
      const onScreen = windowOnScreen(record.window);
      if (told.lastTold(record.windowId) === onScreen) continue;
      if (
        bridge.safeSendToWindow(
          record.windowId,
          RunnerHostEvent.windowVisibilityChange,
          onScreen,
        )
      ) {
        told.record(record.windowId, onScreen);
      }
    }
    told.forgetAllExcept(live);
  };
  bridge.windowRegistry.on("geometry", publish);
  bridge.windowRegistry.on("change", publish);
  bridge.disposeFns.push(() => {
    bridge.windowRegistry.off("geometry", publish);
    bridge.windowRegistry.off("change", publish);
    told.clear();
  });
}
