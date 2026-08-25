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
import type {
  BrowserViewBounds,
  BrowserViewAttachSurface,
  BrowserViewBoundsUpdate,
  BrowserViewCapturePageResult,
  BrowserViewCertificateErrorChange,
  BrowserViewDebugSnapshotChange,
  BrowserViewDebugSnapshotData,
  BrowserViewDownloadChange,
  BrowserViewDetachSurface,
  BrowserViewElectronTabCdpDispatch,
  BrowserViewEnsureTab,
  BrowserViewFindChange,
  BrowserViewFindRequest,
  BrowserViewFindStop,
  BrowserViewOpenTileRequest,
  BrowserViewOverlayOcclusion,
  BrowserViewOverlayOcclusionResult,
  BrowserViewOverlayRelease,
  BrowserViewOverlayReleaseResult,
  BrowserViewOverlaySnapshot,
  BrowserPrimaryProfileCaptureResult,
  BrowserViewSnapshotInvalidatedChange,
  BrowserViewStatus,
  BrowserViewStatusChange,
  BrowserViewElectronTabControl,
  BrowserViewNativeTabCapability,
  BrowserViewNativeTabKey,
  BrowserViewElectronTabHandoffChange,
  BrowserViewNativeTabStatusChange,
  BrowserViewStorageStateApply,
  BrowserViewStorageStateApplyResult,
  BrowserViewStorageStateCapture,
  BrowserViewStorageStateCaptureResult,
  BrowserViewTileKey,
  BrowserViewTileUpsert,
  BrowserViewViewportPresetChange,
  BrowserViewViewportPresetId,
  PipCaptureStartInput,
} from "../../ipc-contracts/browser-view-types";
import type {
  BrowserAnnotationAttachedIpcEvent,
  BrowserAnnotationAttachResultInput,
  BrowserAnnotationEndReason,
  BrowserAnnotationSessionIpcEvent,
  BrowserAnnotationSetTargetChatLabelInput,
  BrowserAnnotationStartResult,
} from "../../ipc-contracts/browser-annotation-types";
import type { PipCaptureIpcPayload } from "../../ipc-contracts/pip-capture-types";
import type {
  BrowserPrimaryProfileOriginSnapshot,
  BrowserStorageCaptureWebContents,
} from "./browser-storage-state";
import { browserLocalStorageSeedScript } from "./browser-storage-state";
import { createBoundsStreamStats } from "./bounds-stream-stats";
import {
  hostSendKeyCodeForToken,
  parseReservedChordToken,
  reservedChordFromKeyEvent,
  reservedChordMatchesEvent,
  resolveReservedChordForPlatform,
  type HostPlatform,
  type ReservedChord,
} from "../../ipc-contracts/reserved-chords";
import {
  TileFrameCache,
  defaultTileFrameEncoder,
  TILE_FRAME_JPEG_QUALITY,
  TILE_FRAME_MAX_ATTACHED,
  TILE_FRAME_MAX_DIMENSION,
  TILE_FRAME_MIN_INTERVAL_MS,
  TILE_FRAME_STALE_AFTER_MS,
  type TileFrameStats,
} from "./tile-frame-cache";
import { describeLogError, log } from "../app/logger";
import { BrowserAnnotationSession } from "./browser-annotation-session";
import { BrowserDebugSession } from "./browser-debug-session";
import type {
  BrowserSessionCertificateErrorChange,
  BrowserSessionDownloadChange,
} from "./browser-session";
import type {
  BrowserViewCapturedImage,
  BrowserViewDevToolsWindow,
  BrowserViewHostWebContents,
  BrowserViewInputModifier,
  BrowserViewNavigationHistory,
  BrowserViewPopupWebContents,
  BrowserViewPopupWindow,
  BrowserViewWebContents,
  BrowserViewWindow,
  BrowserViewWindowOpenDetails,
  BrowserViewWindowOpenResult,
  ManagedBrowserView,
} from "./browser-view-port";
import {
  BrowserViewEntryRegistry,
  browserViewSurfaceKey as entryKeyId,
  nativeBrowserViewGuestKey as nativeGuestKey,
  unmanagedBrowserViewGuestKey as unmanagedGuestKey,
  type BrowserViewEntryKey,
} from "./browser-view-entry-registry";
import { NativeBrowserViewLifecycle } from "./native-browser-view-lifecycle";

const DEBUG_SNAPSHOT_COALESCE_MS = 16;
const PRIMARY_PROFILE_LOCAL_STORAGE_ORIGIN_LIMIT = 8;
// BT-101: aggregate window for the `bounds_stream` perf log. During a resize
// drag the renderer streams rects every frame; per-call logging would flood
// the lane, so outcomes accumulate here and flush once per window.
export const BOUNDS_STREAM_LOG_INTERVAL_MS = 1000;

const encodeCapturedTileFrame = defaultTileFrameEncoder(
  TILE_FRAME_JPEG_QUALITY,
  TILE_FRAME_MAX_DIMENSION,
);

// BT-401: hidden-but-bound tiles keep a full Chromium guest alive; past this
// cap the least-recently-visible guests are destroyed and later rebuilt from
// their persisted URL (silent reload) on the next visit.
const HIDDEN_GUEST_EVICTION_CAP = 3;
/** Deferred so a switch's hide→show pair settles before the sweep counts. */
const EVICTION_SWEEP_DELAY_MS = 0;
const ANNOTATION_ATTACH_ACK_TIMEOUT_MS = 4000;

type BrowserPrimaryProfileRecentOrigin = BrowserPrimaryProfileOriginSnapshot & {
  readonly visitSequence: number;
};
interface PendingAnnotationAttachResult {
  readonly windowId: string;
  readonly keyId: string;
  readonly resolve: (delivered: boolean) => void;
  readonly timer: NodeJS.Timeout;
}

const DEVTOOLS_TITLE = "Traycer Browser DevTools";
const VIEWPORT_PRESETS: Readonly<
  Record<
    BrowserViewViewportPresetId,
    { readonly width: number | null; readonly height: number | null }
  >
> = {
  responsive: { width: null, height: null },
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
};

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
  readonly notifyStatus: (
    windowId: string,
    change: BrowserViewStatusChange,
  ) => void;
  readonly notifyNativeTabStatus: (
    windowId: string,
    change: BrowserViewNativeTabStatusChange,
  ) => void;
  readonly notifyFind: (
    windowId: string,
    change: BrowserViewFindChange,
  ) => void;
  readonly notifyDownload: (
    windowId: string,
    change: BrowserViewDownloadChange,
  ) => void;
  readonly notifyCertificateError: (
    windowId: string,
    change: BrowserViewCertificateErrorChange,
  ) => void;
  readonly notifyOpenTileRequest: (
    windowId: string,
    change: BrowserViewOpenTileRequest,
  ) => void;
  readonly notifySnapshotInvalidated: (
    windowId: string,
    change: BrowserViewSnapshotInvalidatedChange,
  ) => void;
  readonly notifyDebugSnapshot: (
    windowId: string,
    change: BrowserViewDebugSnapshotChange,
  ) => void;
  /** Captured native-session state sent before destructive GUI teardown. */
  readonly notifyElectronTabHandoff: (
    windowId: string,
    change: BrowserViewElectronTabHandoffChange,
  ) => boolean;
  readonly notifyAnnotationEvent: (
    windowId: string,
    change: BrowserAnnotationSessionIpcEvent,
  ) => void;
  readonly notifyAnnotationAttached: (
    windowId: string,
    change: BrowserAnnotationAttachedIpcEvent,
  ) => void;
  readonly scheduleDebugSnapshot: (
    callback: () => void,
  ) => BrowserViewScheduledTask;
  readonly applyStorageState: (
    input: BrowserViewStorageStateApply,
  ) => Promise<BrowserViewStorageStateApplyResult>;
  readonly captureStorageState: (
    input: { readonly origin: string },
    webContents: ManagedBrowserView["webContents"],
  ) => Promise<BrowserViewStorageStateCaptureResult>;
  readonly capturePrimaryProfile: (
    origins: readonly BrowserPrimaryProfileOriginSnapshot[],
  ) => Promise<BrowserPrimaryProfileCaptureResult>;
  readonly capturePrimaryProfileLocalStorage: (
    origin: string,
    webContents: BrowserStorageCaptureWebContents,
  ) => Promise<BrowserPrimaryProfileOriginSnapshot | null>;
  /** Flush window for the aggregate `bounds_stream` perf log. */
  readonly boundsStreamLogIntervalMs: number;
  /** Platform used to resolve reserved chords (BT-301). */
  readonly hostPlatform: HostPlatform;
}

interface BrowserViewScheduledTask {
  cancel(): void;
}

export function scheduleBrowserViewDebugSnapshot(
  callback: () => void,
): BrowserViewScheduledTask {
  const timer = setTimeout(callback, DEBUG_SNAPSHOT_COALESCE_MS);
  return {
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

interface BrowserViewEntry {
  surface: BrowserViewEntryKey | null;
  surfaceBindingId: string | null;
  readonly guestKey: string;
  readonly identity: BrowserViewGuestIdentity;
  readonly view: ManagedBrowserView;
  readonly listeners: BrowserViewListeners;
  parentWindowId: string | null;
  desiredVisible: boolean;
  bounds: BrowserViewBounds | null;
  /**
   * BT-101: last effective rect actually handed to `view.setBounds`. Identical
   * follow-up updates coalesce to a no-op so a streamed drag burst does not
   * relayout the guest per frame for unchanged geometry. Invalidated when
   * anything else moves the view directly (PiP offscreen parking).
   */
  lastAppliedBounds: BrowserViewBounds | null;
  /** BT-401: when this guest was last visible; eviction evicts oldest first. */
  lastVisibleAtMs: number;
  requestedUrl: string;
  currentUrl: string;
  currentTitle: string;
  status: BrowserViewStatus;
  statusReason: string | null;
  findState: BrowserViewEntryFindState;
  certificateError: BrowserViewCertificateErrorChange | null;
  debugSession: BrowserDebugSession | null;
  annotationSession: BrowserAnnotationSession | null;
  devToolsWindow: BrowserViewDevToolsWindow | null;
  viewportPreset: BrowserViewViewportPresetId;
  overlayOwnerIds: string[];
  overlaySnapshotStale: boolean;
  /**
   * BT-202 two-phase park: true between serving the replacement frame and
   * the renderer's paint acknowledgement. While pending, the view stays at
   * its real onscreen geometry so the page never blanks.
   */
  overlayAwaitingPaintAck: boolean;
  /** Set once the parked posture is actually applied (post-ack). */
  overlayParked: boolean;
  /** Last `visible` value logged by `applyEntryVisibility`, so forensics logging fires only on change. */
  lastLoggedVisible: boolean | null;
  /**
   * Set when the host window's own renderer starts a fresh main-frame
   * navigation or crashes, before the new renderer has re-upserted this
   * entry. Forces `applyEntryVisibility` to hide the tile so it cannot
   * composite over the blank/reloading window; cleared by the next
   * `upsertTile` call for this exact key.
   */
  rendererResetPending: boolean;
  internalNavigation: boolean;
  /** One teardown shared by every close trigger for this guest. */
  closePromise: Promise<void> | null;
}

type BrowserViewGuestIdentity =
  | {
      readonly kind: "unmanaged";
      readonly pageSessionId: string;
    }
  | {
      readonly kind: "native";
      readonly key: BrowserViewNativeTabKey;
      readonly registrationId: string;
      /** Current renderer connection that owns this guest's lifecycle stream. */
      lifecycleWindowId: string;
      readonly lifecycle: NativeBrowserViewLifecycle;
    };

interface BrowserViewEntryFindState {
  readonly appRequestId: number;
  readonly query: string;
  readonly matchCase: boolean;
  readonly sessionsByElectronRequestId: Map<
    number,
    BrowserViewEntryFindSession
  >;
}

interface BrowserViewEntryFindSession {
  readonly appRequestId: number;
  readonly query: string;
  readonly matchCase: boolean;
}

interface BrowserViewListeners {
  readonly beforeInputEvent: (event: Event, input: Input) => void;
  readonly didCreateWindow: (window: BrowserViewPopupWindow) => void;
  readonly didFrameNavigate: (
    event: Event,
    url: string,
    httpResponseCode: number,
    httpStatusText: string,
    isMainFrame: boolean,
  ) => void;
  readonly didFrameFinishLoad: () => void;
  readonly didFinishLoad: () => void;
  readonly didNavigate: (
    event: Event,
    url: string,
    httpResponseCode: number,
    httpStatusText: string,
  ) => void;
  readonly didStartNavigation: (
    event: Event,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => void;
  readonly didNavigateInPage: (
    event: Event,
    url: string,
    isMainFrame: boolean,
  ) => void;
  readonly foundInPage: (event: Event, result: Result) => void;
  readonly pageTitleUpdated: () => void;
  readonly paint: () => void;
  readonly renderProcessGone: (
    event: Event,
    details: RenderProcessGoneDetails,
  ) => void;
}

interface BrowserViewPopupEntry {
  readonly popupId: string;
  readonly openerKey: BrowserViewEntryKey;
  readonly window: BrowserViewPopupWindow;
  readonly listeners: BrowserViewPopupListeners;
}

interface BrowserViewPopupListeners {
  readonly closed: () => void;
  readonly renderProcessGone: (
    event: Event,
    details: RenderProcessGoneDetails,
  ) => void;
}

export class BrowserViewManager {
  private readonly createView: () => ManagedBrowserView;
  private readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  private readonly createPopupWindowOptions: (
    windowId: string,
  ) => BrowserWindowConstructorOptions;
  private readonly createDevToolsWindow: (
    windowId: string,
  ) => BrowserViewDevToolsWindow;
  private readonly registerPopupWebContents: (
    webContents: BrowserViewPopupWebContents,
  ) => void;
  private readonly notifyStatus: (
    windowId: string,
    change: BrowserViewStatusChange,
  ) => void;
  private readonly notifyNativeTabStatus: (
    windowId: string,
    change: BrowserViewNativeTabStatusChange,
  ) => void;
  private readonly notifyFind: (
    windowId: string,
    change: BrowserViewFindChange,
  ) => void;
  private readonly notifyDownload: (
    windowId: string,
    change: BrowserViewDownloadChange,
  ) => void;
  private readonly notifyCertificateError: (
    windowId: string,
    change: BrowserViewCertificateErrorChange,
  ) => void;
  private readonly notifyOpenTileRequest: (
    windowId: string,
    change: BrowserViewOpenTileRequest,
  ) => void;
  private readonly notifySnapshotInvalidated: (
    windowId: string,
    change: BrowserViewSnapshotInvalidatedChange,
  ) => void;
  private readonly notifyDebugSnapshot: (
    windowId: string,
    change: BrowserViewDebugSnapshotChange,
  ) => void;
  private readonly notifyElectronTabHandoff: (
    windowId: string,
    change: BrowserViewElectronTabHandoffChange,
  ) => boolean;
  private readonly notifyAnnotationEvent: (
    windowId: string,
    change: BrowserAnnotationSessionIpcEvent,
  ) => void;
  private readonly notifyAnnotationAttached: (
    windowId: string,
    change: BrowserAnnotationAttachedIpcEvent,
  ) => void;
  private readonly scheduleDebugSnapshot: (
    callback: () => void,
  ) => BrowserViewScheduledTask;
  private readonly applyStorageStateToBrowser: (
    input: BrowserViewStorageStateApply,
  ) => Promise<BrowserViewStorageStateApplyResult>;
  private readonly captureStorageStateFromBrowser: (
    input: { readonly origin: string },
    webContents: ManagedBrowserView["webContents"],
  ) => Promise<BrowserViewStorageStateCaptureResult>;
  private readonly capturePrimaryProfileFromBrowser: (
    origins: readonly BrowserPrimaryProfileOriginSnapshot[],
  ) => Promise<BrowserPrimaryProfileCaptureResult>;
  private readonly capturePrimaryProfileLocalStorageFromBrowser: (
    origin: string,
    webContents: BrowserStorageCaptureWebContents,
  ) => Promise<BrowserPrimaryProfileOriginSnapshot | null>;
  private readonly offWindowChange: () => void;
  private readonly offDownloadChange: () => void;
  private readonly offCertificateError: () => void;
  private readonly entries = new BrowserViewEntryRegistry<BrowserViewEntry>();
  private readonly popupEntriesByWebContentsId = new Map<
    number,
    BrowserViewPopupEntry
  >();
  private readonly overlayEntryKeysByOwnerId = new Map<
    string,
    readonly string[]
  >();
  private readonly pendingDebugSnapshotsByKey = new Map<
    string,
    BrowserViewScheduledTask
  >();
  private readonly pendingAnnotationAttachResults = new Map<
    string,
    PendingAnnotationAttachResult
  >();
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
  private readonly recentPrimaryProfileOrigins: BrowserPrimaryProfileRecentOrigin[] =
    [];
  private primaryProfileVisitSequence = 0;
  private pipCaptureEntry: BrowserViewEntry | null = null;
  private readonly boundsStreamLogIntervalMs: number;
  private readonly boundsStreamStats = createBoundsStreamStats();
  private boundsStreamLogTimer: NodeJS.Timeout | null = null;
  private lastFrameCacheStatsSignature: string | null = null;
  private reservedChords: readonly ReservedChord[] = [];
  private readonly hostPlatform: HostPlatform;
  private evictionSweepTimer: NodeJS.Timeout | null = null;
  private readonly evictedKeyIdsLog: string[] = [];
  /**
   * BT-202: per-tile rolling frame cache feeding overlay occlusion. Slots are
   * keyed by `entryKeyId`; attached while a tile is bound to a live window.
   */
  private readonly tileFrames = new TileFrameCache({
    minIntervalMs: TILE_FRAME_MIN_INTERVAL_MS,
    staleAfterMs: TILE_FRAME_STALE_AFTER_MS,
    maxDimension: TILE_FRAME_MAX_DIMENSION,
    jpegQuality: TILE_FRAME_JPEG_QUALITY,
    maxAttached: TILE_FRAME_MAX_ATTACHED,
    onEvict: (key) => {
      log.warn("[browser-view] frame cache slot evicted (cap)", { keyId: key });
    },
    now: () => Date.now(),
    encode: encodeCapturedTileFrame,
  });

  constructor(options: BrowserViewManagerOptions) {
    this.createView = options.createView;
    this.getWindow = options.getWindow;
    this.createPopupWindowOptions = options.createPopupWindowOptions;
    this.createDevToolsWindow = options.createDevToolsWindow;
    this.registerPopupWebContents = options.registerPopupWebContents;
    this.notifyStatus = options.notifyStatus;
    this.notifyNativeTabStatus = options.notifyNativeTabStatus;
    this.notifyFind = options.notifyFind;
    this.notifyDownload = options.notifyDownload;
    this.notifyCertificateError = options.notifyCertificateError;
    this.notifyOpenTileRequest = options.notifyOpenTileRequest;
    this.notifySnapshotInvalidated = options.notifySnapshotInvalidated;
    this.notifyDebugSnapshot = options.notifyDebugSnapshot;
    this.notifyElectronTabHandoff = options.notifyElectronTabHandoff;
    this.notifyAnnotationEvent = options.notifyAnnotationEvent;
    this.notifyAnnotationAttached = options.notifyAnnotationAttached;
    this.scheduleDebugSnapshot = options.scheduleDebugSnapshot;
    this.applyStorageStateToBrowser = options.applyStorageState;
    this.captureStorageStateFromBrowser = options.captureStorageState;
    this.capturePrimaryProfileFromBrowser = options.capturePrimaryProfile;
    this.capturePrimaryProfileLocalStorageFromBrowser =
      options.capturePrimaryProfileLocalStorage;
    this.boundsStreamLogIntervalMs = options.boundsStreamLogIntervalMs;
    this.hostPlatform = options.hostPlatform;
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

  upsertTile(windowId: string, input: BrowserViewTileUpsert): void {
    const key = { ...input, windowId };
    const keyId = entryKeyId(key);
    const presentedEntry = this.entries.getSurfaceByKey(keyId);
    if (presentedEntry?.identity.kind === "native") {
      log.warn("[browser-view] unmanaged upsert rejected for native surface", {
        keyId,
        guestKey: guestEntryKey(presentedEntry),
      });
      return;
    }
    const existing = presentedEntry ?? this.findTransferableEntry(key);
    const entry =
      existing === null
        ? this.createEntry(key, input.url, input.viewportPreset, true, {
            kind: "unmanaged",
            pageSessionId: key.pageSessionId,
          })
        : existing;
    log.info("[browser-view] upsert tile", {
      keyId,
      outcome: existing === null ? "created" : "reused",
      visible: input.visible,
      url: input.url,
    });

    if (entry.surface === null || entryKeyId(entry.surface) !== keyId) {
      this.rekeyEntry(entry, key);
    } else {
      this.entries.bindSurface(entry, key);
    }

    entry.desiredVisible = input.visible;
    entry.rendererResetPending = false;
    if (entry.viewportPreset !== input.viewportPreset) {
      entry.viewportPreset = input.viewportPreset;
      this.applyEntryBounds(entry);
    }
    if (entry.requestedUrl !== input.url) {
      void this.navigate(entry, input.url, false);
    } else {
      // Reconcile echo: a reused entry keeps its pre-disconnect status
      // ("ready"), which a reloaded renderer never observed — "ready" is
      // only otherwise emitted on a navigation commit, and a same-URL
      // upsert performs none. Without this echo the fresh renderer sits
      // in "loading" until its unreachable ceiling fires.
      this.emitStatus(entry);
    }
    this.attachToCurrentWindow(entry);
    this.applyEntryVisibility(entry);
    this.queueDebugSnapshot(entry);
    // BT-401: every upsert can change the hidden set (a tab switch hides the
    // outgoing tile; a first open can land hidden). The sweep is coalesced,
    // so this is cheap.
    this.scheduleEvictionSweep();
  }

  ensureTab(
    windowId: string,
    input: BrowserViewEnsureTab,
  ): Promise<BrowserViewNativeTabCapability> {
    const startedAt = Date.now();
    const guestKey = nativeGuestKey(input);
    const existing = this.entries.getGuest(guestKey);
    if (existing !== undefined) {
      if (existing.identity.kind !== "native") {
        throw new Error(`Native browser tab key collided with ${guestKey}.`);
      }
      if (existing.closePromise !== null) {
        return existing.closePromise.then(() =>
          this.ensureTab(windowId, input),
        );
      }
      return this.restoreExistingNativeTab(windowId, input, existing);
    }

    log.info("[browser-view] native tab ensure stage", {
      kind: "electron_tab_create",
      stage: "manager_started",
      outcome: "started",
      hostId: input.hostId,
      sessionId: input.sessionId,
      tabId: input.tabId,
      durationMs: 0,
    });
    const lifecycle = new NativeBrowserViewLifecycle();
    const identity: BrowserViewGuestIdentity = {
      kind: "native",
      key: toNativeTabKey(input),
      registrationId: randomUUID(),
      lifecycleWindowId: windowId,
      lifecycle,
    };
    const ownerWindow = this.getWindow(windowId);
    if (ownerWindow !== null) {
      this.ensureHostWindowResetListener(windowId, ownerWindow);
    }
    const entry = this.createEntry(
      null,
      input.requestedUrl,
      "responsive",
      false,
      identity,
    );
    log.info("[browser-view] native tab ensure stage", {
      kind: "electron_tab_create",
      stage: "entry_created",
      outcome: "ok",
      hostId: input.hostId,
      sessionId: input.sessionId,
      tabId: input.tabId,
      durationMs: Date.now() - startedAt,
    });
    void this.settleNativeTabInitialization(entry, input, startedAt);
    return lifecycle.provisioned;
  }

  private async restoreExistingNativeTab(
    windowId: string,
    input: BrowserViewEnsureTab,
    entry: BrowserViewEntry,
  ): Promise<BrowserViewNativeTabCapability> {
    if (entry.identity.kind !== "native") {
      throw new Error("Cannot restore an unmanaged browser guest as native.");
    }
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
        guestKey: guestEntryKey(entry),
      });
      await this.closeEntry(entry, null);
      return this.ensureTab(windowId, input);
    }
  }

  private transferNativeLifecycle(
    entry: BrowserViewEntry,
    windowId: string,
  ): void {
    if (entry.identity.kind !== "native") return;
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
      log.info("[browser-view] native tab ensure stage", {
        kind: "electron_tab_create",
        stage: "manager_settled",
        outcome: "failed",
        cause: error instanceof Error ? error.name : typeof error,
        hostId: input.hostId,
        sessionId: input.sessionId,
        tabId: input.tabId,
        durationMs: Date.now() - startedAt,
      });
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
      if (entry.identity.kind === "native") {
        entry.identity.lifecycle.failProvisioning(error);
      }
    }
  }

  acceptTab(input: BrowserViewNativeTabCapability): Promise<void> {
    const entry = this.findExactNativeEntry(input);
    if (entry === null || entry.identity.kind !== "native") {
      return Promise.reject(
        new Error("Electron browser tab is not provisioned."),
      );
    }
    return entry.identity.lifecycle.accept(() => this.activateNativeTab(entry));
  }

  attachSurface(windowId: string, input: BrowserViewAttachSurface): boolean {
    const entry = this.findExactNativeEntry(input);
    if (entry === null) return false;
    const surface = { ...input.surface, windowId };
    const occupant = this.entries.getSurfaceByKey(entryKeyId(surface));
    if (occupant !== undefined && occupant !== entry) {
      log.warn("[browser-view] native surface attachment rejected: occupied", {
        guestKey: guestEntryKey(entry),
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
    entry.desiredVisible = input.visible;
    entry.rendererResetPending = false;
    this.attachToCurrentWindow(entry);
    this.emitStatus(entry);
    this.queueDebugSnapshot(entry);
    this.applyEntryVisibility(entry);
    this.scheduleEvictionSweep();
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
    this.detachEntrySurface(entry, "clear-geometry");
    return true;
  }

  async releaseTab(input: BrowserViewNativeTabCapability): Promise<boolean> {
    const entry = this.entries.getGuest(nativeGuestKey(input));
    if (
      entry?.identity.kind !== "native" ||
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
    if (entry.identity.kind !== "native") {
      throw new Error("Cannot initialize an unmanaged browser guest.");
    }
    const seedScript = browserLocalStorageSeedScript(input.seedStorageState);
    await this.activateNativeTabTarget(entry, input, startedAt);
    const debugSession = this.ensureDebugSession(entry);
    const seedScriptId =
      seedScript === null
        ? null
        : await debugSession.installScriptBeforeNavigation(seedScript);
    await debugSession.enableAfterCommit();
    const provisioned = this.resolveNativeTabProvisioned(entry);
    log.info("[browser-view] native tab ensure stage", {
      kind: "electron_tab_create",
      stage: "manager_settled",
      outcome: "ok",
      hostId: input.hostId,
      sessionId: input.sessionId,
      tabId: input.tabId,
      durationMs: Date.now() - startedAt,
    });
    entry.identity.lifecycle.completeProvisioning(provisioned, seedScriptId);
    return provisioned;
  }

  private async activateNativeTab(entry: BrowserViewEntry): Promise<void> {
    if (entry.identity.kind !== "native") {
      throw new Error("Cannot activate an unprovisioned browser guest.");
    }
    try {
      await this.navigate(entry, entry.requestedUrl, true);
    } finally {
      const seedScriptId = entry.identity.lifecycle.takeSeedScriptId();
      if (seedScriptId !== null) {
        try {
          await this.ensureDebugSession(entry).removeScriptBeforeNavigation(
            seedScriptId,
          );
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
    log.info("[browser-view] native tab ensure stage", {
      kind: "electron_tab_create",
      stage: "target_activated",
      outcome: "ok",
      hostId: input.hostId,
      sessionId: input.sessionId,
      tabId: input.tabId,
      durationMs: Date.now() - startedAt,
    });
  }

  private resolveNativeTabProvisioned(
    entry: BrowserViewEntry,
  ): BrowserViewNativeTabCapability {
    if (entry.identity.kind !== "native") {
      throw new Error("Cannot provision an unmanaged browser guest.");
    }
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

  applyStorageState(
    input: BrowserViewStorageStateApply,
  ): Promise<BrowserViewStorageStateApplyResult> {
    return this.applyStorageStateToBrowser(input);
  }

  captureStorageState(
    windowId: string,
    input: BrowserViewStorageStateCapture,
  ): Promise<BrowserViewStorageStateCaptureResult> {
    const entry = this.entries.getSurfaceByKey(
      entryKeyId({ ...input, windowId }),
    );
    if (entry === undefined) {
      throw new Error("Browser view tile is not available for storage capture");
    }
    return this.captureStorageStateFromBrowser(input, entry.view.webContents);
  }

  capturePrimaryProfile(): Promise<BrowserPrimaryProfileCaptureResult> {
    return this.capturePrimaryProfileFromBrowser(
      this.recentPrimaryProfileOrigins.map((origin) => ({
        origin: origin.origin,
        localStorage: origin.localStorage,
      })),
    );
  }

  updateBounds(windowId: string, input: BrowserViewBoundsUpdate): void {
    const entry = this.entries.getSurfaceByKey(
      entryKeyId({ ...input, windowId }),
    );
    if (entry === undefined) return;
    const bounds = normalizeBounds(input.bounds);
    entry.bounds = bounds;
    this.applyEntryBounds(entry);
    this.applyEntryVisibility(entry);
  }

  setViewportPreset(
    windowId: string,
    input: BrowserViewViewportPresetChange,
  ): void {
    const entry = this.findUnmanagedSurfaceEntry(windowId, input);
    if (entry === null) return;
    this.setEntryViewportPreset(entry, input.viewportPreset);
  }

  releaseTile(windowId: string, input: BrowserViewTileKey): void {
    const keyId = entryKeyId({ ...input, windowId });
    const entry = this.entries.getSurfaceByKey(keyId);
    if (entry === undefined || entry.identity.kind !== "unmanaged") return;
    this.detachEntrySurface(entry, "preserve-geometry");
  }

  private detachEntrySurface(
    entry: BrowserViewEntry,
    geometry: "clear-geometry" | "preserve-geometry",
  ): void {
    const surface = entry.surface;
    if (surface === null) return;
    const keyId = entryKeyId(surface);
    this.cancelDebugSnapshot(entry);
    this.tileFrames.detach(keyId);
    this.endAnnotationSession(entry, "tile-close");
    for (const overlayId of entry.overlayOwnerIds) {
      const keys = this.overlayEntryKeysByOwnerId.get(overlayId) ?? [];
      this.overlayEntryKeysByOwnerId.set(
        overlayId,
        keys.filter((candidate) => candidate !== keyId),
      );
    }
    entry.overlayOwnerIds = [];
    entry.overlayAwaitingPaintAck = false;
    entry.overlayParked = false;
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
    if (geometry === "clear-geometry") {
      entry.bounds = null;
      entry.lastAppliedBounds = null;
    }
    entry.rendererResetPending = false;
    this.detachHostWindowResetListenerIfUnused(surface.windowId);
  }

  reloadTile(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.findUnmanagedSurfaceEntry(windowId, input);
    if (entry === null) return;
    this.reloadEntry(entry);
  }

  private reloadEntry(entry: BrowserViewEntry): void {
    this.setStatus(entry, "loading", null);
    this.invalidateOverlaySnapshot(entry, "reload");
    entry.view.webContents.reload();
    this.applyEntryVisibility(entry);
  }

  goBack(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.findUnmanagedSurfaceEntry(windowId, input);
    if (entry === null) return;
    this.moveEntryInHistory(entry, "back");
  }

  goForward(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.findUnmanagedSurfaceEntry(windowId, input);
    if (entry === null) return;
    this.moveEntryInHistory(entry, "forward");
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
    const canMove =
      direction === "back"
        ? this.readCanGoBack(navigationHistory)
        : this.readCanGoForward(navigationHistory);
    if (canMove !== true) {
      this.emitStatus(entry);
      return;
    }
    this.setStatus(entry, "loading", null);
    this.invalidateOverlaySnapshot(
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
    this.applyEntryVisibility(entry);
  }

  findInPage(windowId: string, input: BrowserViewFindRequest): void {
    const entry = this.entries.getSurfaceByKey(
      entryKeyId({ ...input, windowId }),
    );
    if (entry === undefined) return;
    if (input.query.length === 0) {
      this.stopFindInPage(windowId, input);
      return;
    }
    const sameAppSession =
      entry.findState.appRequestId === input.requestId &&
      entry.findState.query === input.query &&
      entry.findState.matchCase === input.matchCase;
    const sessionsByElectronRequestId = sameAppSession
      ? new Map(entry.findState.sessionsByElectronRequestId)
      : new Map<number, BrowserViewEntryFindSession>();
    entry.findState = {
      appRequestId: input.requestId,
      query: input.query,
      matchCase: input.matchCase,
      sessionsByElectronRequestId,
    };
    this.emitFind(entry, {
      appRequestId: input.requestId,
      query: input.query,
      matchCase: input.matchCase,
      status: "searching",
      current: 0,
      total: 0,
      finalUpdate: false,
      errorMessage: null,
    });
    try {
      const electronRequestId = entry.view.webContents.findInPage(input.query, {
        forward: input.forward,
        findNext: input.findNext,
        matchCase: input.matchCase,
      });
      sessionsByElectronRequestId.set(electronRequestId, {
        appRequestId: input.requestId,
        query: input.query,
        matchCase: input.matchCase,
      });
    } catch (err) {
      log.warn("[browser-view] findInPage failed", {
        error: describeLogError(err),
        webContentsId: entry.view.webContents.id,
      });
      this.emitFind(entry, {
        appRequestId: input.requestId,
        query: input.query,
        matchCase: input.matchCase,
        status: "error",
        current: 0,
        total: 0,
        finalUpdate: true,
        errorMessage: "Browser search failed.",
      });
    }
  }

  stopFindInPage(windowId: string, input: BrowserViewFindStop): void {
    const entry = this.entries.getSurfaceByKey(
      entryKeyId({ ...input, windowId }),
    );
    if (entry === undefined) return;
    entry.findState = {
      appRequestId: input.requestId,
      query: "",
      matchCase: entry.findState.matchCase,
      sessionsByElectronRequestId: new Map(),
    };
    entry.view.webContents.stopFindInPage("clearSelection");
    this.emitFind(entry, {
      appRequestId: input.requestId,
      query: "",
      matchCase: entry.findState.matchCase,
      status: "idle",
      current: 0,
      total: 0,
      finalUpdate: true,
      errorMessage: null,
    });
  }

  zoomIn(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.findUnmanagedSurfaceEntry(windowId, input);
    if (entry === null) return;
    this.applyZoomStep(entry, 1);
  }

  zoomOut(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.findUnmanagedSurfaceEntry(windowId, input);
    if (entry === null) return;
    this.applyZoomStep(entry, -1);
  }

  resetZoom(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.findUnmanagedSurfaceEntry(windowId, input);
    if (entry === null) return;
    this.trySetEntryZoom(entry, 1);
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
    this.reloadTile(windowId, input);
  }

  async occludeForOverlay(
    windowId: string,
    input: BrowserViewOverlayOcclusion,
  ): Promise<BrowserViewOverlayOcclusionResult> {
    const previousKeyIds =
      this.overlayEntryKeysByOwnerId.get(input.overlayId) ?? [];
    const nextKeyIds = input.tiles.map((tile) =>
      entryKeyId({ ...tile, windowId }),
    );
    const nextKeyIdSet = new Set(nextKeyIds);
    const released = previousKeyIds.filter((keyId) => !nextKeyIdSet.has(keyId));
    const restoredTiles = this.releaseOverlayEntries(input.overlayId, released);
    this.overlayEntryKeysByOwnerId.set(input.overlayId, nextKeyIds);

    const snapshots = await Promise.all(
      nextKeyIds.map((keyId) =>
        this.occludeEntryForOverlay(input.overlayId, keyId),
      ),
    );

    // An overlay scan can race tile teardown. Log the all-missing case once
    // per scan rather than once per tile.
    const matchedCount = nextKeyIds.filter((keyId) =>
      this.entries.hasSurfaceKey(keyId),
    ).length;
    if (nextKeyIds.length > 0 && matchedCount === 0) {
      log.info("[browser-view] occlude for overlay: no matching entries", {
        overlayId: input.overlayId,
        requestedCount: nextKeyIds.length,
        matchedCount,
      });
    }

    return {
      snapshots: snapshots.filter(
        (snapshot): snapshot is BrowserViewOverlaySnapshot => snapshot !== null,
      ),
      restoredTiles,
    };
  }

  releaseOverlay(
    _windowId: string,
    input: BrowserViewOverlayRelease,
  ): BrowserViewOverlayReleaseResult {
    const keyIds = this.overlayEntryKeysByOwnerId.get(input.overlayId) ?? [];
    this.overlayEntryKeysByOwnerId.delete(input.overlayId);
    return {
      restoredTiles: this.releaseOverlayEntries(input.overlayId, keyIds),
    };
  }

  async startPipCapture(
    windowId: string,
    input: PipCaptureStartInput,
    onFrame: (payload: PipCaptureIpcPayload) => void,
  ): Promise<boolean> {
    const entry = this.findExactNativeEntry(input);
    if (entry === null) return false;
    this.stopPipCapture();
    if (
      !this.prepareEntryForPipCapture(entry, windowId, {
        width: input.maxWidth,
        height: input.maxHeight,
      })
    ) {
      return false;
    }
    const session = this.ensureDebugSession(entry);
    this.pipCaptureEntry = entry;
    try {
      await session.startPipCapture({
        maxWidth: input.maxWidth,
        maxHeight: input.maxHeight,
        quality: input.quality,
        onFrame,
      });
    } catch (err) {
      if (this.pipCaptureEntry === entry) this.pipCaptureEntry = null;
      session.stopPipCapture();
      this.restoreEntryAfterPipCapture(entry);
      throw err;
    }
    if (!session.isPipCapturing() && this.pipCaptureEntry === entry) {
      this.pipCaptureEntry = null;
      this.restoreEntryAfterPipCapture(entry);
    }
    return session.isPipCapturing();
  }

  stopPipCapture(): void {
    const entry = this.pipCaptureEntry;
    this.pipCaptureEntry = null;
    entry?.debugSession?.stopPipCapture();
    if (entry !== null) this.restoreEntryAfterPipCapture(entry);
  }

  private restoreEntryAfterPipCapture(entry: BrowserViewEntry): void {
    if (entry.surface !== null) {
      this.applyEntryBounds(entry);
      this.applyEntryVisibility(entry);
      return;
    }
    const window =
      entry.parentWindowId === null
        ? null
        : this.getWindow(entry.parentWindowId);
    if (window !== null && !window.isDestroyed()) {
      window.contentView.removeChildView(entry.view);
    }
    entry.parentWindowId = null;
    entry.bounds = null;
    entry.lastAppliedBounds = null;
    entry.view.setVisible(false);
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
    const dataUrl = (await entry.view.webContents.capturePage()).toDataURL();
    const image = parseCapturedDataUrl(dataUrl);
    return {
      ...toTileKey(surface),
      ...image,
      capturedAt: Date.now(),
    };
  }

  getDebugSnapshot(
    windowId: string,
    input: BrowserViewTileKey,
  ): BrowserViewDebugSnapshotChange {
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

  clearDebugEvents(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.entries.getSurfaceByKey(
      entryKeyId({ ...input, windowId }),
    );
    if (entry === undefined) return;
    if (entry.debugSession === null) {
      this.queueDebugSnapshot(entry);
      return;
    }
    entry.debugSession.clear();
  }

  setAnnotationTargetChatLabel(
    windowId: string,
    input: BrowserAnnotationSetTargetChatLabelInput,
  ): void {
    const entry = this.entries.getSurfaceByKey(
      entryKeyId({ ...input, windowId }),
    );
    if (entry === undefined) return;
    const session = entry.annotationSession;
    if (session === null || !session.isActive()) return;
    void session.setTargetChatLabel(input.targets, input.defaultChatId);
  }

  startAnnotation(
    windowId: string,
    input: BrowserViewTileKey,
  ): Promise<BrowserAnnotationStartResult> {
    const entry = this.entries.getSurfaceByKey(
      entryKeyId({ ...input, windowId }),
    );
    if (entry === undefined) {
      return Promise.resolve({ ok: false, reason: "tile-not-found" });
    }
    if (entry.status !== "ready") {
      return Promise.resolve({ ok: false, reason: "page-not-ready" });
    }
    this.endAnnotationSession(entry, "replaced");
    const surface = requireSurface(entry);
    const annotationIdentity =
      entry.identity.kind === "native"
        ? entry.identity.key
        : {
            sessionId: entry.identity.pageSessionId,
            tabId: entry.identity.pageSessionId,
          };
    const session = new BrowserAnnotationSession({
      webContents: entry.view.webContents,
      debugSession: this.ensureDebugSession(entry),
      identity: {
        tabId: annotationIdentity.tabId,
        sessionId: annotationIdentity.sessionId,
      },
      onEvent: (event) => {
        if (entry.annotationSession !== session) return;
        if (event.type === "attachRequested") return;
        this.notifyAnnotationEvent(surface.windowId, {
          ...toTileKey(surface),
          event,
        });
      },
      onAttached: (result) => {
        if (entry.annotationSession !== session) {
          return Promise.resolve(false);
        }
        this.notifyAnnotationAttached(surface.windowId, {
          ...toTileKey(surface),
          targetChatId: result.targetChatId,
          payload: result.payload,
          pngBytes: new Uint8Array(result.pngBytes),
        });
        return this.waitForAnnotationAttachResult({
          windowId: surface.windowId,
          keyId: entryKeyId(surface),
          annotationId: result.payload.annotationId,
        });
      },
    });
    entry.annotationSession = session;
    return session.start().then((result) => {
      if (!result.ok && entry.annotationSession === session) {
        entry.annotationSession = null;
      }
      return result;
    });
  }

  reportAnnotationAttachResult(
    windowId: string,
    input: BrowserAnnotationAttachResultInput,
  ): void {
    const pending = this.pendingAnnotationAttachResults.get(input.annotationId);
    if (pending === undefined) return;
    if (pending.windowId !== windowId) return;
    this.finishAnnotationAttachResult(
      input.annotationId,
      input.status === "attached",
    );
  }

  private waitForAnnotationAttachResult(input: {
    readonly windowId: string;
    readonly keyId: string;
    readonly annotationId: string;
  }): Promise<boolean> {
    this.finishAnnotationAttachResult(input.annotationId, false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finishAnnotationAttachResult(input.annotationId, false);
      }, ANNOTATION_ATTACH_ACK_TIMEOUT_MS);
      this.pendingAnnotationAttachResults.set(input.annotationId, {
        windowId: input.windowId,
        keyId: input.keyId,
        resolve,
        timer,
      });
    });
  }

  private finishAnnotationAttachResult(
    annotationId: string,
    delivered: boolean,
  ): void {
    const pending = this.pendingAnnotationAttachResults.get(annotationId);
    if (pending === undefined) return;
    this.pendingAnnotationAttachResults.delete(annotationId);
    clearTimeout(pending.timer);
    pending.resolve(delivered);
  }

  private failPendingAnnotationAttachResultsForEntry(
    entry: BrowserViewEntry,
  ): void {
    if (entry.surface === null) return;
    const keyId = entryKeyId(entry.surface);
    const annotationIds: string[] = [];
    for (const [annotationId, pending] of this.pendingAnnotationAttachResults) {
      if (pending.keyId === keyId) {
        annotationIds.push(annotationId);
      }
    }
    for (const annotationId of annotationIds) {
      this.finishAnnotationAttachResult(annotationId, false);
    }
  }

  cancelAnnotation(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.entries.getSurfaceByKey(
      entryKeyId({ ...input, windowId }),
    );
    if (entry === undefined) return;
    this.endAnnotationSession(entry, "cancelled");
  }

  openDevTools(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.findUnmanagedSurfaceEntry(windowId, input);
    if (entry === null) return;
    this.openEntryDevTools(entry, windowId);
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

  private endAnnotationSession(
    entry: BrowserViewEntry,
    reason: BrowserAnnotationEndReason,
  ): void {
    const session = entry.annotationSession;
    if (session === null) return;
    this.failPendingAnnotationAttachResultsForEntry(entry);
    session.dispose(reason);
    if (entry.annotationSession === session) {
      entry.annotationSession = null;
    }
  }

  dispose(): void {
    this.offWindowChange();
    this.offDownloadChange();
    this.offCertificateError();
    if (this.boundsStreamLogTimer !== null) {
      clearTimeout(this.boundsStreamLogTimer);
      this.boundsStreamLogTimer = null;
    }
    if (this.evictionSweepTimer !== null) {
      clearTimeout(this.evictionSweepTimer);
      this.evictionSweepTimer = null;
    }
    this.tileFrames.detachAll();
    for (const entry of Array.from(this.entries.guestValues())) {
      void this.closeEntry(entry, "gui-quit");
    }
    for (const popup of Array.from(this.popupEntriesByWebContentsId.values())) {
      this.closePopupEntry(popup, true);
    }
    for (const task of this.pendingDebugSnapshotsByKey.values()) {
      task.cancel();
    }
    this.pendingDebugSnapshotsByKey.clear();
    this.overlayEntryKeysByOwnerId.clear();
    for (const annotationId of Array.from(
      this.pendingAnnotationAttachResults.keys(),
    )) {
      this.finishAnnotationAttachResult(annotationId, false);
    }
  }

  async drainBrowserHandoffs(): Promise<void> {
    await Promise.all(
      Array.from(this.entries.guestValues())
        .filter(
          (entry) =>
            entry.status !== "dead" &&
            entry.identity.kind === "native" &&
            entry.identity.lifecycle.canHandoff,
        )
        .map((entry) => this.pushElectronTabHandoff(entry, "gui-quit")),
    );
  }

  private createEntry(
    surface: BrowserViewEntryKey | null,
    requestedUrl: string,
    viewportPreset: BrowserViewViewportPresetId,
    navigateNow: boolean,
    identity: BrowserViewGuestIdentity,
  ): BrowserViewEntry {
    const view = this.createView();
    const entry: BrowserViewEntry = {
      surface,
      surfaceBindingId: null,
      guestKey:
        identity.kind === "native"
          ? nativeGuestKey(identity.key)
          : unmanagedGuestKey(identity.pageSessionId),
      identity,
      view,
      listeners: {
        beforeInputEvent: (event, input) => {
          this.handleBeforeInputEvent(entry, event, input);
        },
        didCreateWindow: (window) => {
          this.handleDidCreateWindow(entry, window);
        },
        didFrameNavigate: (_event, url, _code, _text, isMainFrame) => {
          this.handleCommittedNavigation(entry, url, isMainFrame);
        },
        didFrameFinishLoad: () => {
          if (entry.internalNavigation) return;
          this.invalidateOverlaySnapshot(entry, "frame-finish-load");
        },
        didFinishLoad: () => {
          if (entry.internalNavigation) return;
          this.invalidateOverlaySnapshot(entry, "finish-load");
          this.rememberPrimaryProfileOrigin(entry);
        },
        didNavigate: (_event, url) => {
          this.handleCommittedNavigation(entry, url, true);
        },
        didStartNavigation: (_event, _url, isInPlace, isMainFrame) => {
          this.handleViewStartNavigation(entry, isInPlace, isMainFrame);
        },
        didNavigateInPage: (_event, url, isMainFrame) => {
          this.handleInPageNavigation(entry, url, isMainFrame);
        },
        foundInPage: (_event, result) => {
          this.handleFoundInPage(entry, result);
        },
        pageTitleUpdated: () => {
          if (entry.internalNavigation) return;
          entry.currentTitle = entry.view.webContents.getTitle();
          this.invalidateOverlaySnapshot(entry, "page-title-updated");
          this.emitStatus(entry);
        },
        paint: () => {
          this.invalidateOverlaySnapshot(entry, "paint");
        },
        renderProcessGone: (_event, details) => {
          this.handleRenderProcessGone(entry, details.reason);
        },
      },
      parentWindowId: null,
      desiredVisible: false,
      bounds: null,
      lastAppliedBounds: null,
      lastVisibleAtMs: 0,
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
      viewportPreset,
      overlayOwnerIds: [],
      overlaySnapshotStale: false,
      overlayAwaitingPaintAck: false,
      overlayParked: false,
      lastLoggedVisible: null,
      rendererResetPending: false,
      closePromise: null,
      internalNavigation: false,
    };
    const webContents = view.webContents;
    webContents.setWindowOpenHandler((details) =>
      this.handleWindowOpen(entry, details),
    );
    webContents.on("before-input-event", entry.listeners.beforeInputEvent);
    webContents.on("did-create-window", entry.listeners.didCreateWindow);
    webContents.on("did-frame-navigate", entry.listeners.didFrameNavigate);
    webContents.on("did-frame-finish-load", entry.listeners.didFrameFinishLoad);
    webContents.on("did-finish-load", entry.listeners.didFinishLoad);
    webContents.on("did-navigate", entry.listeners.didNavigate);
    webContents.on("did-start-navigation", entry.listeners.didStartNavigation);
    webContents.on("did-navigate-in-page", entry.listeners.didNavigateInPage);
    webContents.on("found-in-page", entry.listeners.foundInPage);
    webContents.on("page-title-updated", entry.listeners.pageTitleUpdated);
    webContents.on("paint", entry.listeners.paint);
    webContents.on("render-process-gone", entry.listeners.renderProcessGone);
    this.entries.register(entry);
    if (navigateNow) void this.navigate(entry, requestedUrl, false);
    log.info("[browser-view] view created", {
      guestKey: guestEntryKey(entry),
      surfaceKeyId: surface === null ? null : entryKeyId(surface),
      viewportPreset,
      navigateNow,
    });
    return entry;
  }

  private findTransferableEntry(
    key: BrowserViewEntryKey,
  ): BrowserViewEntry | null {
    return this.entries.getGuest(unmanagedGuestKey(key.pageSessionId)) ?? null;
  }

  private findExactNativeEntry(
    capability: BrowserViewNativeTabCapability,
  ): BrowserViewEntry | null {
    const entry = this.entries.getGuest(nativeGuestKey(capability));
    if (entry?.identity.kind !== "native") return null;
    if (entry.identity.registrationId !== capability.registrationId)
      return null;
    if (entry.closePromise !== null) return null;
    return entry;
  }

  private findUnmanagedSurfaceEntry(
    windowId: string,
    key: BrowserViewTileKey,
  ): BrowserViewEntry | null {
    const entry = this.entries.getSurfaceByKey(
      entryKeyId({ ...key, windowId }),
    );
    return entry?.identity.kind === "unmanaged" ? entry : null;
  }

  private rekeyEntry(entry: BrowserViewEntry, key: BrowserViewEntryKey): void {
    this.cancelDebugSnapshot(entry);
    const previousSurface = entry.surface;
    const previousKeyId =
      previousSurface === null ? null : entryKeyId(previousSurface);
    const nextKeyId = entryKeyId(key);
    // The frame-cache slot is keyed by entry key; drop the stale slot so the
    // next visibility pass re-attaches under the new key (BT-202).
    if (previousKeyId !== null) {
      this.tileFrames.detach(previousKeyId);
    }
    this.entries.bindSurface(entry, key);
    for (const overlayId of entry.overlayOwnerIds) {
      const overlayKeyIds = this.overlayEntryKeysByOwnerId.get(overlayId);
      if (overlayKeyIds === undefined) continue;
      this.overlayEntryKeysByOwnerId.set(
        overlayId,
        overlayKeyIds.map((keyId) =>
          previousKeyId !== null && keyId === previousKeyId ? nextKeyId : keyId,
        ),
      );
    }
    if (previousSurface !== null && previousSurface.windowId !== key.windowId) {
      this.detachHostWindowResetListenerIfUnused(previousSurface.windowId);
    }
  }

  private async navigate(
    entry: BrowserViewEntry,
    url: string,
    rejectOnFailure: boolean,
  ): Promise<void> {
    this.endAnnotationSession(entry, "navigation");
    entry.requestedUrl = url;
    entry.status = "loading";
    entry.statusReason = null;
    entry.certificateError = null;
    this.invalidateOverlaySnapshot(entry, "navigation-started");
    this.emitStatus(entry);
    try {
      await entry.view.webContents.loadURL(url);
    } catch (err: unknown) {
      log.warn("[browser-view] loadURL failed", {
        error: describeLogError(err),
        url,
      });
      if (this.isEntryCurrent(entry)) {
        this.setStatus(entry, "dead", "Navigation failed");
        this.applyEntryVisibility(entry);
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
    this.endAnnotationSession(entry, "navigation");
  }

  private handleCommittedNavigation(
    entry: BrowserViewEntry,
    url: string,
    isMainFrame: boolean,
  ): void {
    if (entry.internalNavigation) return;
    if (!isMainFrame) return;
    entry.currentUrl = url;
    entry.requestedUrl = url;
    entry.currentTitle = entry.view.webContents.getTitle();
    this.rememberPrimaryProfileOrigin(entry);
    entry.certificateError = null;
    this.invalidateOverlaySnapshot(entry, "navigation-committed");
    this.setStatus(entry, "ready", null);
    this.enableDebugAfterCommit(entry);
    this.applyEntryVisibility(entry);
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
    this.rememberPrimaryProfileOrigin(entry);
    this.endAnnotationSession(entry, "navigation");
    this.invalidateOverlaySnapshot(entry, "in-page-navigation");
    this.emitStatus(entry);
  }

  private handleRenderProcessGone(
    entry: BrowserViewEntry,
    detail: string,
  ): void {
    this.endAnnotationSession(entry, "crash");
    this.invalidateOverlaySnapshot(entry, "render-process-gone");
    this.setStatus(entry, "dead", detail);
    this.applyEntryVisibility(entry);
    void this.closeEntry(entry, "crash-no-capture");
  }

  private rememberPrimaryProfileOrigin(entry: BrowserViewEntry): void {
    const origin = httpOrigin(entry.currentUrl);
    if (origin === null) return;
    this.primaryProfileVisitSequence += 1;
    const visitSequence = this.primaryProfileVisitSequence;
    void this.capturePrimaryProfileLocalStorageFromBrowser(
      origin,
      entry.view.webContents,
    )
      .then((snapshot) => {
        if (snapshot === null) return;
        const newer = this.recentPrimaryProfileOrigins.find(
          (candidate) =>
            candidate.origin === origin &&
            candidate.visitSequence > visitSequence,
        );
        if (newer !== undefined) return;
        const withoutOrigin = this.recentPrimaryProfileOrigins.filter(
          (candidate) => candidate.origin !== origin,
        );
        withoutOrigin.push({ ...snapshot, visitSequence });
        withoutOrigin.sort(
          (left, right) => right.visitSequence - left.visitSequence,
        );
        this.recentPrimaryProfileOrigins.splice(
          0,
          this.recentPrimaryProfileOrigins.length,
          ...withoutOrigin.slice(0, PRIMARY_PROFILE_LOCAL_STORAGE_ORIGIN_LIMIT),
        );
      })
      .catch(() => {
        // localStorage capture is best-effort; cookies remain authoritative.
      });
  }

  private handleFoundInPage(entry: BrowserViewEntry, result: Result): void {
    const session = entry.findState.sessionsByElectronRequestId.get(
      result.requestId,
    );
    if (session === undefined) return;
    this.emitFind(entry, {
      appRequestId: session.appRequestId,
      query: session.query,
      matchCase: session.matchCase,
      status: "ready",
      current: result.matches > 0 ? result.activeMatchOrdinal : 0,
      total: result.matches,
      finalUpdate: result.finalUpdate,
      errorMessage: null,
    });
  }

  private handleBeforeInputEvent(
    entry: BrowserViewEntry,
    event: Event,
    input: Input,
  ): void {
    if (input.type !== "keyDown") return;
    // BT-302: reserved app chords win before the guest sees them. The chord
    // set is registered by the renderer; only interceptable+forwardable
    // chords are claimed, so pages keep everything the app cannot replay.
    const reserved = this.matchReservedChord(input);
    if (reserved !== null) {
      event.preventDefault();
      this.forwardReservedChordToHostWindow(entry, reserved);
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

  private matchReservedChord(input: Input): ReservedChord | null {
    if (this.reservedChords.length === 0) return null;
    const event = reservedChordFromKeyEvent(
      {
        key: input.key,
        control: input.control === true,
        meta: input.meta === true,
        shift: input.shift === true,
        alt: input.alt === true,
      },
      this.hostPlatform,
    );
    if (event === null) return null;
    return (
      this.reservedChords.find((chord) =>
        reservedChordMatchesEvent(chord, event),
      ) ?? null
    );
  }

  /**
   * Replay a matched chord into the owning window's host renderer so its own
   * keybindings fire as if the guest never had focus. Unforwardable chords
   * are never intercepted in the first place (see matchReservedChord's
   * keyCode gate at registration time).
   */
  private forwardReservedChordToHostWindow(
    entry: BrowserViewEntry,
    chord: ReservedChord,
  ): void {
    const keyCode = hostSendKeyCodeForToken(chord.key);
    if (keyCode === null) return;
    const surface = entry.surface;
    if (surface === null) return;
    const window = this.getWindow(surface.windowId);
    const hostWebContents =
      window === null || window.isDestroyed() ? null : window.webContents;
    if (hostWebContents === null) return;
    const modifiers: BrowserViewInputModifier[] = [];
    if (chord.mod)
      modifiers.push(this.hostPlatform === "darwin" ? "meta" : "control");
    if (chord.ctrl) modifiers.push("control");
    if (chord.shift) modifiers.push("shift");
    if (chord.alt) modifiers.push("alt");
    hostWebContents.sendInputEvent({
      type: "keyDown",
      keyCode,
      modifiers,
    });
  }

  /** BT-303 wire-in: replace the registered chord set at runtime. */
  setReservedChords(tokens: readonly string[]): void {
    const parsed: ReservedChord[] = [];
    for (const token of tokens) {
      if (typeof token !== "string") continue;
      const base = parseReservedChordToken(token);
      if (base === null) continue;
      // Only claim chords we can actually replay to the host window.
      if (hostSendKeyCodeForToken(base.key) === null) continue;
      parsed.push(resolveReservedChordForPlatform(base, this.hostPlatform));
    }
    this.reservedChords = parsed;
    log.info("[browser-view] reserved chords updated", {
      count: parsed.length,
      tokens: tokens.filter((token) => typeof token === "string"),
    });
  }

  private handleWindowOpen(
    entry: BrowserViewEntry,
    details: BrowserViewWindowOpenDetails,
  ): BrowserViewWindowOpenResult {
    const surface = entry.surface;
    if (surface === null) return { action: "deny" };
    // Decision #22: real popups keep opener, while target=_blank gets a tile.
    // Electron exposes featureless scripted window.open the same as _blank
    // tab opens, so the available guardrail is non-empty popup features.
    if (windowOpenShouldCreateTile(details)) {
      this.notifyOpenTileRequest(surface.windowId, {
        ...toTileKey(surface),
        url: normalizeOpenedUrl(details.url, entry.currentUrl),
        disposition: details.disposition,
      });
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: this.createPopupWindowOptions(
        surface.windowId,
      ),
      outlivesOpener: false,
    };
  }

  private handleDidCreateWindow(
    entry: BrowserViewEntry,
    window: BrowserViewPopupWindow,
  ): void {
    const surface = entry.surface;
    if (surface === null) {
      window.close();
      return;
    }
    this.registerPopupWebContents(window.webContents);
    const popupId = `${surface.tileInstanceId}:${window.webContents.id}`;
    const popupEntry: BrowserViewPopupEntry = {
      popupId,
      openerKey: surface,
      window,
      listeners: {
        closed: () => {
          this.closePopupEntry(popupEntry, false);
        },
        renderProcessGone: (_event, details) => {
          log.warn("[browser-view] popup renderer gone", {
            popupId,
            reason: details.reason,
          });
        },
      },
    };
    this.popupEntriesByWebContentsId.set(window.webContents.id, popupEntry);
    window.on("closed", popupEntry.listeners.closed);
    window.webContents.on(
      "render-process-gone",
      popupEntry.listeners.renderProcessGone,
    );
    log.info("[browser-view] popup created", {
      popupId,
      openerWebContentsId: entry.view.webContents.id,
      popupWebContentsId: window.webContents.id,
    });
  }

  private closePopupEntry(
    entry: BrowserViewPopupEntry,
    closeWindow: boolean,
  ): void {
    this.popupEntriesByWebContentsId.delete(entry.window.webContents.id);
    entry.window.off("closed", entry.listeners.closed);
    entry.window.webContents.off(
      "render-process-gone",
      entry.listeners.renderProcessGone,
    );
    if (closeWindow && !entry.window.isDestroyed()) {
      entry.window.close();
    }
  }

  private handleDownloadChange(change: BrowserSessionDownloadChange): void {
    const entry = this.findEntryByWebContentsId(change.webContentsId);
    if (entry !== null && entry.surface !== null) {
      this.notifyDownload(entry.surface.windowId, {
        ...toTileKey(entry.surface),
        downloadId: change.downloadId,
        url: change.url,
        filename: change.filename,
        mimeType: change.mimeType,
        totalBytes: change.totalBytes,
        receivedBytes: change.receivedBytes,
        state: change.state,
        savePath: change.savePath,
        dangerType: change.dangerType,
        canCancel: change.canCancel,
      });
      return;
    }
    const popup = this.popupEntriesByWebContentsId.get(change.webContentsId);
    if (popup !== undefined) {
      log.info("[browser-view] popup download state", {
        popupId: popup.popupId,
        state: change.state,
        filename: change.filename,
      });
    }
  }

  private handleCertificateError(
    change: BrowserSessionCertificateErrorChange,
  ): void {
    const entry = this.findEntryByWebContentsId(change.webContentsId);
    if (entry !== null && entry.surface !== null) {
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
      this.notifyCertificateError(entry.surface.windowId, tileChange);
      this.setStatus(entry, "dead", "Certificate error");
      this.applyEntryVisibility(entry);
      return;
    }
    const popup = this.popupEntriesByWebContentsId.get(change.webContentsId);
    if (popup !== undefined) {
      log.warn("[browser-view] popup certificate error", {
        popupId: popup.popupId,
        hostname: change.hostname,
        error: change.error,
      });
    }
  }

  private findEntryByWebContentsId(
    webContentsId: number,
  ): BrowserViewEntry | null {
    for (const entry of this.entries.guestValues()) {
      if (entry.view.webContents.id === webContentsId) return entry;
    }
    return null;
  }

  private async occludeEntryForOverlay(
    overlayId: string,
    keyId: string,
  ): Promise<BrowserViewOverlaySnapshot | null> {
    const entry = this.entries.getSurfaceByKey(keyId);
    if (entry === undefined) return null;
    if (entry.overlayOwnerIds.includes(overlayId)) return null;

    if (entry.overlayOwnerIds.length > 0) {
      // Already parked for another overlay; the view stays offscreen-visible
      // and no new pixels are needed.
      entry.overlayOwnerIds.push(overlayId);
      return null;
    }

    // BT-202: paint from the rolling frame cache when it has a slot. This is
    // the instant path (no capture round-trip); `stale` reports whether the
    // cached frame is older than the freshness window. Only a cold cache
    // (first-ever occlusion for this tile, or the feed never ran) pays for
    // capturePage.
    const cached = this.tileFrames.get(keyId);
    let dataUrl: string | null = cached?.dataUrl ?? null;
    let stale = false;
    if (cached !== null) {
      stale = !this.tileFrames.isFresh(keyId);
    } else {
      try {
        dataUrl = (await entry.view.webContents.capturePage()).toDataURL();
      } catch (err) {
        log.warn("[browser-view] overlay snapshot capture failed", {
          error: describeLogError(err),
          webContentsId: entry.view.webContents.id,
        });
      }
    }

    const activeKeyIds = this.overlayEntryKeysByOwnerId.get(overlayId) ?? [];
    if (!activeKeyIds.includes(keyId)) return null;
    const currentEntry = this.entries.getSurfaceByKey(keyId);
    if (currentEntry === undefined) return null;

    currentEntry.overlayOwnerIds.push(overlayId);
    currentEntry.overlaySnapshotStale = false;
    // BT-202 flicker fix: DO NOT park here. The native view must stay on
    // screen until the renderer has DECODED and PAINTED the replacement
    // frame — otherwise there is a guaranteed multi-frame window where the
    // page pixels are gone but nothing covers the tile yet (the reported
    // empty-state flash). The renderer acknowledges via `paintAckOverlay`
    // once img.decode() settles; only then do we move the view offscreen.
    currentEntry.overlayAwaitingPaintAck = true;
    return {
      ...toTileKey(requireSurface(currentEntry)),
      dataUrl,
      stale,
    };
  }

  /**
   * BT-202: instead of hiding an occluded view (which stops its compositor
   * and freezes the frame cache forever), park it fully offscreen while
   * remaining visible. The renderer paints the snapshot over the vacated
   * region exactly as before; under long-lived menus the cache keeps
   * converging toward fresh content instead of freezing at occlusion time.
   * Unusable geometry falls back to the legacy hide.
   */
  /**
   * BT-202 flicker fix: renderer-side acknowledgement that the replacement
   * frame for `overlayId`'s tiles is decoded and on screen. Parks every
   * still-owned, still-pending entry exactly once. Late or duplicate acks —
   * including after a release — are silent no-ops.
   */
  paintAckOverlay(overlayId: string): void {
    const keyIds = this.overlayEntryKeysByOwnerId.get(overlayId) ?? [];
    for (const keyId of keyIds) {
      const entry = this.entries.getSurfaceByKey(keyId);
      if (entry === undefined) continue;
      if (!entry.overlayOwnerIds.includes(overlayId)) continue;
      if (!entry.overlayAwaitingPaintAck) continue;
      entry.overlayAwaitingPaintAck = false;
      this.parkEntryForOverlay(entry);
    }
  }

  private parkEntryForOverlay(entry: BrowserViewEntry): void {
    if (
      entry.bounds === null ||
      entry.bounds.width <= 0 ||
      entry.bounds.height <= 0
    ) {
      entry.view.setVisible(false);
      return;
    }
    const effective = effectiveViewportBounds(
      entry.bounds,
      entry.viewportPreset,
    );
    if (effective.width <= 0 || effective.height <= 0) {
      entry.view.setVisible(false);
      return;
    }
    entry.view.setBounds({
      x: -effective.width,
      y: -effective.height,
      width: effective.width,
      height: effective.height,
    });
    // The view now sits offscreen; forget the last onscreen rect so release
    // re-applies real geometry instead of coalescing against a stale one.
    entry.lastAppliedBounds = null;
    entry.overlayParked = true;
    entry.overlayAwaitingPaintAck = false;
    entry.view.setVisible(true);
  }

  private releaseOverlayEntries(
    overlayId: string,
    keyIds: readonly string[],
  ): BrowserViewTileKey[] {
    return keyIds
      .slice()
      .reverse()
      .flatMap((keyId): BrowserViewTileKey[] => {
        const entry = this.entries.getSurfaceByKey(keyId);
        if (entry === undefined) return [];
        entry.overlayOwnerIds = entry.overlayOwnerIds.filter(
          (ownerId) => ownerId !== overlayId,
        );
        if (entry.overlayOwnerIds.length > 0) {
          return [];
        }
        entry.overlaySnapshotStale = false;
        entry.overlayAwaitingPaintAck = false;
        this.applyEntryBounds(entry);
        this.applyEntryVisibility(entry);
        return [toTileKey(requireSurface(entry))];
      });
  }

  private enableDebugAfterCommit(entry: BrowserViewEntry): void {
    // Visible unmanaged tiles may keep working even if observability fails;
    // native ensureTab explicitly awaits the same promise before announcing
    // the host-owned route as ready.
    void this.ensureDebugSession(entry)
      .enableAfterCommit()
      .catch(() => undefined);
  }

  private ensureDebugSession(entry: BrowserViewEntry): BrowserDebugSession {
    if (entry.debugSession !== null) return entry.debugSession;
    const session = new BrowserDebugSession({
      webContents: entry.view.webContents,
      onSnapshotChange: () => {
        this.queueDebugSnapshot(entry);
      },
      onDetached: (reason) => {
        this.handleDebugSessionDetached(entry, reason);
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
    reason: string,
  ): void {
    log.warn("[browser-view] debugger detached", {
      reason,
      webContentsId: entry.view.webContents.id,
    });
    this.endAnnotationSession(entry, "crash");
    if (this.pipCaptureEntry === entry) this.stopPipCapture();
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

  private queueDebugSnapshot(entry: BrowserViewEntry): void {
    if (entry.surface === null) return;
    const keyId = entryKeyId(entry.surface);
    if (this.pendingDebugSnapshotsByKey.has(keyId)) return;
    const task = this.scheduleDebugSnapshot(() => {
      this.pendingDebugSnapshotsByKey.delete(keyId);
      if (this.entries.getSurfaceByKey(keyId) !== entry) return;
      this.emitDebugSnapshotNow(entry);
    });
    this.pendingDebugSnapshotsByKey.set(keyId, task);
  }

  private cancelDebugSnapshot(entry: BrowserViewEntry): void {
    if (entry.surface === null) return;
    const keyId = entryKeyId(entry.surface);
    const task = this.pendingDebugSnapshotsByKey.get(keyId);
    if (task === undefined) return;
    task.cancel();
    this.pendingDebugSnapshotsByKey.delete(keyId);
  }

  private emitDebugSnapshotNow(entry: BrowserViewEntry): void {
    if (entry.surface === null) return;
    this.notifyDebugSnapshot(entry.surface.windowId, {
      ...toTileKey(entry.surface),
      ...this.readDebugSnapshot(entry),
    });
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
      this.endAnnotationSession(entry, status === "dead" ? "crash" : "reload");
    }
    entry.status = status;
    entry.statusReason = reason;
    this.emitStatus(entry);
  }

  private emitStatus(entry: BrowserViewEntry): void {
    if (entry.internalNavigation) return;
    const webContents = this.readLiveWebContents(entry);
    if (webContents === null) return;
    const navigationState = this.readNavigationState(webContents);
    if (navigationState === null) return;
    const zoomPercent = this.readZoomPercent(webContents);
    if (zoomPercent === null) return;
    const status = {
      url: entry.currentUrl,
      title: entry.currentTitle,
      status: entry.status,
      reason: entry.statusReason,
      canGoBack: navigationState.canGoBack,
      canGoForward: navigationState.canGoForward,
      zoomPercent,
    };
    if (entry.identity.kind === "native") {
      this.notifyNativeTabStatus(entry.identity.lifecycleWindowId, {
        ...entry.identity.key,
        registrationId: entry.identity.registrationId,
        ...status,
        title: status.title === "" ? null : status.title,
      });
    }
    if (entry.surface !== null) {
      this.notifyStatus(entry.surface.windowId, {
        ...toTileKey(entry.surface),
        ...status,
      });
    }
  }

  private isEntryCurrent(entry: BrowserViewEntry): boolean {
    return this.entries.getGuest(guestEntryKey(entry)) === entry;
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

  private readNavigationState(
    webContents: BrowserViewWebContents,
  ): { readonly canGoBack: boolean; readonly canGoForward: boolean } | null {
    const navigationHistory = webContents.navigationHistory;
    if (navigationHistory === undefined) return null;
    const canGoBack = this.readCanGoBack(navigationHistory);
    const canGoForward = this.readCanGoForward(navigationHistory);
    if (canGoBack === null || canGoForward === null) return null;
    return { canGoBack, canGoForward };
  }

  private readCanGoBack(
    navigationHistory: BrowserViewNavigationHistory,
  ): boolean | null {
    try {
      return navigationHistory.canGoBack();
    } catch {
      return null;
    }
  }

  private readCanGoForward(
    navigationHistory: BrowserViewNavigationHistory,
  ): boolean | null {
    try {
      return navigationHistory.canGoForward();
    } catch {
      return null;
    }
  }

  private readZoomPercent(webContents: BrowserViewWebContents): number | null {
    try {
      return zoomPercentFromFactor(webContents.getZoomFactor());
    } catch {
      return null;
    }
  }

  private emitFind(
    entry: BrowserViewEntry,
    result: {
      readonly appRequestId: number;
      readonly query: string;
      readonly matchCase: boolean;
      readonly status: BrowserViewFindChange["status"];
      readonly current: number;
      readonly total: number;
      readonly finalUpdate: boolean;
      readonly errorMessage: string | null;
    },
  ): void {
    if (entry.surface === null) return;
    this.notifyFind(entry.surface.windowId, {
      ...toTileKey(entry.surface),
      requestId: result.appRequestId,
      query: result.query,
      matchCase: result.matchCase,
      status: result.status,
      current: result.current,
      total: result.total,
      finalUpdate: result.finalUpdate,
      errorMessage: result.errorMessage,
    });
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
    this.applyEntryBounds(entry);
    this.applyEntryVisibility(entry);
  }

  private trySetEntryZoom(entry: BrowserViewEntry, factor: number): void {
    if (entry.annotationSession?.zoomLocked() === true) return;
    entry.view.webContents.setZoomFactor(factor);
    this.emitStatus(entry);
  }

  /**
   * Hidden agent-driven tabs are created unbound and without bounds.
   * Native page capture needs the view in a window with a compositor size.
   * Electron returns an empty NativeImage for a setVisible(false) view, so
   * present hidden views fully offscreen for the duration of PiP capture.
   */
  private prepareEntryForPipCapture(
    entry: BrowserViewEntry,
    windowId: string,
    size: { readonly width: number; readonly height: number },
  ): boolean {
    if (entry.surface === null) {
      const window = this.getWindow(windowId);
      if (window === null || window.isDestroyed()) return false;
      window.contentView.addChildView(entry.view);
      entry.parentWindowId = windowId;
    } else {
      this.attachToCurrentWindow(entry);
    }
    if (entry.parentWindowId === null) return false;
    const hasUsableBounds =
      entry.bounds !== null &&
      entry.bounds.width > 0 &&
      entry.bounds.height > 0;
    if (!hasUsableBounds) {
      entry.bounds = {
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
      };
      this.applyEntryBounds(entry);
    }
    entry.view.webContents.setBackgroundThrottling(false);
    this.applyEntryVisibility(entry);
    const captureOffscreen = entry.lastLoggedVisible !== true;
    if (captureOffscreen) {
      const bounds = effectiveViewportBounds(
        entry.bounds ?? { x: 0, y: 0, width: size.width, height: size.height },
        entry.viewportPreset,
      );
      entry.view.setBounds({
        x: -bounds.width,
        y: -bounds.height,
        width: bounds.width,
        height: bounds.height,
      });
      // The view now sits offscreen; forget the last onscreen rect so the
      // next `applyEntryBounds` re-applies real geometry instead of
      // coalescing against a rect that no longer describes the view.
      entry.lastAppliedBounds = null;
      entry.view.setVisible(true);
    }
    log.info("[browser-view] pip capture prepared", {
      keyId: entry.surface === null ? null : entryKeyId(entry.surface),
      attached: entry.parentWindowId !== null,
      bounds: entry.bounds,
      captureOffscreen,
    });
    return true;
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
        (entry.identity.kind === "native" &&
          entry.identity.lifecycleWindowId === windowId),
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
    let affectedCount = 0;
    for (const entry of this.entries.guestValues()) {
      if (
        entry.identity.kind !== "native" ||
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
      entry.rendererResetPending = true;
      affectedCount += 1;
      this.applyEntryVisibility(entry);
    }
    if (affectedCount === 0) return;
    log.info("[browser-view] host window renderer reset: hiding entries", {
      windowId,
      reason,
      detail,
      affectedCount,
    });
  }

  private applyEntryBounds(entry: BrowserViewEntry): void {
    // Parked under an overlay (BT-202): record nothing here — the renderer
    // may keep streaming rects while a menu is open, and applying them would
    // yank the offscreen-parked view back over the popover. The stored
    // rect is applied by the release path.
    if (entry.overlayOwnerIds.length > 0) return;
    if (entry.bounds === null) return;
    const bounds = effectiveViewportBounds(entry.bounds, entry.viewportPreset);
    if (bounds.width <= 0 || bounds.height <= 0) {
      this.boundsStreamStats.recordRejected();
      this.armBoundsStreamLogFlush();
      return;
    }
    if (
      entry.lastAppliedBounds !== null &&
      boundsAreIdentical(bounds, entry.lastAppliedBounds)
    ) {
      this.boundsStreamStats.recordCoalesced();
      this.armBoundsStreamLogFlush();
      return;
    }
    const maxDeltaPx =
      entry.lastAppliedBounds === null
        ? null
        : boundsMaxComponentDelta(entry.lastAppliedBounds, bounds);
    entry.view.setBounds(bounds);
    entry.lastAppliedBounds = bounds;
    this.boundsStreamStats.recordApplied(maxDeltaPx);
    this.armBoundsStreamLogFlush();
  }

  /**
   * BT-101: emit one aggregate `bounds_stream` line per interval window while
   * bounds updates are flowing. The renderer streams rects every animation
   * frame during a resize drag; this keeps the perf lane readable while still
   * exposing call rate, coalesce ratio, and the largest geometry jump.
   */
  private armBoundsStreamLogFlush(): void {
    const flush = (): void => {
      this.boundsStreamLogTimer = null;
      const payload = this.boundsStreamStats.drain(
        this.boundsStreamLogIntervalMs,
      );
      if (payload === null) return;
      log.info("[browser-view] bounds stream", {
        kind: "bounds_stream",
        ...payload,
      });
      this.logFrameCacheStats();
    };
    if (this.boundsStreamLogTimer !== null) return;
    if (!(this.boundsStreamLogIntervalMs > 0)) {
      flush();
      return;
    }
    this.boundsStreamLogTimer = setTimeout(
      flush,
      this.boundsStreamLogIntervalMs,
    );
  }

  /** BT-205: frame-cache counters on the perf lane, deduped while idle. */
  private logFrameCacheStats(): void {
    const stats = this.tileFrames.stats();
    const signature = JSON.stringify(stats);
    if (signature === this.lastFrameCacheStatsSignature) return;
    this.lastFrameCacheStatsSignature = signature;
    log.info("[browser-view] frame cache stats", {
      kind: "frame_cache_stats",
      ...stats,
    });
  }

  /** Forensics hook for tests and support bundles. */
  frameCacheStats(): TileFrameStats {
    return this.tileFrames.stats();
  }

  /**
   * BT-401: coalesced macrotask sweep. A tab switch produces hide(A) then
   * show(B) in quick succession; deferring to a zero-delay timeout lets the
   * pair settle so re-shown guests never count as hidden.
   */
  private scheduleEvictionSweep(): void {
    if (this.evictionSweepTimer !== null) return;
    this.evictionSweepTimer = setTimeout(() => {
      this.evictionSweepTimer = null;
      this.runEvictionSweep();
    }, EVICTION_SWEEP_DELAY_MS);
  }

  private runEvictionSweep(): void {
    const hidden: BrowserViewEntry[] = [];
    for (const entry of this.entries.guestValues()) {
      if (entry.lastLoggedVisible === true) continue;
      if (entry.status === "dead") continue;
      if (this.isEntryEvictionExempt(entry)) continue;
      hidden.push(entry);
    }
    const excess = hidden.length - HIDDEN_GUEST_EVICTION_CAP;
    if (excess <= 0) return;
    hidden.sort((left, right) => left.lastVisibleAtMs - right.lastVisibleAtMs);
    const victims = hidden.slice(0, excess);
    log.info("[browser-view] evicting hidden guests", {
      cap: HIDDEN_GUEST_EVICTION_CAP,
      hiddenCount: hidden.length,
      evicting: victims.map((victim) => guestEntryKey(victim)),
    });
    victims.forEach((victim) => {
      // BT-403 silent reload: the renderer keeps the tile's last known
      // title/favicon/URL from prior status events; the next upsert for this
      // key creates a fresh guest and shows its normal loading skeleton.
      this.evictedKeyIdsLog.push(guestEntryKey(victim));
      victim.status = "dead";
      victim.statusReason = "evicted-hidden";
      this.emitStatus(victim);
      void this.closeEntry(victim, null);
    });
  }

  /** BT-501: applied geometry per entry for the E2E debug surface. */
  debugBoundsByKeyId(): Record<
    string,
    { x: number; y: number; width: number; height: number }
  > {
    const out: Record<
      string,
      { x: number; y: number; width: number; height: number }
    > = {};
    for (const [keyId, entry] of this.entries.surfaceEntries()) {
      if (entry.lastAppliedBounds === null) continue;
      out[keyId] = { ...entry.lastAppliedBounds };
    }
    return out;
  }

  /** BT-501: entries currently parked under an overlay owner. */
  debugOccludedKeyIds(): readonly string[] {
    const out: string[] = [];
    for (const [keyId, entry] of this.entries.surfaceEntries()) {
      if (entry.overlayOwnerIds.length > 0) out.push(keyId);
    }
    return out;
  }

  /** BT-501: guests evicted by the hidden-guest LRU since startup. */
  debugEvictedKeyIds(): readonly string[] {
    return this.evictedKeyIdsLog;
  }

  private isEntryEvictionExempt(entry: BrowserViewEntry): boolean {
    if (entry.identity.kind === "native") return true;
    if (entry.overlayOwnerIds.length > 0) return true; // parked (BT-202)
    if (entry.annotationSession !== null) return true;
    if (this.pipCaptureEntry === entry) return true;
    return false;
  }

  private applyEntryVisibility(entry: BrowserViewEntry): void {
    const surface = entry.surface;
    if (surface === null) {
      entry.lastLoggedVisible = false;
      entry.view.setVisible(false);
      return;
    }
    const window = this.getWindow(surface.windowId);
    // A tile parked under an active overlay (BT-202) keeps its
    // offscreen-visible posture so its compositor keeps feeding the frame
    // cache; visibility is recomputed when the last owner releases. A dead
    // tile must never stay parked-visible, so it falls through instead.
    if (entry.overlayOwnerIds.length > 0 && entry.status !== "dead") {
      return;
    }
    const hasUsableBounds =
      entry.bounds !== null &&
      entry.bounds.width > 0 &&
      entry.bounds.height > 0;
    const visible =
      entry.desiredVisible &&
      entry.overlayOwnerIds.length === 0 &&
      !entry.rendererResetPending &&
      hasUsableBounds &&
      entry.status !== "dead" &&
      window !== null &&
      !window.isDestroyed() &&
      window.isVisible() &&
      !window.isMinimized();
    const wasVisible = entry.lastLoggedVisible;
    if (entry.lastLoggedVisible !== visible) {
      log.info("[browser-view] visibility changed", {
        keyId: entryKeyId(surface),
        visible,
        desiredVisible: entry.desiredVisible,
        overlayOwnerCount: entry.overlayOwnerIds.length,
        rendererResetPending: entry.rendererResetPending,
        hasUsableBounds,
        status: entry.status,
        windowVisible:
          window !== null && !window.isDestroyed() && window.isVisible(),
        windowMinimized:
          window !== null && !window.isDestroyed() && window.isMinimized(),
      });
      entry.lastLoggedVisible = visible;
    }
    entry.view.setVisible(visible);
    this.syncTileFrameFeed(entry, window);
    if (visible) {
      entry.lastVisibleAtMs = Date.now();
    } else if (wasVisible === true) {
      // A guest just went from visible to hidden — it may now count against
      // the eviction cap. Deferred so a switch's hide→show pair settles.
      this.scheduleEvictionSweep();
    }
  }

  /**
   * BT-202: keep a frame-cache slot subscribed exactly while the tile's
   * guest can plausibly produce compositor frames - bound to a live window,
   * wanted visible, usable geometry, not dead. Hidden or detached tiles drop
   * their subscription; re-attaching is cheap.
   */
  private syncTileFrameFeed(
    entry: BrowserViewEntry,
    window: BrowserViewWindow | null,
  ): void {
    const surface = entry.surface;
    if (surface === null) return;
    const keyId = entryKeyId(surface);
    const feedLive =
      entry.desiredVisible &&
      !entry.rendererResetPending &&
      entry.bounds !== null &&
      entry.bounds.width > 0 &&
      entry.bounds.height > 0 &&
      entry.status !== "dead" &&
      !entry.view.webContents.isDestroyed() &&
      window !== null &&
      !window.isDestroyed();
    if (!feedLive) {
      this.tileFrames.detach(keyId);
      return;
    }
    this.tileFrames.attach(keyId, {
      beginFrameSubscription: (callback) => {
        entry.view.webContents.beginFrameSubscription((image) => {
          callback(image);
        });
      },
      endFrameSubscription: () => {
        entry.view.webContents.endFrameSubscription();
      },
    });
  }

  private reconcileWindowVisibility(): void {
    for (const entry of Array.from(this.entries.guestValues())) {
      const surface = entry.surface;
      if (surface === null && this.pipCaptureEntry === entry) {
        const captureWindow =
          entry.parentWindowId === null
            ? null
            : this.getWindow(entry.parentWindowId);
        if (captureWindow !== null && !captureWindow.isDestroyed()) continue;
        this.stopPipCapture();
      }
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
      this.applyEntryVisibility(entry);
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
    if (keyId !== null) this.tileFrames.detach(keyId);
    log.info("[browser-view] view destroy started", {
      keyId,
      handoffReason,
      status: entry.status,
    });
    this.destroyDevToolsWindow(entry);
    this.failPendingAnnotationAttachResultsForEntry(entry);
    this.entries.detachSurface(entry);
    if (surface !== null) {
      this.detachHostWindowResetListenerIfUnused(surface.windowId);
    }
    // Ticket 12 item 2: capture and push before anything below tears the
    // tile down - `webContents` must still be alive for the capture.
    // `entry.status === "dead"` means `handleRenderProcessGone` already
    // fired for this tile (the renderer crashed) - the caller's requested
    // reason is overridden with "crash-no-capture" regardless of which of
    // the three teardown paths is processing it now, since a crashed
    // renderer cannot safely be captured from either way.
    if (
      handoffReason !== null &&
      entry.identity.kind === "native" &&
      entry.identity.lifecycle.accepted
    ) {
      try {
        await this.pushElectronTabHandoff(
          entry,
          entry.status === "dead" ? "crash-no-capture" : handoffReason,
        );
      } catch (error) {
        log.warn("[browser-view] electron tab handoff failed during close", {
          error: describeLogError(error),
          guestKey: guestEntryKey(entry),
          handoffReason,
        });
      }
    }
    // A quit drain or a sibling's aggregate handoff can already be reading
    // this guest. Keep the identity reserved until that capture settles.
    const pendingHandoffCapture =
      entry.identity.kind === "native"
        ? entry.identity.lifecycle.pendingHandoffCapture
        : null;
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
    this.cancelDebugSnapshot(entry);
    const webContents = entry.view.webContents;
    webContents.off("before-input-event", entry.listeners.beforeInputEvent);
    webContents.off("did-create-window", entry.listeners.didCreateWindow);
    webContents.off("did-frame-navigate", entry.listeners.didFrameNavigate);
    webContents.off(
      "did-frame-finish-load",
      entry.listeners.didFrameFinishLoad,
    );
    webContents.off("did-finish-load", entry.listeners.didFinishLoad);
    webContents.off("did-navigate", entry.listeners.didNavigate);
    webContents.off("did-start-navigation", entry.listeners.didStartNavigation);
    webContents.off("did-navigate-in-page", entry.listeners.didNavigateInPage);
    webContents.off("found-in-page", entry.listeners.foundInPage);
    webContents.off("page-title-updated", entry.listeners.pageTitleUpdated);
    webContents.off("paint", entry.listeners.paint);
    webContents.off("render-process-gone", entry.listeners.renderProcessGone);
    entry.annotationSession?.dispose("tile-close");
    entry.annotationSession = null;
    if (this.pipCaptureEntry === entry) this.pipCaptureEntry = null;
    entry.debugSession?.dispose();
    entry.debugSession = null;
    entry.view.setVisible(false);
    webContents.close();
    this.entries.remove(entry);
    if (entry.identity.kind === "native") {
      this.detachHostWindowResetListenerIfUnused(
        entry.identity.lifecycleWindowId,
      );
    }
    log.info("[browser-view] view destroy requested", { keyId });
  }

  private destroyDevToolsWindow(entry: BrowserViewEntry): void {
    const devToolsWindow = entry.devToolsWindow;
    entry.devToolsWindow = null;
    if (devToolsWindow === null || devToolsWindow.isDestroyed()) return;
    devToolsWindow.destroy();
  }

  private invalidateOverlaySnapshot(
    entry: BrowserViewEntry,
    reason: string,
  ): void {
    if (entry.overlayOwnerIds.length === 0) return;
    // BT-202 fix (⌘K white-out): an overlay-parked view stays COMPOSITED on
    // purpose — that is what keeps its frame cache converging toward fresh
    // pixels — so per-frame paint churn under an open overlay must not flip
    // the displayed snapshot to stale. The renderer hides the frozen frame
    // entirely once stale, leaving only bg-background: exactly the blank
    // tile users saw behind the command palette. Content-level changes
    // (navigation, title, crash, load lifecycle) still invalidate.
    if (reason === "paint") return;
    if (!entry.overlaySnapshotStale) {
      entry.overlaySnapshotStale = true;
    }
    if (entry.surface === null) return;
    this.notifySnapshotInvalidated(entry.surface.windowId, {
      ...toTileKey(entry.surface),
      reason,
    });
  }

  /**
   * Claims every still-live native tab in the same host session before the
   * first await, then captures one atomic handoff. The shared promise keeps
   * sibling close paths from destroying their guests during capture.
   */
  private async pushElectronTabHandoff(
    entry: BrowserViewEntry,
    reason: BrowserViewElectronTabHandoffChange["reason"],
  ): Promise<void> {
    if (entry.identity.kind !== "native") return;
    const identity = entry.identity;
    if (!identity.lifecycle.canHandoff) return;
    const siblings = Array.from(this.entries.guestValues()).filter(
      (candidate) =>
        candidate !== entry &&
        candidate.identity.kind === "native" &&
        candidate.identity.key.hostId === identity.key.hostId &&
        candidate.identity.key.sessionId === identity.key.sessionId &&
        candidate.identity.lifecycle.canHandoff,
    );
    const { promise: aggregationPromise, resolve: resolveAggregation } =
      Promise.withResolvers<void>();
    if (!identity.lifecycle.beginHandoffCapture(aggregationPromise)) return;
    for (const sibling of siblings) {
      if (sibling.identity.kind === "native") {
        sibling.identity.lifecycle.beginHandoffCapture(aggregationPromise);
      }
    }
    const capturedUrl = this.readHandoffUrl(entry);
    const capturedSiblings = siblings.map((sibling) => ({
      entry: sibling,
      url: this.readHandoffUrl(sibling),
    }));
    let delivered = false;
    try {
      const capturedStorageState = await this.captureHandoffStorageState(
        entry,
        reason,
        capturedUrl,
      );
      const siblingTabs = await Promise.all(
        capturedSiblings.map(async ({ entry: sibling, url }) => {
          if (sibling.identity.kind !== "native") {
            throw new Error("Native handoff selected an unmanaged sibling.");
          }
          return {
            tabId: sibling.identity.key.tabId,
            registrationId: sibling.identity.registrationId,
            url,
            capturedStorageState: await this.captureHandoffStorageState(
              sibling,
              sibling.status === "dead" ? "crash-no-capture" : reason,
              url,
            ),
          };
        }),
      );
      delivered = this.notifyElectronTabHandoff(identity.lifecycleWindowId, {
        ...identity.key,
        registrationId: identity.registrationId,
        capturedUrl,
        capturedStorageState,
        siblingTabs,
        reason,
      });
      if (!delivered) {
        throw new Error(
          "Electron tab handoff could not be delivered to its renderer window.",
        );
      }
    } finally {
      identity.lifecycle.finishHandoffCapture(aggregationPromise, delivered);
      for (const sibling of siblings) {
        if (sibling.identity.kind === "native") {
          sibling.identity.lifecycle.finishHandoffCapture(
            aggregationPromise,
            delivered,
          );
        }
      }
      resolveAggregation();
    }
  }

  private async captureHandoffStorageState(
    entry: BrowserViewEntry,
    reason: BrowserViewElectronTabHandoffChange["reason"],
    capturedUrl: string,
  ): Promise<BrowserStorageState | null> {
    // A crashed renderer cannot safely run `executeJavaScript` for
    // localStorage, and its webContents state is not trustworthy - honor
    // "no-capture" in the reason literally rather than attempting one.
    if (reason === "crash-no-capture") return null;
    try {
      const result = await this.captureStorageStateFromBrowser(
        { origin: capturedUrl },
        entry.view.webContents,
      );
      return result.storageState;
    } catch {
      // `capturedUrl` is not http(s) (e.g. a fresh "about:blank" tile
      // never navigated), or the capture raced the teardown it precedes.
      // Still hand the session off at its URL, just without carried
      // storage, rather than dropping the whole handoff over this.
      return null;
    }
  }

  private readHandoffUrl(entry: BrowserViewEntry): string {
    const webContents = this.readLiveWebContents(entry);
    if (webContents === null) return entry.currentUrl;
    try {
      const url = webContents.getURL();
      return url.length > 0 ? url : entry.currentUrl;
    } catch {
      return entry.currentUrl;
    }
  }
}

function guestEntryKey(entry: BrowserViewEntry): string {
  return entry.guestKey;
}

function toNativeTabKey(key: BrowserViewNativeTabKey): BrowserViewNativeTabKey {
  return {
    hostId: key.hostId,
    sessionId: key.sessionId,
    tabId: key.tabId,
  };
}

function requireSurface(entry: BrowserViewEntry): BrowserViewEntryKey {
  if (entry.surface === null) {
    throw new Error(`Browser guest ${guestEntryKey(entry)} has no surface.`);
  }
  return entry.surface;
}

function normalizeBounds(bounds: BrowserViewBounds): BrowserViewBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}

function effectiveViewportBounds(
  container: BrowserViewBounds,
  presetId: BrowserViewViewportPresetId,
): BrowserViewBounds {
  const preset = VIEWPORT_PRESETS[presetId];
  if (preset.width === null || preset.height === null) return container;
  const width = Math.min(container.width, preset.width);
  const height = Math.min(container.height, preset.height);
  return {
    x: container.x + Math.floor((container.width - width) / 2),
    y: container.y + Math.floor((container.height - height) / 2),
    width,
    height,
  };
}

function boundsAreIdentical(
  left: BrowserViewBounds,
  right: BrowserViewBounds,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function boundsMaxComponentDelta(
  left: BrowserViewBounds,
  right: BrowserViewBounds,
): number {
  return Math.max(
    Math.abs(left.x - right.x),
    Math.abs(left.y - right.y),
    Math.abs(left.width - right.width),
    Math.abs(left.height - right.height),
  );
}

function toTileKey(key: BrowserViewEntryKey): BrowserViewTileKey {
  return {
    viewTabId: key.viewTabId,
    paneId: key.paneId,
    tileInstanceId: key.tileInstanceId,
    pageSessionId: key.pageSessionId,
  };
}

function httpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : null;
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

function windowOpenShouldCreateTile(
  details: BrowserViewWindowOpenDetails,
): boolean {
  if (
    details.disposition === "foreground-tab" ||
    details.disposition === "background-tab"
  ) {
    return true;
  }
  if (details.features.trim().length > 0) return false;
  if (details.frameName === "_blank") return true;
  return false;
}

function normalizeOpenedUrl(url: string, baseUrl: string): string {
  if (url.length === 0) return "about:blank";
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function zoomPercentFromFactor(factor: number): number {
  return Math.round(factor * 100);
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

function parseCapturedDataUrl(dataUrl: string): {
  readonly mediaType: string;
  readonly base64: string;
  readonly byteLength: number;
  readonly sha256: string;
} {
  const match = /^data:([^;,]+);base64,(.*)$/u.exec(dataUrl);
  const mediaType = match?.[1] ?? "image/png";
  const base64 = match?.[2] ?? "";
  const bytes = Buffer.from(base64, "base64");
  return {
    mediaType,
    base64,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
