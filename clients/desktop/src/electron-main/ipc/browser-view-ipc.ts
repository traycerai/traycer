import {
  BrowserWindow,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
  type Session,
} from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import {
  browserViewIpcPayload,
  parseReservedChords,
} from "./browser-view-ipc-payload";
import type { IpcManagedWindow } from "./runner-ipc-bridge";
import {
  BOUNDS_STREAM_LOG_INTERVAL_MS,
  BrowserViewManager,
} from "../browser-view/browser-view-manager";
import type {
  BrowserViewWindow,
  ManagedBrowserView,
} from "../browser-view/browser-view-port";
import { hostPlatformFromProcessPlatform } from "../browser-view/manager/browser-view-chords";
import {
  BROWSER_VIEW_PARTITION,
  createBrowserViewWebPreferences,
  cancelBrowserViewDownload,
  clearBrowserViewPendingCertificateError,
  ensureBrowserViewSession,
  ensureBrowserViewSessionForPartition,
  onBrowserPrimaryProfileDelta,
  onBrowserViewCertificateError,
  onBrowserViewDownloadChange,
  partitionForProfile,
  readBrowserViewPendingCertificateError,
  registerBrowserViewWebContents,
  releaseBrowserViewSession,
  suppressAllBrowserPrimaryProfileDeltas,
  suppressBrowserPrimaryProfileDelta,
  type BrowserSessionProfileRequest,
} from "../browser-view/browser-session";
import { describeLogError, log } from "../app/logger";
import {
  isBrowserSavedLoginsEnabled,
  setBrowserSavedLoginsEnabled,
  unwrapStoreKey,
  wrapStoreKey,
} from "../browser-view/storage/browser-saved-logins";
import {
  BrowserPrimaryProfileSnapshotCoordinator,
  captureBrowserOriginLocalStorage,
  captureBrowserPrimaryProfile,
  clearBrowserSite,
  seedBrowserViewCookies,
} from "../browser-view/storage/browser-storage-state";
import { trustBrowserCertificate } from "../app/cert-trust";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import type {
  BrowserStoreKeyUnwrapResult,
  BrowserStoreKeyWrapResult,
} from "@traycer-clients/shared/platform/browser-view";

/**
 * The whole-jar capture reads the one shared `primary` identity, so its
 * session lookup carries no per-tab session id.
 */
const PRIMARY_PROFILE_REQUEST: BrowserSessionProfileRequest = {
  profile: "primary",
  sessionId: "primary",
};

export function registerBrowserViewIpc(
  bridge: RunnerIpcBridge,
): BrowserViewManager {
  const primaryProfileSnapshots = new BrowserPrimaryProfileSnapshotCoordinator(
    (origins) =>
      captureBrowserPrimaryProfile(origins, {
        readSaveLogins: isBrowserSavedLoginsEnabled,
        getSession: () => ensureBrowserViewSession(PRIMARY_PROFILE_REQUEST),
      }),
    captureBrowserOriginLocalStorage,
  );
  // The remembered origins are the coordinator's: localStorage is not
  // enumerable from the session, so the origins this process has actually
  // visited are the only ones a site clear can name.
  const rememberedClearSiteOrigins = (): readonly string[] =>
    primaryProfileSnapshots.rememberedOrigins().map((origin) => origin.origin);
  /**
   * Every jar a `primary` login can be sitting in right now, durable one first.
   *
   * The durable `persist:` jar is always in the list, for the same reason
   * "forget all" used to open it explicitly: it survives the saved-logins pref,
   * so a clear taken while saving is OFF would leave the login on disk and
   * turning the pref back on would restore what the user deleted. When saving
   * is off the live guests are on the EPHEMERAL jar instead, which is not
   * `persist:` but does outlive the toggle for the whole process run - so
   * leaving it out signs nobody out until the app restarts.
   *
   * Sessions are memoised per partition, so the two entries are the very same
   * object whenever the pref leaves `primary` guests on the durable jar, and
   * identity is what collapses the list back to one.
   */
  const primaryProfileJars = (): readonly Session[] => {
    const durableSession = ensureBrowserViewSessionForPartition(
      BROWSER_VIEW_PARTITION,
    );
    const activeSession = ensureBrowserViewSession(PRIMARY_PROFILE_REQUEST);
    return activeSession === durableSession
      ? [durableSession]
      : [durableSession, activeSession];
  };
  /**
   * One site gone from every one of those jars, and from the localStorage this
   * process remembers for it.
   *
   * EVERY jar is attempted, whatever the ones before it did: they hold
   * independent copies of the same login, so abandoning the loop on the durable
   * jar's failure would leave the open tile still signed in. The first failure
   * is re-thrown once the loop is done, so the IPC caller still learns the site
   * was not fully cleared.
   *
   * The prune runs last, and ONLY when every jar succeeded. Last, because each
   * clear reads the same remembered origins and pruning first would starve the
   * ones after it. All-or-nothing, because those remembered origins are the
   * only record of which localStorage a clear can name - dropping them while a
   * jar still holds the site would make that site's localStorage unreachable
   * for the rest of the run, retry included.
   */
  const clearBrowserSiteEverywhere = async (domain: string): Promise<void> => {
    // Boxed, so a falsy thrown value still counts as a failure.
    let failure: { readonly error: unknown } | null = null;
    for (const browserSession of primaryProfileJars()) {
      try {
        await clearBrowserSite(
          domain,
          browserSession,
          rememberedClearSiteOrigins,
        );
      } catch (error) {
        failure ??= { error };
        log.warn("[browser-view] clearing one site failed on a jar", {
          domain,
          error: describeLogError(error),
        });
      }
    }
    if (failure !== null) throw failure.error;
    primaryProfileSnapshots.forgetOriginsUnder(domain);
  };
  const manager = new BrowserViewManager({
    createView: createElectronBrowserView,
    getWindow: (windowId) =>
      toBrowserViewWindow(
        bridge.windowRegistry.getRecordById(windowId)?.window,
      ),
    createPopupWindowOptions: (request) =>
      createBrowserPopupWindowOptions(request),
    createDevToolsWindow: (windowId) =>
      createBrowserDevToolsWindow(bridge, windowId),
    registerPopupWebContents: (webContents) => {
      registerBrowserViewWebContents(webContents);
    },
    onDownloadChange: onBrowserViewDownloadChange,
    onCertificateError: onBrowserViewCertificateError,
    onWindowChange: (listener) => {
      // Native views follow both the windows list and pure geometry
      // transitions (minimize/restore/maximize), which the list does not
      // carry - see WindowRegistry's `geometry` signal.
      bridge.windowRegistry.on("change", listener);
      bridge.windowRegistry.on("geometry", listener);
      return () => {
        bridge.windowRegistry.off("change", listener);
        bridge.windowRegistry.off("geometry", listener);
      };
    },
    // Tile rects are renderer CSS pixels; the native rect they map to depends
    // on the app's page zoom, which is a single app-wide preference.
    getZoomFactor: () => bridge.zoomController.getZoomFactor(),
    onZoomChange: (listener) => bridge.zoomController.onChange(listener),
    notifyHostWindowRendererReset: (windowId) => {
      bridge.markRendererUnavailable(windowId);
    },
    send: (windowId, channel, payload) =>
      bridge.safeSendToWindow(windowId, channel, payload),
    seedStorageState: async (storageState, webContents) => {
      // Retain BEFORE seeding: the jar the host just handed down is the only
      // record of the origins this run may never navigate, and a quit capture
      // replaces the host's whole jar with what it sends. Isolated guests are
      // never seeded (the host forces `seedStorageState` to null at the
      // placement seam), so nothing throwaway can enter this memory.
      primaryProfileSnapshots.retainSeededOrigins(storageState);
      await seedBrowserViewCookies(storageState, webContents);
    },
    observePrimaryProfileOrigin: (url, webContents, profile) => {
      // The primary capture reads the shared jar only. An isolated partition's
      // origins must never enter it - ticket 06's cookie-change observer takes
      // the same early return before it attaches to a partition.
      if (profile !== "primary") return;
      primaryProfileSnapshots.observe(url, webContents);
    },
    releaseSessionStorage: (request) => {
      void releaseBrowserViewSession(
        partitionForProfile(request.profile, request.sessionId),
      ).catch((error: unknown) => {
        log.warn("[browser-view] isolated session release failed", {
          sessionId: request.sessionId,
          error: describeLogError(error),
        });
      });
    },
    boundsStreamLogIntervalMs: BOUNDS_STREAM_LOG_INTERVAL_MS,
    hostPlatform: hostPlatformFromProcessPlatform(process.platform),
  });

  bridge.handleInvoke(RunnerHostInvoke.browserViewEnsureTab, (event, payload) =>
    manager.ensureTab(
      readSenderWindowId(bridge, event),
      browserViewIpcPayload.ensureTab.parse(payload),
    ),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewAcceptTab,
    (_event, payload) =>
      manager.acceptTab(
        browserViewIpcPayload.nativeTabCapability.parse(payload),
      ),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewAttachSurface,
    (event, payload) => {
      const attached = manager.attachSurface(
        readSenderWindowId(bridge, event),
        browserViewIpcPayload.attachSurface.parse(payload),
      );
      if (!attached) throw new Error("Electron browser tab is not available.");
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewDetachSurface,
    (event, payload) => {
      manager.detachSurface(
        readSenderWindowId(bridge, event),
        browserViewIpcPayload.detachSurface.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewReleaseTab,
    (_event, payload) =>
      manager.releaseTab(
        browserViewIpcPayload.nativeTabCapability.parse(payload),
      ),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewControlElectronTab,
    async (event, payload) => {
      const controlled = await manager.controlElectronTab(
        readSenderWindowId(bridge, event),
        browserViewIpcPayload.electronTabControl.parse(payload),
      );
      if (!controlled)
        throw new Error("Electron browser tab is not available.");
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewElectronTabCdpDispatch,
    (_event, payload) =>
      manager.dispatchElectronTabCdp(
        browserViewIpcPayload.electronTabCdpDispatch.parse(payload),
      ),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewUpdateBounds,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.updateBounds(
        windowId,
        browserViewIpcPayload.boundsUpdate.parse(payload),
      );
    },
  );

  // BT-202 flicker fix: renderer confirms the replacement frame is decoded
  // and on screen; only then does the manager move the native view offscreen.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewOverlayPaintAck,
    (_event, payload) => {
      const parsed = browserViewIpcPayload.overlayPaintAck.safeParse(payload);
      if (parsed.success) manager.overlay.paintAck(parsed.data.overlayId);
    },
  );

  // BT-302/BT-303: the renderer is the source of truth for the guest-focused
  // input policy - which chords outrank guest keystrokes and what each one
  // means. It pushes the whole table at startup.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewSetReservedChords,
    (_event, payload) => {
      manager.chords.setReservedChords(parseReservedChords(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewFindInPage,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.find.find(
        windowId,
        browserViewIpcPayload.findRequest.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewStopFindInPage,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.find.stop(
        windowId,
        browserViewIpcPayload.findStop.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewCancelDownload,
    (_event, payload) => {
      cancelBrowserViewDownload(
        browserViewIpcPayload.downloadCancel.parse(payload).downloadId,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewTrustCertificate,
    async (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      const input = browserViewIpcPayload.certificateTrust.parse(payload);
      if (!manager.canTrustCertificateError(windowId, input)) {
        throw new Error(
          "Browser certificate error is not active for this tile",
        );
      }
      const pending = readBrowserViewPendingCertificateError(
        input.certificateErrorId,
      );
      if (pending === null) {
        throw new Error("Browser certificate error is no longer pending");
      }
      await trustBrowserCertificate(pending.hostname, pending.certificate);
      clearBrowserViewPendingCertificateError(input.certificateErrorId);
      manager.clearCertificateError(windowId, input);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewOccludeForOverlay,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.overlay.occlude(
        windowId,
        browserViewIpcPayload.overlayOcclusion.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewReleaseOverlay,
    (_event, payload) =>
      manager.overlay.release(
        browserViewIpcPayload.overlayRelease.parse(payload),
      ),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewCapturePage,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.capturePage(
        windowId,
        browserViewIpcPayload.tileKey.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewGetDebugSnapshot,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.getDebugSnapshot(
        windowId,
        browserViewIpcPayload.tileKey.parse(payload),
      );
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.browserViewPrimaryProfileCapture, () =>
    primaryProfileSnapshots.capture(),
  );

  // "Clear cookies for this site" (spec §6.5). The manager derives the site
  // from the tile's own current URL; the jars are the shared `primary` ones,
  // which are the only jars a tile menu may reach. A tile with no site to name
  // - a private session, or a non-http(s) page - has nothing to clear.
  //
  // No suppression here: the removals fire the durable jar's own change events,
  // which coalesce into the single delta that tells the host the slice is empty.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewClearSite,
    async (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      const domain = manager.readClearSiteTarget(
        windowId,
        browserViewIpcPayload.tileKey.parse(payload),
      );
      if (domain === null) return;
      await clearBrowserSiteEverywhere(domain);
      log.info("[browser-view] cleared cookies for one site", { domain });
    },
  );

  // The host says this site was cleared somewhere else for this user. Same
  // removal, no delta: the store recorded the tombstones before it sent the
  // frame, so an echo would only re-assert what it already decided - and with
  // the observer suppressed there is nothing to echo with.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewEvictSite,
    async (_event, payload) => {
      const domain = browserViewIpcPayload.evictDomain.parse(payload).domain;
      await suppressBrowserPrimaryProfileDelta(domain, () =>
        clearBrowserSiteEverywhere(domain),
      );
      log.info("[browser-view] evicted one site on the host's request", {
        domain,
      });
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewStartAnnotation,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.annotations.start(
        windowId,
        browserViewIpcPayload.annotationStart.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewCancelAnnotation,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.annotations.cancel(
        windowId,
        browserViewIpcPayload.tileKey.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewSetAnnotationTargetChatLabel,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.annotations.setTargetChatLabel(
        windowId,
        browserViewIpcPayload.annotationTargetChatLabel.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewAnnotationAttachResult,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.annotations.reportAttachResult(
        windowId,
        browserViewIpcPayload.annotationAttachResult.parse(payload),
      );
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.browserViewSaveLoginsGet, () =>
    isBrowserSavedLoginsEnabled(),
  );

  // Toggling just switches which jar `primary` guests are born into and brings
  // the live tiles back on it at the same URL. Nothing is copied either way:
  // turning saving off leaves the `persist:` jar on disk untouched (that is
  // what "Forget all" is for), and turning it back on drops the in-memory one.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewSaveLoginsSet,
    async (_event, payload): Promise<boolean> => {
      const enabled = browserViewIpcPayload.saveLogins.parse(payload);
      const settled = await setBrowserSavedLoginsEnabled(enabled);
      // Open the target jar first, so the recreated guests attach to an
      // already-hardened session.
      ensureBrowserViewSession(PRIMARY_PROFILE_REQUEST);
      await manager.recreateNativeTabsOnCurrentPartition();
      return settled;
    },
  );

  // The host's store key, sealed with the same keystore Chromium's own jar
  // uses (spec §6.2). Attempted whenever the host asks, on every backend; a
  // refusal is reported as a result rather than a thrown IPC rejection, because
  // the host has a defined answer for it - stay sealed, and the user signs in
  // again.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewStoreKeyWrap,
    (_event, payload): BrowserStoreKeyWrapResult => {
      const rawKey = browserViewIpcPayload.storeKeyMaterial.parse(payload);
      const wrappedKey = wrapStoreKey(rawKey);
      return wrappedKey === null
        ? { ok: false, reason: "keystore unavailable" }
        : { ok: true, wrappedKey };
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewStoreKeyUnwrap,
    (_event, payload): BrowserStoreKeyUnwrapResult => {
      const wrappedKey = browserViewIpcPayload.storeKeyMaterial.parse(payload);
      const rawKey = unwrapStoreKey(wrappedKey);
      return rawKey === null
        ? { ok: false, reason: "keystore unavailable" }
        : { ok: true, rawKey };
    },
  );

  // The desktop half of "forget all browser logins" (spec §6.5). Reached only
  // through the host's `primaryProfileForgotten`, which the host sends after it
  // has already shredded this user's key and slice - so the jar is never
  // cleared while the host still holds the logins in it. Everything runs with
  // the cookie-delta observer muted for every domain: `clearStorageData` fires
  // a removal for each cookie, and those deltas would re-create the entry the
  // host just deleted.
  //
  // The order is the whole correctness argument: the localStorage coordinator
  // is reset before the tiles come back, so a recreated tile cannot be
  // re-seeded from an origin remembered pre-forget, and the tiles are recreated
  // last, at their current URLs.
  bridge.handleInvoke(RunnerHostInvoke.browserViewForgetLogins, async () => {
    // Opened here, outside the suppression: the durable jar must be cleared
    // even with saved logins off or no tile opened this run, and opening it is
    // what installs the observer the suppression mutes.
    const jars = primaryProfileJars();
    await suppressAllBrowserPrimaryProfileDeltas(async () => {
      let failure: { readonly error: unknown } | null = null;
      for (const primarySession of jars) {
        try {
          await primarySession.clearStorageData();
        } catch (error) {
          // The tiles still have to be recreated: they are sitting on a jar the
          // host no longer holds a key for, and leaving them there is worse.
          // The other jar still gets its turn for the same reason.
          failure ??= { error };
          log.warn("[browser-view] primary session clear failed", {
            error: describeLogError(error),
          });
        }
      }
      // Unconditional, unlike `clearBrowserSiteEverywhere`'s prune, and for the
      // reason that prune is conditional: a whole-jar clear names no origins, so
      // dropping this memory starves no retry - while KEEPING it after a failed
      // clear would let the next capture upload to the host the very
      // localStorage it just shredded its slice for.
      primaryProfileSnapshots.reset();
      await manager.recreateNativeTabsOnCurrentPartition();
      // Surfaced only once the tiles are back, and surfaced at all so the
      // caller is not told the logins are gone when a jar still holds them.
      if (failure !== null) throw failure.error;
    });
    log.info("[browser-view] forgot the saved browser logins");
  });

  // Coalesced cookie deltas from the durable `primary` jar (spec §6.3). The
  // renderer that owns the host stream forwards them as `primaryProfileDelta`;
  // windows without one simply drop them.
  const stopDeltaFanOut = onBrowserPrimaryProfileDelta((delta) => {
    bridge.fanOut(RunnerHostEvent.browserViewPrimaryProfileDelta, delta);
  });

  bridge.disposeFns.push(() => {
    stopDeltaFanOut();
    manager.dispose();
  });
  return manager;
}

function createElectronBrowserView(
  request: BrowserSessionProfileRequest,
): ManagedBrowserView {
  // Browser page webContents are intentionally not registered as trusted IPC
  // senders. They get no preload / Node integration; the Traycer renderer
  // mediates all browser-view IPC through RunnerIpcBridge's existing sender
  // gate.
  ensureBrowserViewSession(request);
  const view = new WebContentsView({
    webPreferences: createBrowserViewWebPreferences(request),
  });
  registerBrowserViewWebContents(view.webContents);
  return view;
}

function createBrowserPopupWindowOptions(
  request: BrowserSessionProfileRequest,
): BrowserWindowConstructorOptions {
  return {
    show: true,
    width: 900,
    height: 700,
    backgroundColor: "#0b0b0d",
    // A native child of a fullscreen BrowserWindow inherits macOS's
    // fullscreen space. Closing that child can leave the owning window's
    // compositor black, so arbitrary web popups must remain top-level native
    // windows. Chromium still retains the original window.opener relationship.
    fullscreen: false,
    fullscreenable: false,
    modal: false,
    kiosk: false,
    webPreferences: createBrowserViewWebPreferences(request),
  };
}

function createBrowserDevToolsWindow(
  bridge: RunnerIpcBridge,
  windowId: string,
): BrowserWindow {
  const parentWindow = bridge.windowRegistry.getRecordById(windowId)?.window;
  return new BrowserWindow({
    parent: isElectronBrowserWindow(parentWindow) ? parentWindow : undefined,
    show: true,
    width: 1200,
    height: 800,
    backgroundColor: "#0b0b0d",
    fullscreenable: false,
  });
}

function isElectronBrowserWindow(
  value: IpcManagedWindow | undefined,
): value is BrowserWindow {
  return value instanceof BrowserWindow;
}

function toBrowserViewWindow(
  value: IpcManagedWindow | undefined,
): BrowserViewWindow | null {
  if (!isElectronBrowserWindow(value)) return null;
  return {
    contentView: {
      addChildView: (view) => {
        if (!(view instanceof WebContentsView)) {
          throw new Error("Browser manager produced a non-Electron view");
        }
        value.contentView.addChildView(view);
      },
      removeChildView: (view) => {
        if (!(view instanceof WebContentsView)) return;
        value.contentView.removeChildView(view);
      },
    },
    webContents: value.webContents,
    isDestroyed: () => value.isDestroyed(),
    isVisible: () => value.isVisible(),
    isMinimized: () => value.isMinimized(),
  };
}

function readSenderWindowId(
  bridge: RunnerIpcBridge,
  event: IpcMainInvokeEvent,
): string {
  const windowId = bridge.resolveSenderWindowId(event);
  if (windowId === null) {
    throw new Error("Browser view IPC sender window is not registered");
  }
  return windowId;
}
