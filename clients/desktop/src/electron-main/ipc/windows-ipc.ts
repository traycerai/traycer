import { dialog } from "electron";
import { config } from "../../config";
import { log } from "../app/logger";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
  RunnerHostSync,
} from "../../ipc-contracts/ipc-channels";
import type { OpenEpicInNewWindowResult } from "../../ipc-contracts/window-types";
import {
  assertString,
  buildEpicInitialRoute,
  parseInitialRoute,
  parseOptionalTitle,
} from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

export function registerWindowsIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(RunnerHostInvoke.workspaceFoldersPick, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "multiSelections", "createDirectory"],
    });
    return result.canceled ? [] : result.filePaths;
  });

  bridge.handleInvoke(RunnerHostInvoke.windowsList, () => {
    return bridge.windowRegistry.list();
  });

  bridge.handleInvoke(
    RunnerHostInvoke.windowsRequestNew,
    async (_event, initialRoute: unknown) => {
      await bridge.windowRegistry.create({
        initialRoute: parseInitialRoute(initialRoute),
        beforeLoad: null,
      });
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.windowsRequestFocus,
    (_event, windowId: unknown) => {
      assertString(windowId, "windows.requestFocus");
      bridge.windowRegistry.focusById(windowId);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.windowsRequestClose,
    async (_event, windowId: unknown) => {
      assertString(windowId, "windows.requestClose");
      await bridge.windowRegistry.closeById(windowId);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.windowsRequestOpenEpicInNewWindow,
    async (event, epicId: unknown, title: unknown, tabId: unknown) => {
      assertString(epicId, "windows.requestOpenEpicInNewWindow");
      assertString(tabId, "windows.requestOpenEpicInNewWindow");
      const sourceWindowId = bridge.resolveSenderWindowId(event);
      if (sourceWindowId === null) {
        log.warn(
          "[runner-ipc] requestOpenEpicInNewWindow from unknown window",
          {},
        );
        return { result: "queued-discard", windowId: "" };
      }
      return openEpicInNewWindow(
        bridge,
        sourceWindowId,
        epicId,
        parseOptionalTitle(title),
        tabId,
      );
    },
  );

  bridge.handleSync(
    RunnerHostSync.authnBaseUrl,
    () => bridge.options.authnBaseUrl,
  );
  // Empty string → renderer falls back to the compile-time custom-scheme
  // redirect (`DESKTOP_REDIRECT_URI`). A non-empty value is the dev loopback.
  bridge.handleSync(
    RunnerHostSync.authRedirectUri,
    () => bridge.options.authRedirectUri ?? "",
  );
  bridge.handleSync(RunnerHostSync.windowId, (event) => {
    const windowId = bridge.resolveSenderWindowId(event);
    if (windowId !== null) {
      bridge.replayCurrentStateToWindow(windowId);
    }
    return windowId;
  });
  bridge.handleSync(
    RunnerHostSync.sentryRendererDsn,
    () => config.sentryRendererDsn,
  );

  let liveWindowIds = new Set(
    bridge.windowRegistry.records().map((record) => record.windowId),
  );
  const onWindowRegistryChange = (): void => {
    const nextLiveWindowIds = new Set(
      bridge.windowRegistry.records().map((record) => record.windowId),
    );
    // Only a deliberate mid-session close (other windows still open, not
    // quitting) prunes the durable per-window restore snapshot. A close that is
    // really a quit/leave gesture must preserve it - see
    // `shouldPreserveClosedWindowSnapshot`.
    const preserveClosedSnapshots = shouldPreserveClosedWindowSnapshot({
      quitting: bridge.quitState.isQuitting(),
      remainingWindowCount: nextLiveWindowIds.size,
    });
    for (const windowId of liveWindowIds) {
      if (nextLiveWindowIds.has(windowId)) {
        continue;
      }
      // Ownership is regenerated from the restored window snapshots at startup
      // (`reconcileRestoredWindows`), so releasing it here is safe for restore
      // and keeps live-session ownership consistent with the closed window.
      bridge.ownership.releaseWindow(windowId);
      if (!preserveClosedSnapshots) {
        bridge.perWindowState.clear(windowId);
      }
    }
    liveWindowIds = nextLiveWindowIds;
    bridge.pruneClosedWindowState();
    bridge.fanOut(RunnerHostEvent.windowsChange, bridge.windowRegistry.list());
    bridge.flushPendingAuthReturnSignal();
  };
  bridge.windowRegistry.on("change", onWindowRegistryChange);
  bridge.disposeFns.push(() => {
    bridge.windowRegistry.off("change", onWindowRegistryChange);
  });

  bridge.fanOut(RunnerHostEvent.windowsChange, bridge.windowRegistry.list());
}

/**
 * Decides whether a window that just vanished from the registry should KEEP its
 * durable per-window restore snapshot (open epic tabs, pane layout, drafts).
 *
 * Preserve when the close is really a quit/leave gesture:
 *  - `quitting` - the shell has begun quitting (Cmd+Q / "Quit Traycer" / the
 *    auto-update install re-quit). During quit no close should destroy state,
 *    so ALL closing windows are preserved regardless of how many remain.
 *  - `remainingWindowCount === 0` - this was the last remaining window. On
 *    Win/Linux the native `closed` event (and this listener) fire BEFORE
 *    `window-all-closed` -> `app.quit()` -> `before-quit`, so the `quitting`
 *    flag is not yet set on that path; the last-window check covers the race.
 *    On macOS a red-light close of the last window keeps the app alive, and the
 *    snapshot must survive so a later quit -> relaunch, or a dock `activate`,
 *    restores it.
 *
 * Prune only a deliberate mid-session close: another window is still open and
 * the shell is not quitting, so relaunch must not resurrect the closed window.
 */
export function shouldPreserveClosedWindowSnapshot(input: {
  readonly quitting: boolean;
  readonly remainingWindowCount: number;
}): boolean {
  return input.quitting || input.remainingWindowCount === 0;
}

async function openEpicInNewWindow(
  bridge: RunnerIpcBridge,
  sourceWindowId: string,
  epicId: string,
  title: string,
  tabId: string,
): Promise<OpenEpicInNewWindowResult> {
  const currentOwner = bridge.ownership.getOwner(tabId);
  if (currentOwner !== null && currentOwner !== sourceWindowId) {
    if (bridge.windowRegistry.focusById(currentOwner)) {
      return { result: "focused", windowId: currentOwner };
    }
    bridge.ownership.release(tabId, currentOwner);
  }

  const sourceSnapshot = bridge.perWindowState.get(sourceWindowId);
  const sourceTab = sourceSnapshot.epicTabs.find((tab) => tab.id === tabId);
  const movedTabId = sourceTab?.id ?? tabId;
  const destinationTab = {
    id: movedTabId,
    epicId,
    name: sourceTab?.name ?? title,
  };
  const destinationCanvas = sourceSnapshot.canvasByTabId[movedTabId];
  const remainingTabs = sourceSnapshot.epicTabs.filter(
    (tab) => tab.id !== movedTabId,
  );
  const sourceActiveTabId = sourceSnapshot.activeTabId;
  const nextSourceActiveTabId =
    sourceActiveTabId === movedTabId
      ? (remainingTabs[remainingTabs.length - 1]?.id ?? null)
      : sourceActiveTabId;

  const destination = { windowId: null as string | null };
  let destinationWindowId: string;
  try {
    destinationWindowId = await bridge.windowRegistry.create({
      initialRoute: buildEpicInitialRoute(epicId, movedTabId),
      beforeLoad: (windowId) => {
        destination.windowId = windowId;
        if (currentOwner === sourceWindowId) {
          bridge.ownership.transfer(movedTabId, sourceWindowId, windowId);
        } else {
          bridge.ownership.claim(movedTabId, epicId, windowId);
        }
        bridge.perWindowState.update(windowId, {
          epicTabs: [destinationTab],
          activeTabId: movedTabId,
          canvasByTabId:
            destinationCanvas === undefined
              ? {}
              : { [movedTabId]: destinationCanvas },
          landingDrafts: [],
          activeLandingDraftId: null,
        });
      },
    });
  } catch (err) {
    await rollbackFailedEpicMove(
      bridge,
      movedTabId,
      sourceWindowId,
      currentOwner,
      destination.windowId,
    );
    throw err;
  }

  bridge.perWindowState.update(sourceWindowId, {
    epicTabs: remainingTabs,
    activeTabId: nextSourceActiveTabId,
    canvasByTabId: { [movedTabId]: null },
  });
  bridge.windowRegistry.focusById(destinationWindowId);
  return { result: "moved", windowId: destinationWindowId };
}

async function rollbackFailedEpicMove(
  bridge: RunnerIpcBridge,
  tabId: string,
  sourceWindowId: string,
  previousOwner: string | null,
  destinationWindowId: string | null,
): Promise<void> {
  if (destinationWindowId === null) return;
  if (bridge.ownership.getOwner(tabId) === destinationWindowId) {
    if (previousOwner === sourceWindowId) {
      bridge.ownership.transfer(tabId, destinationWindowId, sourceWindowId);
    } else {
      bridge.ownership.release(tabId, destinationWindowId);
    }
  }
  bridge.perWindowState.clear(destinationWindowId);
  await bridge.windowRegistry.forceCloseById(destinationWindowId);
}
