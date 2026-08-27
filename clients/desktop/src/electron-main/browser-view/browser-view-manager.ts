import { createHash, randomUUID } from "node:crypto";
import type {
  BrowserWindowConstructorOptions,
  Event,
  Input,
  RenderProcessGoneDetails,
  Result,
} from "electron";
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
  BrowserViewElectronTabCdpDispatch,
  BrowserViewEnsureTab,
  BrowserViewFindRequest,
  BrowserViewFindStop,
  BrowserViewOverlayOcclusion,
  BrowserViewOverlayOcclusionResult,
  BrowserViewOverlayRelease,
  BrowserViewOverlayReleaseResult,
  BrowserViewStatus,
  BrowserViewElectronTabControl,
  BrowserViewNativeTabCapability,
  BrowserViewElectronTabHandoffChange,
  BrowserViewTileKey,
  BrowserViewViewportPresetId,
  PipCaptureStartInput,
} from "../../ipc-contracts/browser-view-types";
import type {
  BrowserAnnotationAttachResultInput,
  BrowserAnnotationSetTargetChatLabelInput,
  BrowserAnnotationStartResult,
} from "../../ipc-contracts/browser-annotation-types";
import type { PipCaptureIpcPayload } from "../../ipc-contracts/pip-capture-types";
import type { BrowserStorageStateCaptureResult } from "./storage/browser-storage-state";
import { browserLocalStorageSeedScript } from "./storage/browser-storage-state";
import type { HostPlatform } from "../../ipc-contracts/reserved-chords";
import { describeLogError, log } from "../app/logger";
import { BrowserDebugSession } from "./debug/browser-debug-session";
import type {
  BrowserSessionCertificateErrorChange,
  BrowserSessionDownloadChange,
} from "./browser-session";
import type {
  BrowserViewDevToolsWindow,
  BrowserViewHostWebContents,
  BrowserViewNavigationHistory,
  BrowserViewPopupWebContents,
  BrowserViewPopupWindow,
  BrowserViewWebContents,
  BrowserViewWindow,
  ManagedBrowserView,
} from "./browser-view-port";
import { BrowserViewAnnotationHost } from "./manager/browser-view-annotation-host";
import { BrowserViewChords } from "./manager/browser-view-chords";
import {
  requireSurface,
  toTileKey,
  type BrowserViewEntry,
  type BrowserViewNativeIdentity,
  type BrowserViewSend,
} from "./manager/browser-view-entry";
import {
  BrowserViewEntryRegistry,
  browserViewSurfaceKey as entryKeyId,
  nativeBrowserViewGuestKey as nativeGuestKey,
  type BrowserViewEntryKey,
} from "./manager/browser-view-entry-registry";
import { BrowserViewFind } from "./manager/browser-view-find";
import {
  BrowserViewGeometry,
  normalizeBounds,
} from "./manager/browser-view-geometry";
import { BrowserViewHandoff } from "./manager/browser-view-handoff";
import { BrowserViewOverlay } from "./manager/browser-view-overlay";
import { BrowserViewPipCapture } from "./manager/browser-view-pip-capture";
import { BrowserViewPopups } from "./manager/browser-view-popups";
import { NativeBrowserViewLifecycle } from "./manager/native-browser-view-lifecycle";

// BT-101: aggregate window for the `bounds_stream` perf log. During a resize
// drag the renderer streams rects every frame; per-call logging would flood
// the lane, so outcomes accumulate here and flush once per window.
export const BOUNDS_STREAM_LOG_INTERVAL_MS = 1000;

const DEVTOOLS_TITLE = "Traycer Browser DevTools";

interface BrowserViewManagerOptions {
  readonly createView: () => ManagedBrowserView;
  readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  readonly createPopupWindowOptions: (
    windowId: string,
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
  readonly seedStorageState: (
    storageState: BrowserStorageState | null,
    webContents: ManagedBrowserView["webContents"],
  ) => Promise<void>;
  readonly captureStorageState: (
    input: { readonly origin: string },
    webContents: ManagedBrowserView["webContents"],
  ) => Promise<BrowserStorageStateCaptureResult>;
  readonly observePrimaryProfileOrigin: (
    url: string,
    webContents: ManagedBrowserView["webContents"],
  ) => void;
  /** Flush window for the aggregate `bounds_stream` perf log. */
  readonly boundsStreamLogIntervalMs: number;
  /** Platform used to resolve reserved chords (BT-301). */
  readonly hostPlatform: HostPlatform;
}

export class BrowserViewManager {
  private readonly createView: () => ManagedBrowserView;
  private readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  private readonly createDevToolsWindow: (
    windowId: string,
  ) => BrowserViewDevToolsWindow;
  private readonly send: BrowserViewSend;
  private readonly notifyHostWindowRendererReset: (windowId: string) => void;
  private readonly seedStorageStateInBrowser: (
    storageState: BrowserStorageState | null,
    webContents: ManagedBrowserView["webContents"],
  ) => Promise<void>;
  private readonly observePrimaryProfileOrigin: (
    url: string,
    webContents: ManagedBrowserView["webContents"],
  ) => void;
  private readonly offWindowChange: () => void;
  private readonly offDownloadChange: () => void;
  private readonly offCertificateError: () => void;
  private readonly entries = new BrowserViewEntryRegistry<BrowserViewEntry>();
  private readonly hostWindowResetListenersByWindowId = new Map<
    string,
    {
      readonly webContents: BrowserViewHostWebContents;
      readonly onNavigate: (
        event: Event,
        url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
      ) => void;
      readonly onGone: (
        event: Event,
        details: RenderProcessGoneDetails,
      ) => void;
    }
  >();
  private readonly geometry: BrowserViewGeometry;
  private readonly annotations: BrowserViewAnnotationHost;
  private readonly overlay: BrowserViewOverlay;
  private readonly find: BrowserViewFind;
  private readonly chords: BrowserViewChords;
  private readonly pip: BrowserViewPipCapture;
  private readonly popups: BrowserViewPopups;
  private readonly handoff: BrowserViewHandoff;

  constructor(options: BrowserViewManagerOptions) {
    this.createView = options.createView;
    this.getWindow = options.getWindow;
    this.createDevToolsWindow = options.createDevToolsWindow;
    this.send = options.send;
    this.notifyHostWindowRendererReset = options.notifyHostWindowRendererReset;
    this.seedStorageStateInBrowser = options.seedStorageState;
    this.observePrimaryProfileOrigin = options.observePrimaryProfileOrigin;
    this.geometry = new BrowserViewGeometry({
      getWindow: options.getWindow,
      boundsStreamLogIntervalMs: options.boundsStreamLogIntervalMs,
    });
    this.annotations = new BrowserViewAnnotationHost({
      entries: this.entries,
      send: options.send,
      ensureDebugSession: (entry) => this.ensureDebugSession(entry),
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
    this.pip = new BrowserViewPipCapture({
      getWindow: options.getWindow,
      geometry: this.geometry,
      ensureDebugSession: (entry) => this.ensureDebugSession(entry),
      attachToCurrentWindow: (entry) => {
        this.attachToCurrentWindow(entry);
      },
    });
    this.popups = new BrowserViewPopups({
      createPopupWindowOptions: options.createPopupWindowOptions,
      registerPopupWebContents: options.registerPopupWebContents,
      send: options.send,
    });
    this.handoff = new BrowserViewHandoff({
      entries: this.entries,
      send: options.send,
      captureStorageState: options.captureStorageState,
    });
    this.offWindowChange = options.onWindowChange(() => {
      this.reconcileWindowVisibility();
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
    const startedAt = Date.now();
    const guestKey = nativeGuestKey(input);
    const existing = this.entries.getGuest(guestKey);
    if (existing !== undefined) {
      if (existing.closePromise !== null) {
        return existing.closePromise.then(() =>
          this.ensureTab(windowId, input),
        );
      }
      return this.restoreExistingNativeTab(windowId, input, existing);
    }

    logEnsureStage(input, startedAt, "manager_started", "started", null);
    const lifecycle = new NativeBrowserViewLifecycle();
    const identity: BrowserViewNativeIdentity = {
      key: {
        hostId: input.hostId,
        sessionId: input.sessionId,
        tabId: input.tabId,
      },
      registrationId: randomUUID(),
      lifecycleWindowId: windowId,
      lifecycle,
    };
    const ownerWindow = this.getWindow(windowId);
    if (ownerWindow !== null) {
      this.ensureHostWindowResetListener(windowId, ownerWindow);
    }
    const entry = this.createEntry(input.requestedUrl, identity);
    logEnsureStage(input, startedAt, "entry_created", "ok", null);
    void this.settleNativeTabInitialization(entry, input, startedAt);
    return lifecycle.provisioned;
  }

  private async restoreExistingNativeTab(
    windowId: string,
    input: BrowserViewEnsureTab,
    entry: BrowserViewEntry,
  ): Promise<BrowserViewNativeTabCapability> {
    this.transferNativeLifecycle(entry, windowId);
    await entry.identity.lifecycle.provisioned;
    if (!this.isNativeTabAvailable(entry)) {
      await this.closeEntry(entry, null);
      return this.ensureTab(windowId, input);
    }
    try {
      await this.ensureDebugSession(entry).enableAfterCommit();
      const provisioned = this.resolveNativeTabProvisioned(entry);
      // A renderer reload reuses the guest without causing navigation, so
      // replay the state that the new renderer could not have observed.
      this.emitStatus(entry);
      return provisioned;
    } catch (error) {
      log.warn("[browser-view] native tab debugger recovery failed", {
        error: describeLogError(error),
        guestKey: entry.guestKey,
      });
      await this.closeEntry(entry, null);
      return this.ensureTab(windowId, input);
    }
  }

  private transferNativeLifecycle(
    entry: BrowserViewEntry,
    windowId: string,
  ): void {
    const previousWindowId = entry.identity.lifecycleWindowId;
    if (previousWindowId === windowId) return;
    entry.identity.lifecycleWindowId = windowId;
    const window = this.getWindow(windowId);
    if (window !== null) this.ensureHostWindowResetListener(windowId, window);
    this.detachHostWindowResetListenerIfUnused(previousWindowId);
  }

  private async settleNativeTabInitialization(
    entry: BrowserViewEntry,
    input: BrowserViewEnsureTab,
    startedAt: number,
  ): Promise<void> {
    try {
      await this.initializeNativeTab(entry, input, startedAt);
    } catch (error) {
      logEnsureStage(
        input,
        startedAt,
        "manager_settled",
        "failed",
        error instanceof Error ? error.name : typeof error,
      );
      try {
        await this.closeEntry(entry, null);
      } catch (cleanupError) {
        log.warn("[browser-view] native tab cleanup failed", {
          error: describeLogError(cleanupError),
          hostId: input.hostId,
          sessionId: input.sessionId,
          tabId: input.tabId,
        });
      }
      entry.identity.lifecycle.failProvisioning(error);
    }
  }

  async acceptTab(input: BrowserViewNativeTabCapability): Promise<void> {
    const entry = this.findExactNativeEntry(input);
    if (entry === null) {
      throw new Error("Electron browser tab is not provisioned.");
    }
    if (!entry.identity.lifecycle.accept()) return;
    void this.navigateAcceptedNativeTab(entry).catch((error: unknown) => {
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
    this.attachToCurrentWindow(entry);
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
    await this.closeEntry(entry, null);
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
        await this.navigate(entry, action.url, true);
        return this.isNativeTabAvailable(entry);
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

  private async initializeNativeTab(
    entry: BrowserViewEntry,
    input: BrowserViewEnsureTab,
    startedAt: number,
  ): Promise<BrowserViewNativeTabCapability> {
    await this.seedStorageStateInBrowser(
      input.seedStorageState,
      entry.view.webContents,
    );
    const seedScript = browserLocalStorageSeedScript(input.seedStorageState);
    await this.activateNativeTabTarget(entry, input, startedAt);
    const debugSession = this.ensureDebugSession(entry);
    const seedScriptId =
      seedScript === null
        ? null
        : await debugSession.installScriptBeforeNavigation(seedScript);
    await debugSession.enableAfterCommit();
    const provisioned = this.resolveNativeTabProvisioned(entry);
    logEnsureStage(input, startedAt, "manager_settled", "ok", null);
    entry.identity.lifecycle.completeProvisioning(provisioned, seedScriptId);
    return provisioned;
  }

  private async navigateAcceptedNativeTab(
    entry: BrowserViewEntry,
  ): Promise<void> {
    const debugSession = this.ensureDebugSession(entry);
    try {
      await this.navigate(entry, entry.requestedUrl, true);
    } finally {
      const seedScriptId = entry.identity.lifecycle.takeSeedScriptId();
      if (seedScriptId !== null) {
        try {
          await debugSession.removeScriptBeforeNavigation(seedScriptId);
        } catch (error) {
          log.warn("[browser-view] failed to remove native tab seed script", {
            error: describeLogError(error),
            sessionId: entry.identity.key.sessionId,
            tabId: entry.identity.key.tabId,
          });
        }
      }
    }
  }

  private async activateNativeTabTarget(
    entry: BrowserViewEntry,
    input: BrowserViewEnsureTab,
    startedAt: number,
  ): Promise<void> {
    // Electron allocates WebContentsView eagerly, but its Page CDP domain does
    // not accept commands until the first document target has loaded. This
    // internal navigation establishes that target before storage seeding; it
    // is deliberately suppressed from browser-session state and history.
    entry.internalNavigation = true;
    try {
      await entry.view.webContents.loadURL("about:blank");
    } finally {
      entry.view.webContents.navigationHistory?.clear();
      entry.internalNavigation = false;
    }
    logEnsureStage(input, startedAt, "target_activated", "ok", null);
  }

  private resolveNativeTabProvisioned(
    entry: BrowserViewEntry,
  ): BrowserViewNativeTabCapability {
    if (
      !this.isNativeTabAvailable(entry) ||
      entry.debugSession?.isReady() !== true
    ) {
      throw new Error("Native browser tab CDP route is no longer available.");
    }
    return {
      ...entry.identity.key,
      registrationId: entry.identity.registrationId,
    };
  }

  private isNativeTabAvailable(entry: BrowserViewEntry): boolean {
    return (
      this.isEntryCurrent(entry) &&
      entry.status !== "dead" &&
      !entry.view.webContents.isDestroyed()
    );
  }

  updateBounds(windowId: string, input: BrowserViewBoundsUpdate): void {
    const entry = this.entries.getSurfaceByKey(
      entryKeyId({ ...input, windowId }),
    );
    if (entry === undefined) return;
    entry.bounds = normalizeBounds(input.bounds);
    this.geometry.applyBounds(entry);
    this.geometry.applyVisibility(entry);
  }

  private detachEntrySurface(entry: BrowserViewEntry): void {
    const surface = entry.surface;
    if (surface === null) return;
    const keyId = entryKeyId(surface);
    this.geometry.detachFrames(keyId);
    this.annotations.end(entry, "tile-close");
    this.overlay.forgetEntry(entry, keyId);
    entry.desiredVisible = false;
    entry.view.setVisible(false);
    const window =
      entry.parentWindowId === null
        ? null
        : this.getWindow(entry.parentWindowId);
    if (window !== null && !window.isDestroyed()) {
      window.contentView.removeChildView(entry.view);
    }
    entry.parentWindowId = null;
    this.entries.detachSurface(entry);
    entry.surfaceBindingId = null;
    entry.bounds = null;
    entry.lastAppliedBounds = null;
    entry.rendererResetPending = false;
    this.detachHostWindowResetListenerIfUnused(surface.windowId);
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

  findInPage(windowId: string, input: BrowserViewFindRequest): void {
    this.find.find(windowId, input);
  }

  stopFindInPage(windowId: string, input: BrowserViewFindStop): void {
    this.find.stop(windowId, input);
  }

  /** BT-303 wire-in: replace the registered chord set at runtime. */
  setReservedChords(tokens: readonly string[]): void {
    this.chords.setTokens(tokens);
  }

  canTrustCertificateError(
    windowId: string,
    input: BrowserViewTileKey & { readonly certificateErrorId: string },
  ): boolean {
    const entry = this.entries.getSurfaceByKey(
      entryKeyId({ ...input, windowId }),
    );
    if (entry === undefined || entry.certificateError === null) return false;
    return (
      entry.certificateError.certificateErrorId === input.certificateErrorId
    );
  }

  clearCertificateError(
    windowId: string,
    input: BrowserViewTileKey & { readonly certificateErrorId: string },
  ): void {
    const entry = this.entries.getSurfaceByKey(
      entryKeyId({ ...input, windowId }),
    );
    if (entry === undefined) return;
    if (
      entry.certificateError?.certificateErrorId !== input.certificateErrorId
    ) {
      return;
    }
    entry.certificateError = null;
    this.reloadEntry(entry);
  }

  occludeForOverlay(
    windowId: string,
    input: BrowserViewOverlayOcclusion,
  ): Promise<BrowserViewOverlayOcclusionResult> {
    return this.overlay.occlude(windowId, input);
  }

  releaseOverlay(
    input: BrowserViewOverlayRelease,
  ): BrowserViewOverlayReleaseResult {
    return this.overlay.release(input);
  }

  /** Parks occluded native views only after their replacement frames paint. */
  paintAckOverlay(overlayId: string): void {
    this.overlay.paintAck(overlayId);
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

  stopPipCapture(): void {
    this.pip.stop();
  }

  async capturePage(
    windowId: string,
    input: BrowserViewTileKey,
  ): Promise<BrowserViewCapturePageResult> {
    const entry = this.entries.getSurfaceByKey(
      entryKeyId({ ...input, windowId }),
    );
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

  getDebugSnapshot(
    windowId: string,
    input: BrowserViewTileKey,
  ): BrowserViewDebugSnapshot {
    const entry = this.entries.getSurfaceByKey(
      entryKeyId({ ...input, windowId }),
    );
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

  setAnnotationTargetChatLabel(
    windowId: string,
    input: BrowserAnnotationSetTargetChatLabelInput,
  ): void {
    this.annotations.setTargetChatLabel(windowId, input);
  }

  startAnnotation(
    windowId: string,
    input: BrowserViewTileKey,
  ): Promise<BrowserAnnotationStartResult> {
    return this.annotations.start(windowId, input);
  }

  cancelAnnotation(windowId: string, input: BrowserViewTileKey): void {
    this.annotations.cancel(windowId, input);
  }

  reportAnnotationAttachResult(
    windowId: string,
    input: BrowserAnnotationAttachResultInput,
  ): void {
    this.annotations.reportAttachResult(windowId, input);
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
    const debugSession = this.ensureDebugSession(entry);
    await debugSession.enableAfterCommit().catch(() => undefined);
    return debugSession.dispatch(input.target, input.command);
  }

  dispose(): void {
    this.offWindowChange();
    this.offDownloadChange();
    this.offCertificateError();
    this.geometry.dispose();
    for (const entry of Array.from(this.entries.guestValues())) {
      void this.closeEntry(entry, "gui-quit");
    }
    this.popups.dispose();
    this.overlay.dispose();
    this.annotations.dispose();
  }

  hasNativeTabsForWindow(windowId: string): boolean {
    return Array.from(this.entries.guestValues()).some(
      (entry) =>
        entry.status !== "dead" &&
        entry.identity.lifecycleWindowId === windowId,
    );
  }

  drainBrowserHandoffsForWindow(windowId: string): Promise<void> {
    return this.handoff.drainForWindow(windowId);
  }

  async closeNativeSessionsForWindow(windowId: string): Promise<void> {
    const sessionKeys = new Set<string>();
    for (const entry of this.entries.guestValues()) {
      if (entry.identity.lifecycleWindowId === windowId) {
        sessionKeys.add(
          `${entry.identity.key.hostId}\u001f${entry.identity.key.sessionId}`,
        );
      }
    }
    if (sessionKeys.size === 0) return;
    await Promise.all(
      Array.from(this.entries.guestValues())
        .filter((entry) =>
          sessionKeys.has(
            `${entry.identity.key.hostId}\u001f${entry.identity.key.sessionId}`,
          ),
        )
        .map((entry) => this.closeEntry(entry, null)),
    );
  }

  private createEntry(
    requestedUrl: string,
    identity: BrowserViewNativeIdentity,
  ): BrowserViewEntry {
    const view = this.createView();
    const entry: BrowserViewEntry = {
      surface: null,
      surfaceBindingId: null,
      guestKey: nativeGuestKey(identity.key),
      identity,
      view,
      listeners: {
        "before-input-event": (event: Event, input: Input): void => {
          this.handleBeforeInputEvent(entry, event, input);
        },
        "did-create-window": (window: BrowserViewPopupWindow): void => {
          this.popups.handleDidCreateWindow(entry, window);
        },
        "did-frame-finish-load": (): void => {
          if (entry.internalNavigation) return;
          this.overlay.invalidateSnapshot(entry, "frame-finish-load");
        },
        "did-finish-load": (): void => {
          if (entry.internalNavigation) return;
          this.overlay.invalidateSnapshot(entry, "finish-load");
        },
        "did-navigate": (_event: Event, url: string): void => {
          this.handleCommittedNavigation(entry, url);
        },
        "did-start-navigation": (
          _event: Event,
          _url: string,
          isInPlace: boolean,
          isMainFrame: boolean,
        ): void => {
          this.handleViewStartNavigation(entry, isInPlace, isMainFrame);
        },
        "did-navigate-in-page": (
          _event: Event,
          url: string,
          isMainFrame: boolean,
        ): void => {
          this.handleInPageNavigation(entry, url, isMainFrame);
        },
        "found-in-page": (_event: Event, result: Result): void => {
          this.find.handleFoundInPage(entry, result);
        },
        "page-title-updated": (): void => {
          if (entry.internalNavigation) return;
          entry.currentTitle = entry.view.webContents.getTitle();
          this.overlay.invalidateSnapshot(entry, "page-title-updated");
          this.emitStatus(entry);
        },
        paint: (): void => {
          this.overlay.invalidateSnapshot(entry, "paint");
        },
        "render-process-gone": (
          _event: Event,
          details: RenderProcessGoneDetails,
        ): void => {
          this.handleRenderProcessGone(entry, details.reason);
        },
      },
      parentWindowId: null,
      desiredVisible: false,
      bounds: null,
      lastAppliedBounds: null,
      requestedUrl,
      currentUrl: requestedUrl,
      currentTitle: "",
      status: "loading",
      statusReason: null,
      findState: {
        appRequestId: 0,
        query: "",
        matchCase: false,
        sessionsByElectronRequestId: new Map(),
      },
      certificateError: null,
      debugSession: null,
      annotationSession: null,
      devToolsWindow: null,
      viewportPreset: "responsive",
      overlayOwnerIds: [],
      overlaySnapshotStale: false,
      overlayAwaitingPaintAck: false,
      overlayParked: false,
      visible: null,
      lastLoggedVisible: null,
      rendererResetPending: false,
      closePromise: null,
      internalNavigation: false,
    };
    const webContents = view.webContents;
    webContents.setWindowOpenHandler((details) =>
      this.popups.handleWindowOpen(entry, details),
    );
    for (const [event, handler] of Object.entries(entry.listeners)) {
      webContents.on(event, handler);
    }
    this.entries.register(entry);
    log.info("[browser-view] view created", {
      guestKey: entry.guestKey,
    });
    return entry;
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
      this.detachHostWindowResetListenerIfUnused(previousSurface.windowId);
    }
  }

  private async navigate(
    entry: BrowserViewEntry,
    url: string,
    rejectOnFailure: boolean,
  ): Promise<void> {
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
      if (this.isEntryCurrent(entry)) {
        this.setStatus(entry, "ready", "Navigation failed");
        this.geometry.applyVisibility(entry);
      }
      if (rejectOnFailure) throw err;
    }
  }

  private handleViewStartNavigation(
    entry: BrowserViewEntry,
    isInPlace: boolean,
    isMainFrame: boolean,
  ): void {
    if (entry.internalNavigation) return;
    if (!isMainFrame || isInPlace) return;
    this.annotations.end(entry, "navigation");
  }

  private handleCommittedNavigation(
    entry: BrowserViewEntry,
    url: string,
  ): void {
    if (entry.internalNavigation) return;
    entry.currentUrl = url;
    entry.requestedUrl = url;
    entry.currentTitle = entry.view.webContents.getTitle();
    this.observePrimaryProfileOrigin(url, entry.view.webContents);
    entry.certificateError = null;
    this.overlay.invalidateSnapshot(entry, "navigation-committed");
    this.setStatus(entry, "ready", null);
    this.enableDebugAfterCommit(entry);
    this.geometry.applyVisibility(entry);
  }

  private handleInPageNavigation(
    entry: BrowserViewEntry,
    url: string,
    isMainFrame: boolean,
  ): void {
    if (entry.internalNavigation) return;
    if (!isMainFrame) return;
    entry.currentUrl = url;
    entry.requestedUrl = url;
    entry.currentTitle = entry.view.webContents.getTitle();
    this.observePrimaryProfileOrigin(url, entry.view.webContents);
    this.annotations.end(entry, "navigation");
    this.overlay.invalidateSnapshot(entry, "in-page-navigation");
    this.emitStatus(entry);
  }

  private handleRenderProcessGone(
    entry: BrowserViewEntry,
    detail: string,
  ): void {
    this.annotations.end(entry, "crash");
    this.overlay.invalidateSnapshot(entry, "render-process-gone");
    this.setStatus(entry, "dead", detail);
    this.geometry.applyVisibility(entry);
    void this.closeEntry(entry, "crash-no-capture");
  }

  private handleBeforeInputEvent(
    entry: BrowserViewEntry,
    event: Event,
    input: Input,
  ): void {
    if (input.type !== "keyDown") return;
    const reserved = this.chords.match(input);
    if (reserved !== null) {
      event.preventDefault();
      this.chords.forwardToHostWindow(entry, reserved);
      return;
    }
    if (!(input.control || input.meta || input.shift || input.alt)) return;
    const step = browserZoomStepForKey(input.key);
    if (step === null) return;
    event.preventDefault();
    if (step === 0) {
      this.trySetEntryZoom(entry, 1);
      return;
    }
    this.applyZoomStep(entry, step);
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

  private enableDebugAfterCommit(entry: BrowserViewEntry): void {
    void this.ensureDebugSession(entry)
      .enableAfterCommit()
      .catch(() => undefined);
  }

  private ensureDebugSession(entry: BrowserViewEntry): BrowserDebugSession {
    if (entry.debugSession !== null) return entry.debugSession;
    const webContents = entry.view.webContents;
    const session = new BrowserDebugSession({
      webContents,
      onDetached: (reason) => {
        this.handleDebugSessionDetached(entry, webContents.id, reason);
      },
    });
    entry.debugSession = session;
    return session;
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
    if (!this.isEntryCurrent(entry)) return;
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
    this.send(
      entry.identity.lifecycleWindowId,
      RunnerHostEvent.browserViewNativeTabStatusChange,
      {
        ...entry.identity.key,
        registrationId: entry.identity.registrationId,
        url: entry.currentUrl,
        title: entry.currentTitle === "" ? null : entry.currentTitle,
        status: entry.status,
        reason: entry.statusReason,
        canGoBack: readings.canGoBack,
        canGoForward: readings.canGoForward,
        zoomPercent: readings.zoomPercent,
      },
    );
  }

  private isEntryCurrent(entry: BrowserViewEntry): boolean {
    return this.entries.getGuest(entry.guestKey) === entry;
  }

  private readLiveWebContents(
    entry: BrowserViewEntry,
  ): BrowserViewWebContents | null {
    if (!this.isEntryCurrent(entry)) return null;
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

  private applyZoomStep(entry: BrowserViewEntry, direction: 1 | -1): void {
    const current = entry.view.webContents.getZoomFactor();
    this.trySetEntryZoom(entry, nextZoomFactor(current, direction));
  }

  private setEntryViewportPreset(
    entry: BrowserViewEntry,
    viewportPreset: BrowserViewViewportPresetId,
  ): void {
    entry.viewportPreset = viewportPreset;
    this.geometry.applyBounds(entry);
    this.geometry.applyVisibility(entry);
  }

  private trySetEntryZoom(entry: BrowserViewEntry, factor: number): void {
    if (entry.annotationSession?.zoomLocked() === true) return;
    entry.view.webContents.setZoomFactor(factor);
    this.emitStatus(entry);
  }

  private attachToCurrentWindow(entry: BrowserViewEntry): void {
    const surface = entry.surface;
    if (surface === null) return;
    const targetWindow = this.getWindow(surface.windowId);
    if (targetWindow !== null) {
      this.ensureHostWindowResetListener(surface.windowId, targetWindow);
    }
    const currentWindow =
      entry.parentWindowId === null
        ? null
        : this.getWindow(entry.parentWindowId);
    if (entry.parentWindowId === surface.windowId && targetWindow !== null) {
      return;
    }
    if (currentWindow !== null) {
      currentWindow.contentView.removeChildView(entry.view);
    }
    entry.parentWindowId = null;
    if (targetWindow === null || targetWindow.isDestroyed()) return;
    targetWindow.contentView.addChildView(entry.view);
    entry.parentWindowId = surface.windowId;
  }

  /**
   * The host window itself (not any browser tile's own `webContents`) can
   * reload or crash - a vite HMR full reload in dev, a renderer crash in
   * production. When that happens every tile attached to this window keeps
   * `desiredVisible: true` in this (main-process, reload-surviving) manager
   * and would otherwise keep compositing over the blank window until the
   * new renderer re-registers it. One listener per window, attached lazily
   * the first time an entry attaches to it.
   */
  private ensureHostWindowResetListener(
    windowId: string,
    window: BrowserViewWindow,
  ): void {
    if (this.hostWindowResetListenersByWindowId.has(windowId)) return;
    const webContents = window.webContents;
    if (webContents === null) return;
    const onNavigate = (
      _event: Event,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ): void => {
      if (!isMainFrame || isInPlace) return;
      this.handleHostWindowRendererReset(windowId, "navigation", null);
    };
    const onGone = (_event: Event, details: RenderProcessGoneDetails): void => {
      this.handleHostWindowRendererReset(windowId, "crash", details.reason);
    };
    webContents.on("did-start-navigation", onNavigate);
    webContents.on("render-process-gone", onGone);
    this.hostWindowResetListenersByWindowId.set(windowId, {
      webContents,
      onNavigate,
      onGone,
    });
  }

  private detachHostWindowResetListenerIfUnused(windowId: string): void {
    const stillUsed = Array.from(this.entries.guestValues()).some(
      (entry) =>
        entry.surface?.windowId === windowId ||
        entry.identity.lifecycleWindowId === windowId,
    );
    if (stillUsed) return;
    const listeners = this.hostWindowResetListenersByWindowId.get(windowId);
    if (listeners === undefined) return;
    listeners.webContents.off("did-start-navigation", listeners.onNavigate);
    listeners.webContents.off("render-process-gone", listeners.onGone);
    this.hostWindowResetListenersByWindowId.delete(windowId);
  }

  private handleHostWindowRendererReset(
    windowId: string,
    reason: "navigation" | "crash",
    detail: string | null,
  ): void {
    this.notifyHostWindowRendererReset(windowId);
    let affectedCount = 0;
    for (const entry of this.entries.guestValues()) {
      if (
        entry.identity.lifecycleWindowId !== windowId ||
        entry.identity.lifecycle.accepted
      ) {
        continue;
      }
      affectedCount += 1;
      void this.closeEntry(entry, null);
    }
    for (const entry of this.entries.surfaceValues()) {
      if (entry.surface?.windowId !== windowId) continue;
      if (entry.rendererResetPending) continue;
      this.annotations.end(entry, reason === "crash" ? "crash" : "reload");
      entry.rendererResetPending = true;
      affectedCount += 1;
      this.geometry.applyVisibility(entry);
    }
    if (affectedCount === 0) return;
    log.info("[browser-view] host window renderer reset: hiding entries", {
      windowId,
      reason,
      detail,
      affectedCount,
    });
  }

  private reconcileWindowVisibility(): void {
    for (const entry of Array.from(this.entries.guestValues())) {
      const surface = entry.surface;
      if (surface === null && this.pip.retainsUnboundLease(entry)) continue;
      if (
        surface === null ||
        this.entries.getSurfaceByKey(entryKeyId(surface)) !== entry
      ) {
        entry.desiredVisible = false;
        entry.parentWindowId = null;
        entry.view.setVisible(false);
        continue;
      }
      const window = this.getWindow(surface.windowId);
      if (window === null || window.isDestroyed()) {
        entry.desiredVisible = false;
        entry.parentWindowId = null;
        entry.view.setVisible(false);
        continue;
      }
      this.attachToCurrentWindow(entry);
      this.geometry.applyVisibility(entry);
    }
  }

  private async closeEntry(
    entry: BrowserViewEntry,
    handoffReason: BrowserViewElectronTabHandoffChange["reason"] | null,
  ): Promise<void> {
    if (entry.closePromise !== null) return entry.closePromise;
    const closePromise = this.destroyEntry(entry, handoffReason);
    entry.closePromise = closePromise;
    return closePromise;
  }

  private async destroyEntry(
    entry: BrowserViewEntry,
    handoffReason: BrowserViewElectronTabHandoffChange["reason"] | null,
  ): Promise<void> {
    const surface = entry.surface;
    const keyId = surface === null ? null : entryKeyId(surface);
    if (keyId !== null) this.geometry.detachFrames(keyId);
    log.info("[browser-view] view destroy started", {
      keyId,
      handoffReason,
      status: entry.status,
    });
    this.destroyDevToolsWindow(entry);
    this.annotations.failPendingForEntry(entry);
    this.entries.detachSurface(entry);
    if (surface !== null) {
      this.detachHostWindowResetListenerIfUnused(surface.windowId);
    }
    // Capture while webContents is alive; a crashed renderer cannot be read.
    if (handoffReason !== null && entry.identity.lifecycle.accepted) {
      try {
        await this.handoff.push(
          entry,
          entry.status === "dead" ? "crash-no-capture" : handoffReason,
        );
      } catch (error) {
        log.warn("[browser-view] electron tab handoff failed during close", {
          error: describeLogError(error),
          guestKey: entry.guestKey,
          handoffReason,
        });
      }
    }
    // A quit drain or a sibling's aggregate handoff can already be reading
    // this guest. Keep the identity reserved until that capture settles.
    const pendingHandoffCapture =
      entry.identity.lifecycle.pendingHandoffCapture;
    if (pendingHandoffCapture !== null) {
      await pendingHandoffCapture;
    }
    const window =
      entry.parentWindowId === null
        ? null
        : this.getWindow(entry.parentWindowId);
    if (window !== null && !window.isDestroyed()) {
      window.contentView.removeChildView(entry.view);
    }
    const webContents = entry.view.webContents;
    for (const [event, handler] of Object.entries(entry.listeners)) {
      webContents.off(event, handler);
    }
    entry.annotationSession?.dispose("tile-close");
    entry.annotationSession = null;
    this.pip.forget(entry);
    entry.debugSession?.dispose();
    entry.debugSession = null;
    entry.view.setVisible(false);
    webContents.close();
    this.entries.remove(entry);
    this.detachHostWindowResetListenerIfUnused(
      entry.identity.lifecycleWindowId,
    );
    log.info("[browser-view] view destroy requested", { keyId });
  }

  private destroyDevToolsWindow(entry: BrowserViewEntry): void {
    const devToolsWindow = entry.devToolsWindow;
    entry.devToolsWindow = null;
    if (devToolsWindow === null || devToolsWindow.isDestroyed()) return;
    devToolsWindow.destroy();
  }
}

function logEnsureStage(
  input: BrowserViewEnsureTab,
  startedAt: number,
  stage:
    | "manager_started"
    | "entry_created"
    | "target_activated"
    | "manager_settled",
  outcome: "started" | "ok" | "failed",
  cause: string | null,
): void {
  log.info("[browser-view] native tab ensure stage", {
    kind: "electron_tab_create",
    stage,
    outcome,
    cause,
    hostId: input.hostId,
    sessionId: input.sessionId,
    tabId: input.tabId,
    durationMs: Date.now() - startedAt,
  });
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

function browserZoomStepForKey(key: string): 1 | -1 | 0 | null {
  if (key === "+" || key === "=") return 1;
  if (key === "-" || key === "_") return -1;
  if (key === "0" || key === ")") return 0;
  return null;
}

function nextZoomFactor(current: number, direction: 1 | -1): number {
  if (direction === 1) {
    return (
      BROWSER_ZOOM_FACTORS.find((factor) => factor > current + 0.001) ??
      BROWSER_ZOOM_FACTORS[BROWSER_ZOOM_FACTORS.length - 1]
    );
  }
  const previous = BROWSER_ZOOM_FACTORS.slice()
    .reverse()
    .find((factor) => factor < current - 0.001);
  return previous ?? BROWSER_ZOOM_FACTORS[0];
}

const BROWSER_ZOOM_FACTORS: readonly number[] = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
];

function assertEntryCapturable(
  entry: BrowserViewEntry,
  window: BrowserViewWindow | null,
): void {
  if (entry.status === "loading") {
    throw new Error("Browser screenshot unavailable: tile is still loading");
  }
  if (entry.status === "dead") {
    throw new Error("Browser screenshot unavailable: tile is not live");
  }
  if (entry.overlayOwnerIds.length > 0) {
    throw new Error("Browser screenshot unavailable: tile is occluded");
  }
  if (!entry.desiredVisible) {
    throw new Error("Browser screenshot unavailable: tile is not visible");
  }
  if (
    entry.bounds === null ||
    entry.bounds.width <= 0 ||
    entry.bounds.height <= 0
  ) {
    throw new Error(
      "Browser screenshot unavailable: tile has no visible bounds",
    );
  }
  if (
    window === null ||
    window.isDestroyed() ||
    !window.isVisible() ||
    window.isMinimized()
  ) {
    throw new Error("Browser screenshot unavailable: window is not visible");
  }
}
