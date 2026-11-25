import { movedTabLayout } from "../windows/moved-tab-layout";
import { dialog } from "electron";
import { config } from "../../config";
import { log } from "../app/logger";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
  RunnerHostSync,
} from "../../ipc-contracts/ipc-channels";
import { parseWindowDraftMove } from "../../ipc-contracts/window-state-parsers";
import type {
  MoveWindowDraftReferenceRequest,
  MoveWindowDraftReferenceResult,
  OpenDraftInNewWindowResult,
  OpenEpicInNewWindowResult,
  PerWindowEpicViewTab,
} from "../../ipc-contracts/window-types";
import {
  assertString,
  buildDraftInitialRoute,
  buildEpicInitialRoute,
  parseInitialRoute,
  parseOptionalTitle,
} from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

type DraftDestinationStatus = "presented" | "unavailable" | "retired";

interface DraftDestinationLoad {
  readonly request: MoveWindowDraftReferenceRequest;
  attempt: Promise<DraftDestinationStatus> | null;
}

export function registerWindowsIpc(bridge: RunnerIpcBridge): void {
  const destinationLoads = new Map<string, DraftDestinationLoad>();
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
    async (_event, windowId: unknown) => {
      assertString(windowId, "windows.requestFocus");
      const pending = destinationLoads.get(windowId);
      if (pending !== undefined) {
        await presentDraftDestination(
          bridge,
          destinationLoads,
          windowId,
          pending.request,
        );
      } else {
        bridge.windowRegistry.focusById(windowId);
      }
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

  bridge.handleInvoke(
    RunnerHostInvoke.windowsRequestOpenDraftInNewWindow,
    async (event, draftId: unknown) => {
      assertString(draftId, "windows.requestOpenDraftInNewWindow");
      const sourceWindowId = bridge.resolveSenderWindowId(event);
      if (sourceWindowId === null) {
        log.warn(
          "[runner-ipc] requestOpenDraftInNewWindow from unknown window",
          {},
        );
        return { result: "not-found", windowId: "" };
      }
      return openDraftInNewWindow(bridge, sourceWindowId, draftId);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.windowsMoveDraftReference,
    async (event, value: unknown): Promise<MoveWindowDraftReferenceResult> => {
      const request = parseWindowDraftMove(value);
      const sourceWindowId = bridge.resolveSenderWindowId(event);
      if (request === null || sourceWindowId === null) {
        return { result: "conflict" };
      }
      const { perWindowState, windowRegistry } = bridge;
      const { createWithId, loadById } = windowRegistry;
      if (
        perWindowState.moveDraftReference === undefined ||
        createWithId === undefined ||
        loadById === undefined
      ) {
        return { result: "unavailable" };
      }

      const route = buildDraftInitialRoute(request.ref.slotId);
      const result = await perWindowState.moveDraftReference(
        sourceWindowId,
        request,
        route,
      );
      if (result.result === "moved") {
        const presentation = await presentDraftDestination(
          bridge,
          destinationLoads,
          result.destinationWindowId,
          request,
        );
        if (presentation === "unavailable") {
          return { ...result, destinationLoadFailed: true };
        }
      }
      return result;
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
      destinationLoads.delete(windowId);
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
  const destinationTab: PerWindowEpicViewTab = {
    id: movedTabId,
    epicId,
    name: sourceTab?.name ?? title,
    // A tab keeps the surface it was moved on. Dropping `surfaceMode` here
    // restored a pending phase-migration tab as the normal Epic surface in the
    // destination window. Older snapshots legitimately omit the field, so it is
    // carried only when the source actually had one.
    ...(sourceTab?.surfaceMode === undefined
      ? {}
      : { surfaceMode: sourceTab.surfaceMode }),
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
      beforeLoad: async (windowId) => {
        destination.windowId = windowId;
        if (currentOwner === sourceWindowId) {
          bridge.ownership.transfer(movedTabId, sourceWindowId, windowId);
        } else {
          bridge.ownership.claim(movedTabId, epicId, windowId);
        }
        await bridge.perWindowState.update(windowId, {
          epicTabs: [destinationTab],
          activeTabId: movedTabId,
          tabStripLayout: movedTabLayout(
            sourceSnapshot.tabStripLayout,
            "epic",
            movedTabId,
          ),
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

  // The destination has loaded. A source cleanup failure must not reject the
  // already-presented move.
  void Promise.resolve()
    .then(() =>
      bridge.perWindowState.update(sourceWindowId, {
        epicTabs: remainingTabs,
        activeTabId: nextSourceActiveTabId,
        canvasByTabId: { [movedTabId]: null },
      }),
    )
    .catch((error: unknown) => {
      log.warn("[windows-ipc] source move state persistence failed", {
        windowId: sourceWindowId,
        error,
      });
    });
  bridge.windowRegistry.focusById(destinationWindowId);
  return { result: "moved", windowId: destinationWindowId };
}

/**
 * Move a draft on the legacy per-window payload path. Its record (content is
 * hash-only editor JSON) still lives in the window snapshot. The
 * destination is seeded with it in `beforeLoad`, before its renderer loads.
 * The draft's image BYTES do not travel here: they live in a per-window
 * IndexedDB partition the main process cannot reach, so the renderer stages
 * them in a handoff DB before invoking this (see `landing-image-move.ts`).
 *
 * The source snapshot is trusted as current because the renderer flushes its
 * per-window projection before invoking this - the same barrier the epic move
 * uses. A draft absent from the flushed snapshot is a refused move, never a
 * guess.
 */
async function openDraftInNewWindow(
  bridge: RunnerIpcBridge,
  sourceWindowId: string,
  draftId: string,
): Promise<OpenDraftInNewWindowResult> {
  const sourceSnapshot = bridge.perWindowState.get(sourceWindowId);
  const movedDraft = sourceSnapshot.landingDrafts.find(
    (draft) => draft.id === draftId,
  );
  if (movedDraft === undefined) {
    return { result: "not-found", windowId: "" };
  }
  const destination = { windowId: null as string | null };
  let destinationWindowId: string;
  try {
    destinationWindowId = await bridge.windowRegistry.create({
      initialRoute: buildDraftInitialRoute(draftId),
      beforeLoad: async (windowId) => {
        destination.windowId = windowId;
        await bridge.perWindowState.update(windowId, {
          epicTabs: [],
          activeTabId: null,
          canvasByTabId: {},
          landingDrafts: [movedDraft],
          activeLandingDraftId: draftId,
          tabStripLayout: movedTabLayout(
            sourceSnapshot.tabStripLayout,
            "draft",
            draftId,
          ),
        });
      },
    });
  } catch (err) {
    if (destination.windowId !== null) {
      bridge.perWindowState.clear(destination.windowId);
      await bridge.windowRegistry.forceCloseById(destination.windowId);
    }
    throw err;
  }

  // The prune is a read-modify-write of whatever the source has projected BY
  // NOW, not of `sourceSnapshot`: `create` above awaited the destination's
  // load, and in that gap the source renderer may have projected a newer
  // snapshot (another draft edited, a new one started). Writing the pre-await
  // array back wholesale would revert those. Only this draft is removed.
  //
  // The active id is nulled rather than pointed at a successor: the source
  // RENDERER owns successor selection (its `closeRefAfterConfirmed` picks the
  // neighbouring tab and re-projects), and a successor chosen here would race
  // that pick. This patch only matters if the source crashes before its own
  // close runs.
  void Promise.resolve()
    .then(() => {
      const current = bridge.perWindowState.get(sourceWindowId);
      return bridge.perWindowState.update(sourceWindowId, {
        landingDrafts: current.landingDrafts.filter(
          (draft) => draft.id !== draftId,
        ),
        activeLandingDraftId:
          current.activeLandingDraftId === draftId
            ? null
            : current.activeLandingDraftId,
      });
    })
    .catch((error: unknown) => {
      log.warn("[windows-ipc] source draft-move state persistence failed", {
        windowId: sourceWindowId,
        error,
      });
    });
  bridge.windowRegistry.focusById(destinationWindowId);
  return { result: "moved", windowId: destinationWindowId };
}

async function presentDraftDestination(
  bridge: RunnerIpcBridge,
  destinationLoads: Map<string, DraftDestinationLoad>,
  windowId: string,
  request: MoveWindowDraftReferenceRequest,
): Promise<DraftDestinationStatus> {
  const stillOwnsReference = (): boolean =>
    destinationOwnsMove(bridge, windowId, request);
  if (!stillOwnsReference()) {
    destinationLoads.delete(windowId);
    return "retired";
  }

  const { windowRegistry } = bridge;
  const pending = destinationLoads.get(windowId);
  const registered = windowRegistry.getRecordById(windowId) !== null;
  const focus = (): DraftDestinationStatus => {
    if (!stillOwnsReference()) return "retired";
    if (!windowRegistry.focusById(windowId)) return "unavailable";
    bridge.safeSendToWindow(
      windowId,
      RunnerHostEvent.perWindowStateChange,
      bridge.perWindowState.get(windowId),
    );
    return "presented";
  };
  if (pending === undefined && registered) return focus();
  const inFlight = pending?.attempt ?? null;
  if (inFlight !== null) return inFlight;

  const { createWithId, loadById } = windowRegistry;
  if (createWithId === undefined || loadById === undefined) return "unavailable";
  const load: DraftDestinationLoad = pending ?? { request, attempt: null };
  const attempt = Promise.resolve().then(async (): Promise<DraftDestinationStatus> => {
    if (!stillOwnsReference()) {
      destinationLoads.delete(windowId);
      return "retired";
    }
    try {
      if (!registered) {
        createWithId.call(windowRegistry, {
          windowId,
          initialRoute: buildDraftInitialRoute(request.ref.slotId),
          beforeLoad: null,
        });
      }
      await loadById.call(windowRegistry, windowId);
    } catch (error) {
      log.warn("[windows-ipc] committed draft destination failed to load", {
        windowId,
        error,
      });
      if (!stillOwnsReference() || destinationLoads.get(windowId) !== load) {
        return "retired";
      }
      load.attempt = null;
      return "unavailable";
    }
    const result = focus();
    if (result === "unavailable" && destinationLoads.get(windowId) === load) {
      load.attempt = null;
    } else {
      destinationLoads.delete(windowId);
    }
    return result;
  });
  load.attempt = attempt;
  destinationLoads.set(windowId, load);
  return attempt;
}

function destinationOwnsMove(
  bridge: RunnerIpcBridge,
  windowId: string,
  request: MoveWindowDraftReferenceRequest,
): boolean {
  return bridge.perWindowState.get(windowId).draftTopology?.references.some(
    (ref) =>
      ref.slotId === request.ref.slotId &&
      ref.occurrenceId === request.ref.occurrenceId &&
      ref.moveToken === request.moveToken,
  ) === true;
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
