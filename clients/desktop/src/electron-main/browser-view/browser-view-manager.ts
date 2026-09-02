import { createHash } from "node:crypto";
import type { BrowserWindowConstructorOptions } from "electron";
import type {
  BrowserCdpResult,
  BrowserStorageState,
} from "@traycer/protocol/host/browser/contracts";
import { RunnerHostEvent } from "../../ipc-contracts/ipc-channels";
import type {
  BrowserViewAttachSurface,
  BrowserViewBoundsUpdate,
  BrowserViewCapturePageResult,
  BrowserViewCertificateErrorChange,
  BrowserViewDebugSnapshot,
  BrowserViewDebugSnapshotData,
  BrowserViewDetachSurface,
  BrowserViewNativeTabStatusChange,
  BrowserViewStatus,
  BrowserViewElectronTabControl,
  BrowserViewNativeTabCapability,
  BrowserViewTileKey,
  BrowserViewViewportPresetId,
  PipCaptureStartInput,
} from "@traycer-clients/shared/platform/browser-view";
import type { PipCaptureIpcPayload } from "../../ipc-contracts/pip-capture-types";
import { registrableDomainForUrl } from "@traycer/protocol/host/browser/registrable-domain";
import { describeLogError, log } from "../app/logger";
import {
  isAllowedGuestNavigationUrl,
  traceRefusedGuestNavigation,
} from "./browser-guest-navigation";
import type {
  BrowserSessionCertificateErrorChange,
  BrowserSessionDownloadChange,
  BrowserSessionProfile,
  BrowserSessionProfileRequest,
} from "./browser-session";
import type {
  BrowserViewElectronTabCdpDispatch,
  BrowserViewEnsureTab,
  BrowserViewDevToolsWindow,
  BrowserViewNavigationHistory,
  BrowserViewPopupWebContents,
  BrowserViewWebContents,
  BrowserViewWindow,
  ManagedBrowserView,
} from "./browser-view-port";
import { BrowserViewAnnotationHost } from "./manager/browser-view-annotation-host";
import {
  BrowserViewChords,
  type HostPlatform,
} from "./manager/browser-view-chords";
import {
  requireSurface,
  toTileKey,
  type BrowserViewEntry,
  type BrowserViewSend,
} from "./manager/browser-view-entry";
import {
  BrowserViewEntryFactory,
  applyEntryZoom,
  steppedEntryZoom,
} from "./manager/browser-view-entry-factory";
import {
  BrowserViewEntryRegistry,
  browserViewSurfaceKey as entryKeyId,
  nativeBrowserSessionKey as nativeSessionKey,
  nativeBrowserViewGuestKey as nativeGuestKey,
  type BrowserViewEntryKey,
} from "./manager/browser-view-entry-registry";
import { BrowserViewFind } from "./manager/browser-view-find";
import {
  assertEntryCapturable,
  BrowserViewGeometry,
  normalizeBounds,
} from "./manager/browser-view-geometry";
import { BrowserViewOverlay } from "./manager/browser-view-overlay";
import { BrowserViewPipCapture } from "./manager/browser-view-pip-capture";
import { BrowserViewPopups } from "./manager/browser-view-popups";
import {
  BrowserViewProvisioning,
  isNativeTabAvailable,
} from "./manager/browser-view-provisioning";
import { BrowserViewWindowAttachment } from "./manager/browser-view-window-attachment";
import { BrowserViewDebugSessions } from "./manager/debug-session-for";

// BT-101: aggregate window for the `bounds_stream` perf log. During a resize
// drag the renderer streams rects every frame; per-call logging would flood
// the lane, so outcomes accumulate here and flush once per window.
export const BOUNDS_STREAM_LOG_INTERVAL_MS = 1000;

const DEVTOOLS_TITLE = "Traycer Browser DevTools";

interface BrowserViewManagerOptions {
  readonly createView: (
    request: BrowserSessionProfileRequest,
  ) => ManagedBrowserView;
  readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  readonly createPopupWindowOptions: (
    windowId: string,
    request: BrowserSessionProfileRequest,
  ) => BrowserWindowConstructorOptions;
  readonly createDevToolsWindow: (
    windowId: string,
  ) => BrowserViewDevToolsWindow;
  readonly registerPopupWebContents: (
    webContents: BrowserViewPopupWebContents,
  ) => void;
  readonly onDownloadChange: (
    listener: (change: BrowserSessionDownloadChange) => void,
  ) => () => void;
  readonly onCertificateError: (
    listener: (change: BrowserSessionCertificateErrorChange) => void,
  ) => () => void;
  readonly onWindowChange: (listener: () => void) => () => void;
  readonly notifyHostWindowRendererReset: (windowId: string) => void;
  readonly send: BrowserViewSend;
  /**
   * Applies the host's storage seed for one guest. Takes the whole ensure-tab
   * input rather than just the state, because the write is validated against
   * the tab's OWN origin and attributed to the host that asked for it.
   *
   * Answers the part of the seed the JAR does not hold - the localStorage the
   * caller may install as a document script - narrowed to what survived that
   * validation, or `null` when nothing may be seeded at all.
   */
  readonly seedStorageState: (
    input: BrowserViewEnsureTab,
    webContents: ManagedBrowserView["webContents"],
  ) => Promise<BrowserStorageState | null>;
  readonly observePrimaryProfileOrigin: (
    url: string,
    webContents: ManagedBrowserView["webContents"],
    profile: BrowserSessionProfile,
  ) => void;
  /**
   * Drops an isolated session's partition once its last native tab is gone.
   * Only ever called with `profile: "isolated"`; the shared jars outlive
   * every guest.
   */
  readonly releaseSessionStorage: (
    request: BrowserSessionProfileRequest,
  ) => void;
  /** Flush window for the aggregate `bounds_stream` perf log. */
  readonly boundsStreamLogIntervalMs: number;
  /** Platform used to resolve reserved chords (BT-301). */
  readonly hostPlatform: HostPlatform;
}

/**
 * Coordinates the browser-view modules: it owns surface binding, the control
 * dispatch the renderer drives, page/debug capture, status emission and
 * teardown. Guest birth lives in `manager/browser-view-provisioning`, host
 * window parenting in `manager/browser-view-window-attachment`, and guest
 * event wiring in `manager/browser-view-entry-factory`.
 */
export class BrowserViewManager {
  private readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  private readonly createDevToolsWindow: (
    windowId: string,
  ) => BrowserViewDevToolsWindow;
  private readonly send: BrowserViewSend;
  private readonly releaseSessionStorage: (
    request: BrowserSessionProfileRequest,
  ) => void;
  private readonly offWindowChange: () => void;
  private readonly offDownloadChange: () => void;
  private readonly offCertificateError: () => void;
  private readonly entries = new BrowserViewEntryRegistry<BrowserViewEntry>();
  private readonly nativeTabStatusListeners = new Set<
    (change: BrowserViewNativeTabStatusChange) => void
  >();
  private readonly geometry: BrowserViewGeometry;
  private readonly popups: BrowserViewPopups;
  private readonly debugSessions: BrowserViewDebugSessions;
  private readonly windows: BrowserViewWindowAttachment;
  private readonly entryFactory: BrowserViewEntryFactory;
  private readonly provisioning: BrowserViewProvisioning;
  // Collaborators are part of the manager's public surface: the IPC layer
  // calls them directly (`manager.find.find(...)`) rather than through
  // pass-through methods that add no policy.
  readonly annotations: BrowserViewAnnotationHost;
  readonly overlay: BrowserViewOverlay;
  readonly find: BrowserViewFind;
  readonly chords: BrowserViewChords;
  readonly pip: BrowserViewPipCapture;

  constructor(options: BrowserViewManagerOptions) {
    this.getWindow = options.getWindow;
    this.createDevToolsWindow = options.createDevToolsWindow;
    this.send = options.send;
    this.releaseSessionStorage = options.releaseSessionStorage;
    this.geometry = new BrowserViewGeometry({
      getWindow: options.getWindow,
      boundsStreamLogIntervalMs: options.boundsStreamLogIntervalMs,
    });
    this.debugSessions = new BrowserViewDebugSessions({
      onDetached: (entry, webContentsId, reason) => {
        this.handleDebugSessionDetached(entry, webContentsId, reason);
      },
    });
    this.annotations = new BrowserViewAnnotationHost({
      entries: this.entries,
      send: options.send,
      debugSessions: this.debugSessions,
    });
    this.overlay = new BrowserViewOverlay({
      entries: this.entries,
      geometry: this.geometry,
      send: options.send,
    });
    this.find = new BrowserViewFind({
      entries: this.entries,
      send: options.send,
    });
    this.chords = new BrowserViewChords({
      getWindow: options.getWindow,
      hostPlatform: options.hostPlatform,
    });
    this.windows = new BrowserViewWindowAttachment({
      entries: this.entries,
      getWindow: options.getWindow,
      geometry: this.geometry,
      annotations: this.annotations,
      notifyHostWindowRendererReset: options.notifyHostWindowRendererReset,
      emitStatus: (entry) => {
        this.emitStatus(entry);
      },
      closeEntry: (entry) => {
        void this.closeEntry(entry);
      },
    });
    this.pip = new BrowserViewPipCapture({
      getWindow: options.getWindow,
      geometry: this.geometry,
      windows: this.windows,
      debugSessions: this.debugSessions,
    });
    this.popups = new BrowserViewPopups({
      createPopupWindowOptions: options.createPopupWindowOptions,
      registerPopupWebContents: options.registerPopupWebContents,
      send: options.send,
    });
    this.entryFactory = new BrowserViewEntryFactory({
      createView: options.createView,
      entries: this.entries,
      geometry: this.geometry,
      overlay: this.overlay,
      annotations: this.annotations,
      find: this.find,
      popups: this.popups,
      chords: this.chords,
      debugSessions: this.debugSessions,
      observePrimaryProfileOrigin: options.observePrimaryProfileOrigin,
      setStatus: (entry, status, reason) => {
        this.setStatus(entry, status, reason);
      },
      emitStatus: (entry) => {
        this.emitStatus(entry);
      },
      closeEntry: (entry) => {
        void this.closeEntry(entry);
      },
    });
    this.provisioning = new BrowserViewProvisioning({
      entries: this.entries,
      windows: this.windows,
      debugSessions: this.debugSessions,
      createEntry: (requestedUrl, identity, profile) =>
        this.entryFactory.create(requestedUrl, identity, profile),
      seedStorageState: options.seedStorageState,
      closeEntry: (entry) => this.closeEntry(entry),
      navigate: (entry, url) => this.navigate(entry, url),
      emitStatus: (entry) => {
        this.emitStatus(entry);
      },
    });
    this.offWindowChange = options.onWindowChange(() => {
      this.windows.reconcileVisibility(this.pip);
    });
    this.offDownloadChange = options.onDownloadChange((change) => {
      this.handleDownloadChange(change);
    });
    this.offCertificateError = options.onCertificateError((change) => {
      this.handleCertificateError(change);
    });
  }

  ensureTab(
    windowId: string,
    input: BrowserViewEnsureTab,
  ): Promise<BrowserViewNativeTabCapability> {
    return this.provisioning.ensureTab(windowId, input);
  }

  async acceptTab(input: BrowserViewNativeTabCapability): Promise<void> {
    const entry = this.findExactNativeEntry(input);
    if (entry === null) {
      throw new Error("Electron browser tab is not provisioned.");
    }
    if (!entry.identity.lifecycle.accept()) return;
    void this.provisioning.navigateAccepted(entry).catch((error: unknown) => {
      log.warn("[browser-view] initial native navigation failed", {
        error: describeLogError(error),
        guestKey: entry.guestKey,
      });
    });
  }

  attachSurface(windowId: string, input: BrowserViewAttachSurface): boolean {
    const entry = this.findExactNativeEntry(input);
    if (entry === null) return false;
    const surface = { ...input.surface, windowId };
    if (
      entry.surfaceBindingId !== null &&
      entry.surfaceBindingId !== input.bindingId &&
      entry.desiredVisible &&
      !entry.rendererResetPending
    ) {
      log.warn(
        "[browser-view] native surface attachment rejected: active binding",
        {
          guestKey: entry.guestKey,
          surfaceKeyId: entryKeyId(surface),
        },
      );
      return false;
    }
    const occupant = this.entries.getSurfaceByKey(entryKeyId(surface));
    if (occupant !== undefined && occupant !== entry) {
      log.warn("[browser-view] native surface attachment rejected: occupied", {
        guestKey: entry.guestKey,
        surfaceKeyId: entryKeyId(surface),
      });
      return false;
    }
    entry.surfaceBindingId = input.bindingId;
    if (
      entry.surface === null ||
      entryKeyId(entry.surface) !== entryKeyId(surface)
    ) {
      this.rekeyEntry(entry, surface);
    }
    entry.desiredVisible = true;
    entry.rendererResetPending = false;
    this.windows.attachToCurrentWindow(entry);
    this.emitStatus(entry);
    this.geometry.applyVisibility(entry);
    return true;
  }

  detachSurface(windowId: string, input: BrowserViewDetachSurface): boolean {
    const entry = this.findExactNativeEntry(input);
    if (
      entry === null ||
      entry.surface === null ||
      entry.surface.windowId !== windowId ||
      entry.surfaceBindingId !== input.bindingId
    ) {
      return false;
    }
    this.detachEntrySurface(entry);
    return true;
  }

  async releaseTab(input: BrowserViewNativeTabCapability): Promise<boolean> {
    const entry = this.entries.getGuest(nativeGuestKey(input));
    if (
      entry === undefined ||
      entry.identity.registrationId !== input.registrationId
    ) {
      return false;
    }
    await this.closeEntry(entry);
    return true;
  }

  async controlElectronTab(
    windowId: string,
    input: BrowserViewElectronTabControl,
  ): Promise<boolean> {
    const entry = this.findExactNativeEntry(input);
    if (entry === null) return false;
    const action = input.action;
    switch (action.kind) {
      case "navigate":
        await this.navigate(entry, action.url);
        return isNativeTabAvailable(this.entries, entry);
      case "reload":
        this.reloadEntry(entry);
        return true;
      case "goBack":
        this.moveEntryInHistory(entry, "back");
        return true;
      case "goForward":
        this.moveEntryInHistory(entry, "forward");
        return true;
      case "setViewportPreset":
        this.setEntryViewportPreset(entry, action.viewportPreset);
        return true;
      case "zoomIn":
        this.applyZoomStep(entry, 1);
        return true;
      case "zoomOut":
        this.applyZoomStep(entry, -1);
        return true;
      case "resetZoom":
        this.trySetEntryZoom(entry, 1);
        return true;
      case "openDevTools":
        this.openEntryDevTools(entry, windowId);
        return true;
    }
  }

  updateBounds(windowId: string, input: BrowserViewBoundsUpdate): void {
    const entry = this.entries.getTile(windowId, input);
    if (entry === undefined) return;
    entry.bounds = normalizeBounds(input.bounds);
    this.geometry.applyBounds(entry);
    this.geometry.applyVisibility(entry);
  }

  canTrustCertificateError(
    windowId: string,
    input: BrowserViewTileKey & { readonly certificateErrorId: string },
  ): boolean {
    const entry = this.entries.getTile(windowId, input);
    if (entry === undefined || entry.certificateError === null) return false;
    return (
      entry.certificateError.certificateErrorId === input.certificateErrorId
    );
  }

  clearCertificateError(
    windowId: string,
    input: BrowserViewTileKey & { readonly certificateErrorId: string },
  ): void {
    const entry = this.entries.getTile(windowId, input);
    if (entry === undefined) return;
    if (
      entry.certificateError?.certificateErrorId !== input.certificateErrorId
    ) {
      return;
    }
    entry.certificateError = null;
    this.reloadEntry(entry);
  }

  async startPipCapture(
    windowId: string,
    input: PipCaptureStartInput,
    onFrame: (payload: PipCaptureIpcPayload) => void,
  ): Promise<boolean> {
    const entry = this.findExactNativeEntry(input);
    if (entry === null) return false;
    return this.pip.start(entry, windowId, input, onFrame);
  }

  async capturePage(
    windowId: string,
    input: BrowserViewTileKey,
  ): Promise<BrowserViewCapturePageResult> {
    const entry = this.entries.getTile(windowId, input);
    if (entry === undefined) {
      throw new Error("Browser view tile is not available for capture");
    }
    const surface = requireSurface(entry);
    assertEntryCapturable(entry, this.getWindow(surface.windowId));
    const bytes = Buffer.from(
      (await entry.view.webContents.capturePage()).toPNG(),
    );
    return {
      ...toTileKey(surface),
      mediaType: "image/png",
      base64: bytes.toString("base64"),
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      capturedAt: Date.now(),
    };
  }

  /**
   * What "clear cookies for this site" would clear for one tile: the
   * registrable domain of the page it is on. `null` refuses the action, for
   * the three reasons it must be refused - the tile is gone, it is not on an
   * http(s) page (there is no site to name), or it is a private session, whose
   * partition dies with the session and is shared with nothing.
   *
   * The site is derived here, from the tile's own URL, and never taken from
   * the renderer: a domain on the wire would let any window name any site.
   */
  readClearSiteTarget(
    windowId: string,
    input: BrowserViewTileKey,
  ): string | null {
    const entry = this.entries.getTile(windowId, input);
    if (entry === undefined || entry.profile !== "primary") return null;
    if (!isHttpBrowserUrl(entry.currentUrl)) return null;
    return registrableDomainForUrl(entry.currentUrl);
  }

  getDebugSnapshot(
    windowId: string,
    input: BrowserViewTileKey,
  ): BrowserViewDebugSnapshot {
    const entry = this.entries.getTile(windowId, input);
    if (entry === undefined) {
      return {
        ...input,
        consoleEntries: [],
        networkEntries: [],
      };
    }
    return {
      ...toTileKey(requireSurface(entry)),
      ...this.readDebugSnapshot(entry),
    };
  }

  async dispatchElectronTabCdp(
    input: BrowserViewElectronTabCdpDispatch,
  ): Promise<BrowserCdpResult> {
    const entry = this.findExactNativeEntry(input);
    if (entry === null) {
      return {
        kind: input.command.kind,
        ok: false,
        error: {
          kind: "tab_not_found",
          message: `Electron browser tab ${input.tabId} incarnation is not available.`,
          code: null,
        },
      };
    }
    // The fourth navigation door, and the quietest: `cdpNavigate` reaches
    // `Page.navigate` directly, so it bypasses both `navigate()` and
    // `will-navigate`. The same predicate answers it - a curated command is
    // still a navigation, and a guest's scheme policy does not depend on who
    // asked.
    if (
      input.command.kind === "cdpNavigate" &&
      !isAllowedGuestNavigationUrl(input.command.url)
    ) {
      traceRefusedGuestNavigation(input.command.url, "cdp-navigate");
      return {
        kind: input.command.kind,
        ok: false,
        error: {
          kind: "cdp_error",
          message: "Browser tabs can only open http, https or about:blank.",
          code: null,
        },
      };
    }
    const debugSession = this.debugSessions.ensure(entry);
    await debugSession.enableAfterCommit().catch(() => undefined);
    return debugSession.dispatch(input.target, input.command);
  }

  dispose(): void {
    this.offWindowChange();
    this.offDownloadChange();
    this.offCertificateError();
    this.geometry.dispose();
    for (const entry of Array.from(this.entries.guestValues())) {
      void this.closeEntry(entry);
    }
    this.popups.dispose();
    this.overlay.dispose();
    this.annotations.dispose();
  }

  /**
   * Destroys every live `primary` guest so the host revives it on whichever
   * jar the saved-logins pref names now (it has already flipped before this
   * runs). Destroying a native guest is the re-placement mechanism: the host
   * suspends the session to dormant when its Electron route goes away and
   * re-materializes the same durable tab ids, seeding them from its own
   * primary-profile store. Guests the host has not accepted yet are left
   * alone - there is no durable route to revive them with, and the next tile
   * they open picks the current partition anyway.
   */
  async recreateNativeTabsOnCurrentPartition(): Promise<readonly string[]> {
    const migrating = Array.from(this.entries.guestValues()).filter(
      (entry) =>
        // Isolated guests have nothing to move: their jar is throwaway and
        // never reaches the persistent partition. Recreating them would only
        // destroy the private session the user is sitting in.
        entry.profile === "primary" &&
        entry.closePromise === null &&
        entry.identity.lifecycle.accepted,
    );
    const migratedKeys = migrating.map((entry) => entry.guestKey);
    await Promise.all(
      migrating.map((entry) =>
        this.closeEntry(entry).catch((error: unknown) => {
          log.warn("[browser-view] browser tile recreate failed", {
            error: describeLogError(error),
            guestKey: entry.guestKey,
          });
        }),
      ),
    );
    return migratedKeys;
  }

  hasNativeTabsForWindow(windowId: string): boolean {
    return Array.from(this.entries.guestValues()).some(
      (entry) =>
        entry.status !== "dead" &&
        entry.identity.lifecycleWindowId === windowId,
    );
  }

  async closeNativeSessionsForWindow(windowId: string): Promise<void> {
    const entries = Array.from(this.entries.guestValues());
    const sessionKeys = new Set(
      entries
        .filter((entry) => entry.identity.lifecycleWindowId === windowId)
        .map((entry) => nativeSessionKey(entry.identity.key)),
    );
    if (sessionKeys.size === 0) return;
    await Promise.all(
      entries
        .filter((entry) =>
          sessionKeys.has(nativeSessionKey(entry.identity.key)),
        )
        .map((entry) => this.closeEntry(entry)),
    );
  }

  private findExactNativeEntry(
    capability: BrowserViewNativeTabCapability,
  ): BrowserViewEntry | null {
    const entry = this.entries.getGuest(nativeGuestKey(capability));
    if (entry === undefined) return null;
    if (entry.identity.registrationId !== capability.registrationId)
      return null;
    if (entry.closePromise !== null) return null;
    return entry;
  }

  private rekeyEntry(entry: BrowserViewEntry, key: BrowserViewEntryKey): void {
    const previousSurface = entry.surface;
    if (previousSurface !== null) {
      this.annotations.end(entry, "tile-close");
    }
    const previousKeyId =
      previousSurface === null ? null : entryKeyId(previousSurface);
    const nextKeyId = entryKeyId(key);
    // The frame-cache slot is keyed by entry key; drop the stale slot so the
    // next visibility pass re-attaches under the new key (BT-202).
    if (previousKeyId !== null) {
      this.geometry.detachFrames(previousKeyId);
    }
    this.entries.bindSurface(entry, key);
    this.overlay.rekeyEntry(entry, previousKeyId, nextKeyId);
    if (previousSurface !== null && previousSurface.windowId !== key.windowId) {
      this.windows.detachResetListenerIfUnused(previousSurface.windowId);
    }
  }

  private detachEntrySurface(entry: BrowserViewEntry): void {
    const surface = entry.surface;
    if (surface === null) return;
    const keyId = entryKeyId(surface);
    this.geometry.detachFrames(keyId);
    this.annotations.end(entry, "tile-close");
    this.overlay.forgetEntry(entry, keyId);
    entry.desiredVisible = false;
    this.geometry.hide(entry);
    this.windows.detachFromParentWindow(entry);
    this.entries.detachSurface(entry);
    entry.surfaceBindingId = null;
    entry.bounds = null;
    entry.lastAppliedBounds = null;
    entry.rendererResetPending = false;
    this.windows.detachResetListenerIfUnused(surface.windowId);
    // LAST, once every field the reading depends on has moved: `viewed` is
    // read off the entry now (H10), so a detach that emitted nothing would
    // leave the host believing a tile is still showing this guest. `attachSurface`
    // emits for the same reason on the way in.
    this.emitStatus(entry);
  }

  /**
   * The one funnel for every navigation this process asks a guest to perform -
   * the renderer's `navigate` control action and the initial navigation the
   * host's accepted tab starts with - so the scheme gate sits here rather than
   * at either caller.
   *
   * It refuses BEFORE any entry state moves: a blocked target must not leave
   * the tile reporting `loading` for a page that will never commit.
   */
  private async navigate(entry: BrowserViewEntry, url: string): Promise<void> {
    if (!isAllowedGuestNavigationUrl(url)) {
      traceRefusedGuestNavigation(url, "navigate");
      throw new Error("Browser tabs can only open http, https or about:blank.");
    }
    this.annotations.end(entry, "navigation");
    entry.requestedUrl = url;
    entry.status = "loading";
    entry.statusReason = null;
    entry.certificateError = null;
    this.overlay.invalidateSnapshot(entry, "navigation-started");
    this.emitStatus(entry);
    try {
      await entry.view.webContents.loadURL(url);
    } catch (err: unknown) {
      log.warn("[browser-view] loadURL failed", {
        error: describeLogError(err),
        url,
      });
      if (this.entries.isCurrent(entry)) {
        this.setStatus(entry, "ready", "Navigation failed");
        this.geometry.applyVisibility(entry);
      }
      throw err;
    }
  }

  private reloadEntry(entry: BrowserViewEntry): void {
    this.setStatus(entry, "loading", null);
    this.overlay.invalidateSnapshot(entry, "reload");
    entry.view.webContents.reload();
    this.geometry.applyVisibility(entry);
  }

  private moveEntryInHistory(
    entry: BrowserViewEntry,
    direction: "back" | "forward",
  ): void {
    const navigationHistory = this.readNavigationHistory(entry);
    if (navigationHistory === null) {
      this.emitStatus(entry);
      return;
    }
    let canMove = false;
    try {
      canMove =
        direction === "back"
          ? navigationHistory.canGoBack()
          : navigationHistory.canGoForward();
    } catch {
      canMove = false;
    }
    if (!canMove) {
      this.emitStatus(entry);
      return;
    }
    this.setStatus(entry, "loading", null);
    this.overlay.invalidateSnapshot(
      entry,
      direction === "back" ? "go-back" : "go-forward",
    );
    try {
      if (direction === "back") {
        navigationHistory.goBack();
      } else {
        navigationHistory.goForward();
      }
    } catch (err) {
      log.warn(`[browser-view] go ${direction} failed`, {
        error: describeLogError(err),
        webContentsId: entry.view.webContents.id,
      });
      this.emitStatus(entry);
    }
    this.geometry.applyVisibility(entry);
  }

  private setEntryViewportPreset(
    entry: BrowserViewEntry,
    viewportPreset: BrowserViewViewportPresetId,
  ): void {
    entry.viewportPreset = viewportPreset;
    this.geometry.applyBounds(entry);
    this.geometry.applyVisibility(entry);
  }

  private applyZoomStep(entry: BrowserViewEntry, direction: 1 | -1): void {
    this.trySetEntryZoom(entry, steppedEntryZoom(entry, direction));
  }

  private trySetEntryZoom(entry: BrowserViewEntry, factor: number): void {
    if (applyEntryZoom(entry, factor)) this.emitStatus(entry);
  }

  private openEntryDevTools(entry: BrowserViewEntry, windowId: string): void {
    this.destroyDevToolsWindow(entry);
    const devToolsWindow = this.createDevToolsWindow(windowId);
    entry.devToolsWindow = devToolsWindow;
    entry.view.webContents.setDevToolsWebContents(devToolsWindow.webContents);
    entry.view.webContents.openDevTools({
      mode: "detach",
      activate: true,
      title: DEVTOOLS_TITLE,
    });
  }

  private handleDownloadChange(change: BrowserSessionDownloadChange): void {
    const entry = this.findEntryByWebContentsId(change.webContentsId);
    if (entry === null || entry.surface === null) return;
    this.send(
      entry.surface.windowId,
      RunnerHostEvent.browserViewDownloadChange,
      {
        ...toTileKey(entry.surface),
        downloadId: change.downloadId,
        url: change.url,
        filename: change.filename,
        mimeType: change.mimeType,
        totalBytes: change.totalBytes,
        receivedBytes: change.receivedBytes,
        state: change.state,
        dangerType: change.dangerType,
        canCancel: change.canCancel,
      },
    );
  }

  private handleCertificateError(
    change: BrowserSessionCertificateErrorChange,
  ): void {
    const entry = this.findEntryByWebContentsId(change.webContentsId);
    if (entry === null || entry.surface === null) return;
    const tileChange: BrowserViewCertificateErrorChange = {
      ...toTileKey(entry.surface),
      certificateErrorId: change.certificateErrorId,
      url: change.url,
      hostname: change.hostname,
      error: change.error,
      fingerprint: change.fingerprint,
      subject: change.subject,
      issuer: change.issuer,
    };
    entry.certificateError = tileChange;
    this.send(
      entry.surface.windowId,
      RunnerHostEvent.browserViewCertificateError,
      tileChange,
    );
    this.setStatus(entry, "dead", "Certificate error");
    this.geometry.applyVisibility(entry);
  }

  private findEntryByWebContentsId(
    webContentsId: number,
  ): BrowserViewEntry | null {
    for (const entry of this.entries.guestValues()) {
      if (entry.view.webContents.id === webContentsId) return entry;
    }
    return null;
  }

  /**
   * A tile's CDP debugger can detach for reasons outside our control - the
   * target being destroyed, a renderer crash, or an explicit
   * `Debugger.detach`. BrowserDebugSession synchronously drops its ready
   * state; the next native ensure or CDP dispatch reattaches and enables
   * domains before using the existing incarnation.
   *
   * Verified 2026-07-28, live: opening DevTools does NOT trigger this path
   * on Electron 42.7.1/Chromium 148 - `webContents.debugger.attach()` and
   * `openDevTools()` coexist there (confirmed via a real `devtools://`
   * target plus 8s of post-open polling with no detach, twice, independent
   * tile keys). A user can therefore open DevTools while an agent drives.
   */
  private handleDebugSessionDetached(
    entry: BrowserViewEntry,
    webContentsId: number,
    reason: string,
  ): void {
    log.warn("[browser-view] debugger detached", {
      reason,
      webContentsId,
    });
    this.annotations.end(entry, "crash");
    if (this.pip.isCapturing(entry)) this.pip.stop();
  }

  private readDebugSnapshot(
    entry: BrowserViewEntry,
  ): BrowserViewDebugSnapshotData {
    return (
      entry.debugSession?.snapshot() ?? {
        consoleEntries: [],
        networkEntries: [],
      }
    );
  }

  private setStatus(
    entry: BrowserViewEntry,
    status: BrowserViewStatus,
    reason: string | null,
  ): void {
    if (!this.entries.isCurrent(entry)) return;
    if (entry.status === status && entry.statusReason === reason) return;
    // Any move out of "ready" (reload/back/forward, cert error, renderer gone)
    // invalidates the isolated world the overlay runs in.
    if (status !== "ready") {
      this.annotations.end(entry, status === "dead" ? "crash" : "reload");
    }
    entry.status = status;
    entry.statusReason = reason;
    this.emitStatus(entry);
  }

  private emitStatus(entry: BrowserViewEntry): void {
    if (entry.internalNavigation) return;
    const webContents = this.readLiveWebContents(entry);
    if (webContents === null) return;
    const readings = readNavigationReadings(webContents);
    if (readings === null) return;
    const change: BrowserViewNativeTabStatusChange = {
      ...entry.identity.key,
      registrationId: entry.identity.registrationId,
      url: entry.currentUrl,
      title: entry.currentTitle === "" ? null : entry.currentTitle,
      status: entry.status,
      reason: entry.statusReason,
      canGoBack: readings.canGoBack,
      canGoForward: readings.canGoForward,
      zoomPercent: readings.zoomPercent,
      viewed: entry.surface !== null && entry.desiredVisible,
    };
    this.send(
      entry.identity.lifecycleWindowId,
      RunnerHostEvent.browserViewNativeTabStatusChange,
      change,
    );
    // The same reading, to the process that owns the host stream. It becomes
    // `electronTabState` there (H10); the renderer's copy above is tile chrome.
    for (const listener of this.nativeTabStatusListeners) listener(change);
  }

  /**
   * Main-side subscription to the same status readings the renderer gets.
   * Returns its own disposer, so a stream that closes stops hearing without
   * touching another stream's subscription.
   */
  onNativeTabStatusChange(
    listener: (change: BrowserViewNativeTabStatusChange) => void,
  ): () => void {
    this.nativeTabStatusListeners.add(listener);
    return () => {
      this.nativeTabStatusListeners.delete(listener);
    };
  }

  private readLiveWebContents(
    entry: BrowserViewEntry,
  ): BrowserViewWebContents | null {
    if (!this.entries.isCurrent(entry)) return null;
    const webContents = entry.view.webContents;
    if (webContents.isDestroyed()) return null;
    return webContents;
  }

  private readNavigationHistory(
    entry: BrowserViewEntry,
  ): BrowserViewNavigationHistory | null {
    const webContents = this.readLiveWebContents(entry);
    if (webContents === null) return null;
    return webContents.navigationHistory ?? null;
  }

  /**
   * Destroys one native guest and nothing else. Closing a native tab is a
   * RUNTIME event, never a durable one: the host suspends the session to
   * dormant when its Electron route goes away and re-materializes the same
   * durable tab ids later, so this path must not report the tab as closed.
   * Only an explicit user close sends `closeTab` on `browser.sessions`.
   */
  private closeEntry(entry: BrowserViewEntry): Promise<void> {
    if (entry.closePromise !== null) return entry.closePromise;
    // INVARIANT: `closePromise` is set before any teardown runs. `destroyEntry`
    // is synchronous through to its first await, so assigning afterwards would
    // leave `closePromise` null for the whole close - and it is exactly what
    // `closeEntry`'s idempotence guard, `findExactNativeEntry`'s "skip a
    // closing entry" check, and provisioning's "chain an ensure behind the
    // in-flight close" branch all read. None of them may depend on a teardown
    // step happening to await.
    const settled = Promise.withResolvers<void>();
    entry.closePromise = settled.promise;
    this.destroyEntry(entry).then(settled.resolve, settled.reject);
    return settled.promise;
  }

  private async destroyEntry(entry: BrowserViewEntry): Promise<void> {
    const surface = entry.surface;
    const keyId = surface === null ? null : entryKeyId(surface);
    if (keyId !== null) this.geometry.detachFrames(keyId);
    log.info("[browser-view] view destroy started", {
      keyId,
      status: entry.status,
    });
    this.destroyDevToolsWindow(entry);
    this.annotations.failPendingForEntry(entry);
    this.entries.detachSurface(entry);
    if (surface !== null) {
      this.windows.detachResetListenerIfUnused(surface.windowId);
    }
    this.windows.detachFromParentWindow(entry);
    const webContents = entry.view.webContents;
    for (const [event, handler] of Object.entries(entry.listeners)) {
      webContents.off(event, handler);
    }
    entry.annotationSession?.dispose("tile-close");
    entry.annotationSession = null;
    this.pip.forget(entry);
    entry.debugSession?.dispose();
    entry.debugSession = null;
    this.geometry.hide(entry);
    webContents.close();
    this.entries.remove(entry);
    this.releaseIsolatedSessionStorage(entry);
    this.windows.detachResetListenerIfUnused(entry.identity.lifecycleWindowId);
    log.info("[browser-view] view destroy requested", { keyId });
  }

  /**
   * An isolated session's partition is throwaway by construction, so it dies
   * with the session's last native tab - not with each tab, because siblings
   * of the same session share the one partition.
   */
  private releaseIsolatedSessionStorage(entry: BrowserViewEntry): void {
    if (entry.profile !== "isolated") return;
    const sessionKey = nativeSessionKey(entry.identity.key);
    for (const remaining of this.entries.guestValues()) {
      if (nativeSessionKey(remaining.identity.key) === sessionKey) return;
    }
    this.releaseSessionStorage({
      profile: entry.profile,
      sessionId: entry.identity.key.sessionId,
    });
    log.info("[browser-view] isolated session storage released", {
      sessionId: entry.identity.key.sessionId,
    });
  }

  private destroyDevToolsWindow(entry: BrowserViewEntry): void {
    const devToolsWindow = entry.devToolsWindow;
    entry.devToolsWindow = null;
    if (devToolsWindow === null || devToolsWindow.isDestroyed()) return;
    devToolsWindow.destroy();
  }
}

/**
 * The three status reads Electron can throw on once a target is going away.
 * One failure means the whole status frame is unreliable, so they share a
 * single guard rather than three nullable levels.
 */
function readNavigationReadings(webContents: BrowserViewWebContents): {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly zoomPercent: number;
} | null {
  const navigationHistory = webContents.navigationHistory;
  if (navigationHistory === undefined) return null;
  try {
    return {
      canGoBack: navigationHistory.canGoBack(),
      canGoForward: navigationHistory.canGoForward(),
      zoomPercent: Math.round(webContents.getZoomFactor() * 100),
    };
  } catch {
    return null;
  }
}

/**
 * A clear-site scope only means anything for a page: `about:blank`, a devtools
 * URL or a `file://` tile has no site whose logins could be cleared.
 */
function isHttpBrowserUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
