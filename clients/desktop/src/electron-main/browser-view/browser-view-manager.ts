import { createHash, randomUUID } from "node:crypto";
import type { BrowserWindowConstructorOptions } from "electron";
import type {
  AgentBrowserViewCdpCommand,
  AgentBrowserViewCdpDispatch,
  AgentBrowserViewCdpErrorInfo,
  AgentBrowserViewCdpFrameInfo,
  AgentBrowserViewCdpResult,
  AgentBrowserViewCdpSessionEndedChange,
  AgentBrowserViewCdpTargetAttachedChange,
  AgentBrowserViewTileHandoffChange,
  BrowserViewBounds,
  BrowserViewBackgroundTabCreate,
  BrowserViewBackgroundThrottlingChange,
  BrowserViewBoundsUpdate,
  BrowserViewCapturePageResult,
  BrowserViewCertificateErrorChange,
  BrowserViewControlAction,
  BrowserViewControlActionResult,
  BrowserViewControlGrant,
  BrowserViewControlGrantResult,
  BrowserViewControlRevokedChange,
  BrowserViewControlRevoke,
  BrowserViewDebugSnapshotChange,
  BrowserViewDebugSnapshotData,
  BrowserViewDownloadChange,
  BrowserViewDurableTabRegistration,
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
  BrowserViewStorageStateApply,
  BrowserViewStorageStateApplyResult,
  BrowserViewStorageStateCapture,
  BrowserViewStorageStateCaptureResult,
  BrowserViewTileKey,
  BrowserViewTileUpsert,
  BrowserViewViewportPresetChange,
  BrowserViewViewportPresetId,
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
import { isAgentBrowserPostureActive } from "./agent-browser-posture";
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
} from "./tile-frame-cache";
import { describeLogError, log } from "../app/logger";
import { BrowserAnnotationSession } from "./browser-annotation-session";
import { BrowserDebugSession } from "./browser-debug-session";
import type {
  BrowserViewCertificateErrorChange as BrowserSessionCertificateErrorChange,
  BrowserViewDownloadChange as BrowserSessionDownloadChange,
} from "./browser-session";

const DEBUG_SNAPSHOT_COALESCE_MS = 16;
export const PRIMARY_PROFILE_LOCAL_STORAGE_ORIGIN_LIMIT = 8;
// BT-101: aggregate window for the `bounds_stream` perf log. During a resize
// drag the renderer streams rects every frame; per-call logging would flood
// the lane, so outcomes accumulate here and flush once per window.
export const BOUNDS_STREAM_LOG_INTERVAL_MS = 1000;

const encodeCapturedTileFrame =
  defaultTileFrameEncoder(TILE_FRAME_JPEG_QUALITY, TILE_FRAME_MAX_DIMENSION);

// BT-401: hidden-but-bound tiles keep a full Chromium guest alive; past this
// cap the least-recently-visible guests are destroyed and later rebuilt from
// their persisted URL (silent reload) on the next visit.
export const HIDDEN_GUEST_EVICTION_CAP = 3;
/** Deferred so a switch's hide→show pair settles before the sweep counts. */
const EVICTION_SWEEP_DELAY_MS = 0;
// Ticket 02 fixup: bounds how long a claimed sibling's `closeEntry` waits on
// another tile's in-flight handoff capture before tearing down its own
// `webContents` regardless - a hung capture must not block quit.
const SIBLING_HANDOFF_CAPTURE_TIMEOUT_MS = 1500;
export const ANNOTATION_ATTACH_ACK_TIMEOUT_MS = 4000;

type BrowserPrimaryProfileRecentOrigin = BrowserPrimaryProfileOriginSnapshot & {
  readonly visitSequence: number;
};
interface PendingAnnotationAttachResult {
  readonly windowId: string;
  readonly keyId: string;
  readonly resolve: (delivered: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
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

export interface BrowserViewDebugger {
  isAttached(): boolean;
  attach(protocolVersion: string): void;
  detach(): void;
  sendCommand(
    method: string,
    commandParams: Record<string, unknown>,
    sessionId: string | undefined,
  ): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

export interface BrowserViewNavigationHistory {
  canGoBack(): boolean;
  canGoForward(): boolean;
  clear(): void;
  goBack(): void;
  goForward(): void;
}

export interface BrowserViewOpenDevToolsOptions {
  readonly mode: "detach";
  readonly activate: boolean;
  readonly title: string;
}

export interface BrowserViewWebContents {
  readonly id: number;
  readonly debugger: BrowserViewDebugger;
  readonly navigationHistory: BrowserViewNavigationHistory | undefined;
  loadURL(url: string): Promise<unknown>;
  executeJavaScript(script: string, userGesture: boolean): Promise<unknown>;
  capturePage(): Promise<BrowserViewCapturedImage>;
  getURL(): string;
  getTitle(): string;
  isDestroyed(): boolean;
  close(): void;
  reload(): void;
  findInPage(text: string, options: BrowserViewFindInPageOptions): number;
  stopFindInPage(action: "clearSelection"): void;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  setBackgroundThrottling(allowed: boolean): void;
  setDevToolsWebContents(webContents: BrowserViewDevToolsWebContents): void;
  openDevTools(options: BrowserViewOpenDevToolsOptions): void;
  setWindowOpenHandler(
    handler: (
      details: BrowserViewWindowOpenDetails,
    ) => BrowserViewWindowOpenResult,
  ): void;
  /**
   * Compositor frame feed for the tile-frame cache (BT-201/BT-202). The real
   * Electron signature also accepts an `onlyDirty` first argument; the
   * structural single-callback form is what the manager uses.
   */
  beginFrameSubscription(callback: (image: BrowserViewCapturedImage) => void): void;
  endFrameSubscription(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

export interface BrowserViewFindInPageOptions {
  readonly forward: boolean;
  readonly findNext: boolean;
  readonly matchCase: boolean;
}

export interface BrowserViewWindowOpenDetails {
  readonly url: string;
  readonly frameName: string;
  readonly features: string;
  readonly disposition: string;
}

export type BrowserViewWindowOpenResult =
  | { readonly action: "deny" }
  | {
      readonly action: "allow";
      readonly overrideBrowserWindowOptions: BrowserWindowConstructorOptions;
      readonly outlivesOpener: boolean;
    };

export interface BrowserViewCropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserViewCapturedImage {
  getSize(): { readonly width: number; readonly height: number };
  toJPEG(quality: number): Uint8Array;
  toDataURL(): string;
  isEmpty(): boolean;
  crop(rect: BrowserViewCropRect): BrowserViewCapturedImage;
  toPNG(): Uint8Array;
}

export interface BrowserViewDevToolsWebContents {
  readonly id: number;
}

export interface BrowserViewDevToolsWindow {
  readonly webContents: BrowserViewDevToolsWebContents;
  isDestroyed(): boolean;
  destroy(): void;
}

export interface ManagedBrowserView {
  readonly webContents: BrowserViewWebContents;
  setBounds(bounds: BrowserViewBounds): void;
  setVisible(visible: boolean): void;
}

export interface ManagedContentView {
  addChildView(view: ManagedBrowserView): void;
  removeChildView(view: ManagedBrowserView): void;
}

/**
 * The host window's own renderer lifecycle events - distinct from a browser
 * tile's `webContents`, which is a separate `WebContentsView`. Used to hide
 * every entry attached to this window while its renderer is reloading or
 * has crashed, so the native views do not composite over a blank window.
 */
export interface BrowserViewHostWebContents {
  on(
    event: "did-start-navigation" | "render-process-gone",
    listener: (...args: unknown[]) => void,
  ): void;
  off(
    event: "did-start-navigation" | "render-process-gone",
    listener: (...args: unknown[]) => void,
  ): void;
  /** BT-302: replay reserved app chords into the host renderer. */
  sendInputEvent(event: {
    readonly type: "keyDown";
    readonly keyCode: string;
    readonly modifiers?: readonly string[];
  }): void;
}

export interface BrowserViewWindow {
  readonly contentView: ManagedContentView;
  readonly webContents: BrowserViewHostWebContents | null;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
}

export interface BrowserViewPopupWebContents {
  readonly id: number;
  once(event: "destroyed", listener: () => void): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

export interface BrowserViewPopupWindow {
  readonly webContents: BrowserViewPopupWebContents;
  isDestroyed(): boolean;
  close(): void;
  on(event: string, listener: () => void): void;
  off(event: string, listener: () => void): void;
}

export interface BrowserViewManagerOptions {
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
  readonly notifyControlRevoked: (
    windowId: string,
    change: BrowserViewControlRevokedChange,
  ) => void;
  // Fired once, immediately, when a tile's CDP debugger detaches - causes
  // outside our control include the target being destroyed, a renderer
  // crash, or an explicit `Target.detachFromTarget`/`Debugger.detach`. This
  // is the only consumer-facing signal that the agent's typed CDP bridge
  // (ticket 03) must treat as ending its access to that tile rather than
  // silently discovering it on the next failed dispatch. Verified
  // 2026-07-28, live: opening DevTools does NOT cause this on Electron
  // 42.7.1/Chromium 148 - `webContents.debugger.attach()` and
  // `openDevTools()` coexist there, so do not cite DevTools-open as a
  // trigger elsewhere.
  readonly notifyCdpSessionEnded: (
    windowId: string,
    change: AgentBrowserViewCdpSessionEndedChange,
  ) => void;
  // Fired whenever CDP's own `Target.attachedToTarget` fires on a tile's
  // root session, so the host can discover a flattened child (OOPIF/worker)
  // session id to address further dispatches at.
  readonly notifyCdpTargetAttached: (
    windowId: string,
    change: AgentBrowserViewCdpTargetAttachedChange,
  ) => void;
  // Ticket 12 / ticket 10's design. Fired once, just before a tile dies for
  // any teardown reason, carrying captured `{url, storageState}` so the
  // host can continue the session headless.
  readonly notifyTileHandoff: (
    windowId: string,
    change: AgentBrowserViewTileHandoffChange,
  ) => void;
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
    input: BrowserViewStorageStateCapture,
    webContents: ManagedBrowserView["webContents"],
  ) => Promise<BrowserViewStorageStateCaptureResult>;
  readonly capturePrimaryProfile: (
    origins: readonly BrowserPrimaryProfileOriginSnapshot[],
  ) => Promise<BrowserPrimaryProfileCaptureResult>;
  readonly capturePrimaryProfileLocalStorage: (
    origin: string,
    webContents: BrowserStorageCaptureWebContents,
  ) => Promise<BrowserPrimaryProfileOriginSnapshot | null>;
  readonly releaseGraceMs: number;
  readonly electronCreateDelayMs: number;
  /** Flush window for the aggregate `bounds_stream` perf log. */
  readonly boundsStreamLogIntervalMs: number;
  /** Platform used to resolve reserved chords (BT-301). */
  readonly hostPlatform: HostPlatform;
}

export interface BrowserViewScheduledTask {
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
  key: BrowserViewEntryKey;
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
  control: BrowserViewControlState | null;
  runtimeSessionId: string;
  runtimeTabId: string | null;
  internalNavigation: boolean;
  /**
   * Set once this entry has been claimed by a handoff, either as the primary
   * frame or a sibling, so quit-time drain and later teardown cannot push it
   * twice.
   */
  handedOff: boolean;
  /**
   * Ticket 02 fixup: set (synchronously, alongside `handedOff`) to the
   * in-flight aggregation capture this entry was claimed by, if any.
   * `dispose()`'s group teardown calls `closeEntry` on every tile with no
   * `await` between them, so a claimed sibling's own `closeEntry` runs -
   * and would otherwise close this entry's `webContents` - before the
   * aggregator ever gets to `executeJavaScript` against it. `closeEntry`
   * awaits this (bounded) before tearing down, so the capture sees a live
   * page instead of racing it to death.
   */
  pendingHandoffCapture: Promise<void> | null;
}

interface BrowserViewControlState {
  readonly controlId: string;
  readonly chatId: string;
  readonly agentRunId: string | null;
  readonly agentLabel: string;
  readonly origin: string;
  readonly expiresAt: number;
  generation: number;
  queue: Promise<unknown>;
  readonly pendingSensitiveApprovals: Map<
    string,
    {
      readonly actionId: string;
      readonly action: BrowserViewControlAction["action"];
    }
  >;
}

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
  readonly beforeInputEvent: (...args: unknown[]) => void;
  readonly inputEvent: (...args: unknown[]) => void;
  readonly contextMenu: (...args: unknown[]) => void;
  readonly blur: (...args: unknown[]) => void;
  readonly didCreateWindow: (...args: unknown[]) => void;
  readonly didFrameNavigate: (...args: unknown[]) => void;
  readonly didFrameFinishLoad: (...args: unknown[]) => void;
  readonly didFinishLoad: (...args: unknown[]) => void;
  readonly didNavigate: (...args: unknown[]) => void;
  readonly didStartNavigation: (...args: unknown[]) => void;
  readonly didNavigateInPage: (...args: unknown[]) => void;
  readonly foundInPage: (...args: unknown[]) => void;
  readonly pageTitleUpdated: (...args: unknown[]) => void;
  readonly paint: (...args: unknown[]) => void;
  readonly renderProcessGone: (...args: unknown[]) => void;
}

interface BrowserViewEntryKey extends BrowserViewTileKey {
  readonly windowId: string;
}

interface BrowserViewPopupEntry {
  readonly popupId: string;
  readonly openerKey: BrowserViewEntryKey;
  readonly window: BrowserViewPopupWindow;
  readonly listeners: BrowserViewPopupListeners;
}

interface BrowserViewPopupListeners {
  readonly closed: () => void;
  readonly renderProcessGone: (...args: unknown[]) => void;
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
  private readonly notifyControlRevoked: (
    windowId: string,
    change: BrowserViewControlRevokedChange,
  ) => void;
  private readonly notifyCdpSessionEnded: (
    windowId: string,
    change: AgentBrowserViewCdpSessionEndedChange,
  ) => void;
  private readonly notifyCdpTargetAttached: (
    windowId: string,
    change: AgentBrowserViewCdpTargetAttachedChange,
  ) => void;
  private readonly notifyTileHandoff: (
    windowId: string,
    change: AgentBrowserViewTileHandoffChange,
  ) => void;
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
    input: BrowserViewStorageStateCapture,
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
  private readonly electronCreateDelayMs: number;
  private readonly entriesByKey = new Map<string, BrowserViewEntry>();
  private readonly entriesByRuntimeKey = new Map<string, BrowserViewEntry>();
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
      readonly onNavigate: (...args: unknown[]) => void;
      readonly onGone: (...args: unknown[]) => void;
    }
  >();
  private readonly recentPrimaryProfileOrigins: BrowserPrimaryProfileRecentOrigin[] =
    [];
  private primaryProfileVisitSequence = 0;
  private pipCaptureEntry: BrowserViewEntry | null = null;
  private readonly boundsStreamLogIntervalMs: number;
  private readonly boundsStreamStats = createBoundsStreamStats();
  private boundsStreamLogTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFrameCacheStatsSignature: string | null = null;
  private reservedChords: readonly ReservedChord[] = [];
  private readonly hostPlatform: HostPlatform;
  private evictionSweepTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.notifyFind = options.notifyFind;
    this.notifyDownload = options.notifyDownload;
    this.notifyCertificateError = options.notifyCertificateError;
    this.notifyOpenTileRequest = options.notifyOpenTileRequest;
    this.notifySnapshotInvalidated = options.notifySnapshotInvalidated;
    this.notifyDebugSnapshot = options.notifyDebugSnapshot;
    this.notifyControlRevoked = options.notifyControlRevoked;
    this.notifyCdpSessionEnded = options.notifyCdpSessionEnded;
    this.notifyCdpTargetAttached = options.notifyCdpTargetAttached;
    this.notifyTileHandoff = options.notifyTileHandoff;
    this.notifyAnnotationEvent = options.notifyAnnotationEvent;
    this.notifyAnnotationAttached = options.notifyAnnotationAttached;
    this.scheduleDebugSnapshot = options.scheduleDebugSnapshot;
    this.applyStorageStateToBrowser = options.applyStorageState;
    this.captureStorageStateFromBrowser = options.captureStorageState;
    this.capturePrimaryProfileFromBrowser = options.capturePrimaryProfile;
    this.capturePrimaryProfileLocalStorageFromBrowser =
      options.capturePrimaryProfileLocalStorage;
    this.electronCreateDelayMs = options.electronCreateDelayMs;
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
    const existing =
      this.entriesByKey.get(keyId) ?? this.findTransferableEntry(key);
    const entry =
      existing === null
        ? this.createEntry(key, input.url, input.viewportPreset, true)
        : existing;
    log.info("[browser-view] upsert tile", {
      keyId,
      outcome: existing === null ? "created" : "reused",
      visible: input.visible,
      url: input.url,
    });

    if (entryKeyId(entry.key) !== keyId) {
      this.rekeyEntry(entry, key);
    } else {
      this.entriesByKey.set(keyId, entry);
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
    // BT-401: every upsert can change the hidden set (a tab switch hides the
    // outgoing tile; a first open can land hidden). The sweep is coalesced,
    // so this is cheap.
    this.scheduleEvictionSweep();
  }

  async createBackgroundTab(
    windowId: string,
    input: BrowserViewBackgroundTabCreate,
  ): Promise<void> {
    const startedAt = Date.now();
    log.info("[browser-view] background tab create stage", {
      kind: "electron_tab_create",
      stage: "manager_started",
      outcome: "started",
      sessionId: input.sessionId,
      tabId: input.tabId,
      durationMs: 0,
    });
    const runtimeKey = [input.sessionId, input.tabId].join("\u001f");
    if (this.entriesByRuntimeKey.has(runtimeKey)) {
      throw new Error(
        `Browser runtime tab ${input.sessionId}/${input.tabId} already exists.`,
      );
    }
    const key = { ...input, windowId };
    const entry = this.createEntry(key, input.url, "responsive", false);
    log.info("[browser-view] background tab create stage", {
      kind: "electron_tab_create",
      stage: "entry_created",
      outcome: "ok",
      sessionId: input.sessionId,
      tabId: input.tabId,
      durationMs: Date.now() - startedAt,
    });
    this.entriesByRuntimeKey.delete(runtimeEntryKey(entry));
    entry.runtimeSessionId = input.sessionId;
    entry.runtimeTabId = input.tabId;
    this.entriesByRuntimeKey.set(runtimeEntryKey(entry), entry);
    try {
      entry.internalNavigation = true;
      try {
        await entry.view.webContents.loadURL("about:blank");
      } finally {
        entry.view.webContents.navigationHistory?.clear();
        entry.internalNavigation = false;
      }
      log.info("[browser-view] background tab create stage", {
        kind: "electron_tab_create",
        stage: "target_primed",
        outcome: "ok",
        sessionId: input.sessionId,
        tabId: input.tabId,
        durationMs: Date.now() - startedAt,
      });
      const seedScript = browserLocalStorageSeedScript(input.seedStorageState);
      const debugSession = this.ensureDebugSession(entry);
      const seedScriptId =
        seedScript === null
          ? null
          : await debugSession.installScriptBeforeNavigation(seedScript);
      log.info("[browser-view] background tab create stage", {
        kind: "electron_tab_create",
        stage: "seed_script_installed",
        outcome: "ok",
        sessionId: input.sessionId,
        tabId: input.tabId,
        durationMs: Date.now() - startedAt,
      });
      let resolveCommitted!: () => void;
      const committed = new Promise<void>((resolve) => {
        resolveCommitted = resolve;
      });
      const onCommitted = (source: string): void => {
        const ready = entry.status === "ready";
        log.info("[browser-view] background tab create stage", {
          kind: "electron_tab_create",
          stage: "commit_checked",
          outcome: ready ? "ready" : "not-ready",
          source,
          sessionId: input.sessionId,
          tabId: input.tabId,
          durationMs: Date.now() - startedAt,
        });
        if (ready) resolveCommitted();
      };
      const navigation = this.navigate(entry, input.url, true);
      const onFrameNavigate = (): void => {
        onCommitted("did-frame-navigate");
      };
      const onNavigate = (): void => {
        onCommitted("did-navigate");
      };
      entry.view.webContents.on("did-frame-navigate", onFrameNavigate);
      entry.view.webContents.on("did-navigate", onNavigate);
      log.info("[browser-view] background tab create stage", {
        kind: "electron_tab_create",
        stage: "navigation_started",
        outcome: "started",
        sessionId: input.sessionId,
        tabId: input.tabId,
        durationMs: Date.now() - startedAt,
      });
      onCommitted("level-check");
      try {
        await Promise.race([navigation, committed]);
        log.info("[browser-view] background tab create stage", {
          kind: "electron_tab_create",
          stage: "readiness_settled",
          outcome: "ok",
          sessionId: input.sessionId,
          tabId: input.tabId,
          durationMs: Date.now() - startedAt,
        });
      } finally {
        entry.view.webContents.off("did-frame-navigate", onFrameNavigate);
        entry.view.webContents.off("did-navigate", onNavigate);
      }
      if (seedScriptId !== null) {
        await debugSession.removeScriptBeforeNavigation(seedScriptId);
      }
      log.info("[browser-view] background tab create stage", {
        kind: "electron_tab_create",
        stage: "seed_script_removed",
        outcome: "ok",
        sessionId: input.sessionId,
        tabId: input.tabId,
        durationMs: Date.now() - startedAt,
      });
      if (this.electronCreateDelayMs > 0) {
        log.info("[browser-view] delaying background tab create ack", {
          sessionId: input.sessionId,
          tabId: input.tabId,
          delayMs: this.electronCreateDelayMs,
        });
        await delay(this.electronCreateDelayMs);
      }
      log.info("[browser-view] background tab create stage", {
        kind: "electron_tab_create",
        stage: "manager_settled",
        outcome: "ok",
        sessionId: input.sessionId,
        tabId: input.tabId,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      log.info("[browser-view] background tab create stage", {
        kind: "electron_tab_create",
        stage: "manager_settled",
        outcome: "failed",
        cause: error instanceof Error ? error.name : typeof error,
        sessionId: input.sessionId,
        tabId: input.tabId,
        durationMs: Date.now() - startedAt,
      });
      await this.closeEntry(entry, null);
      throw error;
    }
  }

  registerDurableTab(
    windowId: string,
    input: BrowserViewDurableTabRegistration,
  ): void {
    const key = { ...input, windowId };
    const keyId = entryKeyId(key);
    const entry =
      this.entriesByKey.get(keyId) ?? this.findTransferableEntry(key);
    if (entry === null) {
      log.warn("[browser-view] register durable tab: no matching entry", {
        keyId,
        sessionId: input.sessionId,
        tabId: input.tabId,
      });
      return;
    }
    const previousRuntimeKey = runtimeEntryKey(entry);
    this.entriesByRuntimeKey.delete(previousRuntimeKey);
    entry.runtimeSessionId = input.sessionId;
    entry.runtimeTabId = input.tabId;
    const nextRuntimeKey = runtimeEntryKey(entry);
    this.entriesByRuntimeKey.set(nextRuntimeKey, entry);
    log.info("[browser-view] register durable tab", {
      keyId,
      sessionId: input.sessionId,
      tabId: input.tabId,
      previousRuntimeKey,
      nextRuntimeKey,
      rekeyed: previousRuntimeKey !== nextRuntimeKey,
    });
  }

  async releaseDurableTab(
    windowId: string,
    input: BrowserViewDurableTabRegistration,
  ): Promise<void> {
    const entry =
      this.entriesByKey.get(entryKeyId({ ...input, windowId })) ??
      this.entriesByRuntimeKey.get(
        [input.sessionId, input.tabId].join("\u001f"),
      );
    if (entry === undefined || entry.key.windowId !== windowId) return;
    await this.closeEntry(entry, null);
  }

  setBackgroundThrottling(
    windowId: string,
    input: BrowserViewBackgroundThrottlingChange,
  ): void {
    const key = { ...input, windowId };
    const entry =
      this.entriesByKey.get(entryKeyId(key)) ??
      this.findTransferableEntry(key);
    // Unbound views have no compositor: timers/events stay unthrottled, but
    // requestAnimationFrame needs the view bound to a window.
    entry?.view.webContents.setBackgroundThrottling(input.enabled);
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
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
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
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
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
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) return;
    entry.viewportPreset = input.viewportPreset;
    this.applyEntryBounds(entry);
    this.applyEntryVisibility(entry);
  }

  releaseTile(windowId: string, input: BrowserViewTileKey): void {
    const keyId = entryKeyId({ ...input, windowId });
    // Tile close stops the frame feed even though the durable WebContents
    // may live on unbound (ticket 05): no tile, no compositor contract.
    this.tileFrames.detach(keyId);
    const entry = this.entriesByKey.get(keyId);
    if (entry === undefined) {
      return;
    }
    this.entriesByKey.delete(keyId);
    this.endAnnotationSession(entry, "tile-close");
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
  }

  reloadTile(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) return;
    this.setStatus(entry, "loading", null);
    this.invalidateOverlaySnapshot(entry, "reload");
    entry.view.webContents.reload();
    this.applyEntryVisibility(entry);
  }

  goBack(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) return;
    const navigationHistory = this.readNavigationHistory(entry);
    if (navigationHistory === null) {
      this.emitStatus(entry);
      return;
    }
    const canGoBack = this.readCanGoBack(navigationHistory);
    if (canGoBack !== true) {
      this.emitStatus(entry);
      return;
    }
    this.setStatus(entry, "loading", null);
    this.invalidateOverlaySnapshot(entry, "go-back");
    try {
      navigationHistory.goBack();
    } catch (err) {
      log.warn("[browser-view] goBack failed", {
        error: describeLogError(err),
        webContentsId: entry.view.webContents.id,
      });
      this.emitStatus(entry);
    }
    this.applyEntryVisibility(entry);
  }

  goForward(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) return;
    const navigationHistory = this.readNavigationHistory(entry);
    if (navigationHistory === null) {
      this.emitStatus(entry);
      return;
    }
    const canGoForward = this.readCanGoForward(navigationHistory);
    if (canGoForward !== true) {
      this.emitStatus(entry);
      return;
    }
    this.setStatus(entry, "loading", null);
    this.invalidateOverlaySnapshot(entry, "go-forward");
    try {
      navigationHistory.goForward();
    } catch (err) {
      log.warn("[browser-view] goForward failed", {
        error: describeLogError(err),
        webContentsId: entry.view.webContents.id,
      });
      this.emitStatus(entry);
    }
    this.applyEntryVisibility(entry);
  }

  findInPage(windowId: string, input: BrowserViewFindRequest): void {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
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
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
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
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) return;
    this.applyZoomStep(entry, 1);
  }

  zoomOut(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) return;
    this.applyZoomStep(entry, -1);
  }

  resetZoom(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) return;
    this.trySetEntryZoom(entry, 1);
  }

  canTrustCertificateError(
    windowId: string,
    input: BrowserViewTileKey & { readonly certificateErrorId: string },
  ): boolean {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined || entry.certificateError === null) return false;
    return (
      entry.certificateError.certificateErrorId === input.certificateErrorId
    );
  }

  clearCertificateError(
    windowId: string,
    input: BrowserViewTileKey & { readonly certificateErrorId: string },
  ): void {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
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

    // Fix round 3: the renderer now broadcasts every occlusion to both the
    // primary and agent managers, and each one silently no-ops the tiles it
    // does not own (by design - see `occludeEntryForOverlay`). That is
    // correct but otherwise invisible; log once per call when this manager
    // matched none of the requested tiles, so "this manager isn't the one
    // that owns this overlay's tiles" stays distinguishable in the log from
    // an actual regression, without spamming per-tile.
    const matchedCount = nextKeyIds.filter((keyId) =>
      this.entriesByKey.has(keyId),
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
    input: {
      readonly tileKey: BrowserViewTileKey;
      readonly maxWidth: number;
      readonly maxHeight: number;
      readonly quality: number;
    },
    onFrame: (payload: PipCaptureIpcPayload) => void,
  ): Promise<boolean> {
    const key = { ...input.tileKey, windowId };
    const entry =
      this.entriesByKey.get(entryKeyId(key)) ?? this.findTransferableEntry(key);
    if (entry === null || entry === undefined) return false;
    this.stopPipCapture();
    this.prepareEntryForPipCapture(entry, {
      width: input.maxWidth,
      height: input.maxHeight,
    });
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
      throw err;
    }
    if (!session.isPipCapturing() && this.pipCaptureEntry === entry) {
      this.pipCaptureEntry = null;
    }
    return session.isPipCapturing();
  }

  stopPipCapture(): void {
    const entry = this.pipCaptureEntry;
    this.pipCaptureEntry = null;
    entry?.debugSession?.stopPipCapture();
    if (entry !== null) {
      this.applyEntryBounds(entry);
      this.applyEntryVisibility(entry);
    }
  }

  async capturePage(
    windowId: string,
    input: BrowserViewTileKey,
  ): Promise<BrowserViewCapturePageResult> {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) {
      throw new Error("Browser view tile is not available for capture");
    }
    assertEntryCapturable(entry, this.getWindow(entry.key.windowId));
    const dataUrl = (await entry.view.webContents.capturePage()).toDataURL();
    const image = parseCapturedDataUrl(dataUrl);
    return {
      ...toTileKey(entry.key),
      ...image,
      capturedAt: Date.now(),
    };
  }

  getDebugSnapshot(
    windowId: string,
    input: BrowserViewTileKey,
  ): BrowserViewDebugSnapshotChange {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) {
      return {
        ...input,
        consoleEntries: [],
        networkEntries: [],
      };
    }
    return {
      ...toTileKey(entry.key),
      ...this.readDebugSnapshot(entry),
    };
  }

  clearDebugEvents(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
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
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) return;
    const session = entry.annotationSession;
    if (session === null || !session.isActive()) return;
    void session.setTargetChatLabel(input.targets, input.defaultChatId);
  }

  startAnnotation(
    windowId: string,
    input: BrowserViewTileKey,
  ): Promise<BrowserAnnotationStartResult> {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) {
      return Promise.resolve({ ok: false, reason: "tile-not-found" });
    }
    if (entry.status !== "ready") {
      return Promise.resolve({ ok: false, reason: "page-not-ready" });
    }
    this.endAnnotationSession(entry, "replaced");
    const session = new BrowserAnnotationSession({
      webContents: entry.view.webContents,
      identity: {
        tabId: entry.runtimeTabId ?? entry.key.pageSessionId,
        sessionId: entry.runtimeSessionId,
      },
      onEvent: (event) => {
        if (entry.annotationSession !== session) return;
        if (event.type === "attachRequested") return;
        this.notifyAnnotationEvent(entry.key.windowId, {
          ...toTileKey(entry.key),
          event,
        });
      },
      onAttached: (result) => {
        if (entry.annotationSession !== session) {
          return Promise.resolve(false);
        }
        this.notifyAnnotationAttached(entry.key.windowId, {
          ...toTileKey(entry.key),
          targetChatId: result.targetChatId,
          payload: result.payload,
          pngBytes: result.pngBytes,
        });
        return this.waitForAnnotationAttachResult({
          windowId: entry.key.windowId,
          keyId: entryKeyId(entry.key),
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
    const pending = this.pendingAnnotationAttachResults.get(
      input.annotationId,
    );
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
    const keyId = entryKeyId(entry.key);
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
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) return;
    this.endAnnotationSession(entry, "cancelled");
  }

  openDevTools(windowId: string, input: BrowserViewTileKey): void {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) return;
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

  grantControl(
    windowId: string,
    input: BrowserViewControlGrant,
  ): BrowserViewControlGrantResult {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) {
      return { status: "denied", reason: "Browser tile is not available." };
    }
    if (entry.control !== null && entry.control.controlId !== input.controlId) {
      return { status: "queued", controlId: input.controlId };
    }
    entry.control = {
      controlId: input.controlId,
      chatId: input.chatId,
      agentRunId: input.agentRunId,
      agentLabel: input.agentLabel,
      origin: input.origin,
      expiresAt: input.expiresAt,
      generation: 0,
      queue: Promise.resolve(null),
      pendingSensitiveApprovals: new Map(),
    };
    return { status: "granted", controlId: input.controlId };
  }

  revokeControl(windowId: string, input: BrowserViewControlRevoke): void {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) return;
    this.cancelControl(entry, input.reason, input.controlId);
  }

  executeControlAction(
    windowId: string,
    input: BrowserViewControlAction,
  ): Promise<BrowserViewControlActionResult> {
    const entry = this.entriesByKey.get(entryKeyId({ ...input, windowId }));
    if (entry === undefined) {
      return Promise.resolve({
        status: "denied",
        reason: "Browser tile is not available.",
      });
    }
    const control = entry.control;
    if (control === null || control.controlId !== input.controlId) {
      return Promise.resolve({
        status: "denied",
        reason: "Browser control lock is not active.",
      });
    }
    if (control.expiresAt <= Date.now()) {
      this.cancelControl(entry, "control grant expired", input.controlId);
      return Promise.resolve({
        status: "cancelled",
        reason: "control grant expired",
      });
    }
    const generation = control.generation;
    const run = control.queue.then(async () => {
      const latest = entry.control;
      if (
        latest === null ||
        latest.controlId !== input.controlId ||
        latest.generation !== generation
      ) {
        return {
          status: "cancelled" as const,
          reason: "user took over",
        };
      }
      const result = await this.sendControlCommand(entry, input);
      const after = entry.control;
      if (
        after === null ||
        after.controlId !== input.controlId ||
        after.generation !== generation
      ) {
        return {
          status: "cancelled" as const,
          reason: "user took over",
        };
      }
      return result;
    });
    control.queue = run.catch(() => null);
    return run.catch((error: unknown) => ({
      status: "denied",
      reason: error instanceof Error ? error.message : String(error),
    }));
  }

  /**
   * The typed CDP bridge for a registered Electron tab, whether currently
   * bound to a tile or hidden. A detached debugger still fails fast rather
   * than attempting a doomed `sendCommand`.
   */
  async dispatchCdp(
    windowId: string,
    input: AgentBrowserViewCdpDispatch,
  ): Promise<AgentBrowserViewCdpResult> {
    const key = { ...input, windowId };
    const entry =
      this.entriesByKey.get(entryKeyId(key)) ?? this.findTransferableEntry(key);
    if (entry === null) {
      return {
        kind: input.command.kind,
        ok: false,
        error: {
          kind: "tile_not_found",
          message: "Agent browser tile is not available.",
          code: null,
        },
      };
    }
    const browserDebugger = entry.view.webContents.debugger;
    if (!browserDebugger.isAttached()) {
      return {
        kind: input.command.kind,
        ok: false,
        error: {
          kind: "not_attached",
          message: "Agent browser tile's debugger is not attached.",
          code: null,
        },
      };
    }
    try {
      return await sendCdpCommand(
        browserDebugger,
        input.sessionId ?? undefined,
        input.command,
      );
    } catch (err) {
      return {
        kind: input.command.kind,
        ok: false,
        error: classifyCdpError(err),
      };
    }
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
    for (const entry of Array.from(this.entriesByRuntimeKey.values())) {
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
      Array.from(this.entriesByRuntimeKey.values())
        .filter(
          (entry) =>
            entry.status !== "dead" &&
            entry.runtimeTabId !== null &&
            !entry.handedOff,
        )
        .map((entry) => this.pushTileHandoff(entry, "gui-quit")),
    );
  }

  snapshotForTests(): ReadonlyArray<{
    readonly key: BrowserViewEntryKey;
    readonly webContentsId: number;
    readonly parentWindowId: string | null;
    readonly visible: boolean;
    readonly status: BrowserViewStatus;
    readonly requestedUrl: string;
    readonly bounds: BrowserViewBounds | null;
    readonly overlayOwnerIds: readonly string[];
    readonly overlaySnapshotStale: boolean;
  }> {
    return Array.from(this.entriesByKey.values()).map((entry) => ({
      key: entry.key,
      webContentsId: entry.view.webContents.id,
      parentWindowId: entry.parentWindowId,
      visible: entry.desiredVisible,
      status: entry.status,
      requestedUrl: entry.requestedUrl,
      bounds: entry.bounds,
      overlayOwnerIds: entry.overlayOwnerIds,
      overlaySnapshotStale: entry.overlaySnapshotStale,
    }));
  }

  private createEntry(
    key: BrowserViewEntryKey,
    requestedUrl: string,
    viewportPreset: BrowserViewViewportPresetId,
    navigateNow: boolean,
  ): BrowserViewEntry {
    const view = this.createView();
    const entry: BrowserViewEntry = {
      key,
      view,
      listeners: {
        beforeInputEvent: (...args) => {
          this.handleBeforeInputEvent(entry, args);
        },
        inputEvent: () => {
          this.handleNativeUserInput(entry, "user took over");
        },
        contextMenu: () => {
          this.handleNativeUserInput(entry, "user took over");
        },
        blur: () => {
          // Electron does not expose every file-picker/native-modal seam for
          // embedded views, so focus loss revokes control conservatively.
          this.handleNativeUserInput(
            entry,
            "user took over via native dialog or focus change",
          );
        },
        didCreateWindow: (...args) => {
          this.handleDidCreateWindow(entry, args);
        },
        didFrameNavigate: (...args) => {
          this.handleCommittedNavigation(entry, args);
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
        didNavigate: (...args) => {
          this.handleCommittedNavigation(entry, args);
        },
        didStartNavigation: (...args) => {
          this.handleViewStartNavigation(entry, args);
        },
        didNavigateInPage: (...args) => {
          this.handleInPageNavigation(entry, args);
        },
        foundInPage: (...args) => {
          this.handleFoundInPage(entry, args);
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
        renderProcessGone: (...args) => {
          this.handleRenderProcessGone(entry, args);
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
      control: null,
      handedOff: false,
      pendingHandoffCapture: null,
      runtimeSessionId: key.pageSessionId,
      runtimeTabId: null,
      internalNavigation: false,
    };
    const webContents = view.webContents;
    webContents.setWindowOpenHandler((details) =>
      this.handleWindowOpen(entry, details),
    );
    webContents.on("before-input-event", entry.listeners.beforeInputEvent);
    webContents.on("input-event", entry.listeners.inputEvent);
    webContents.on("context-menu", entry.listeners.contextMenu);
    webContents.on("blur", entry.listeners.blur);
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
    this.entriesByKey.set(entryKeyId(key), entry);
    this.entriesByRuntimeKey.set(runtimeEntryKey(entry), entry);
    if (navigateNow) void this.navigate(entry, requestedUrl, false);
    log.info("[browser-view] view created", {
      keyId: entryKeyId(key),
      viewTabId: key.viewTabId,
      paneId: key.paneId,
      tileInstanceId: key.tileInstanceId,
      pageSessionId: key.pageSessionId,
      windowId: key.windowId,
      viewportPreset,
      navigateNow,
    });
    return entry;
  }

  private findTransferableEntry(
    key: BrowserViewEntryKey,
  ): BrowserViewEntry | null {
    for (const entry of this.entriesByRuntimeKey.values()) {
      if (entry.key.pageSessionId === key.pageSessionId) {
        return entry;
      }
    }
    return null;
  }

  private rekeyEntry(entry: BrowserViewEntry, key: BrowserViewEntryKey): void {
    this.cancelDebugSnapshot(entry);
    const previousKeyId = entryKeyId(entry.key);
    const nextKeyId = entryKeyId(key);
    // The frame-cache slot is keyed by entry key; drop the stale slot so the
    // next visibility pass re-attaches under the new key (BT-202).
    this.tileFrames.detach(previousKeyId);
    this.entriesByKey.delete(previousKeyId);
    entry.key = key;
    this.entriesByKey.set(nextKeyId, entry);
    for (const overlayId of entry.overlayOwnerIds) {
      const overlayKeyIds = this.overlayEntryKeysByOwnerId.get(overlayId);
      if (overlayKeyIds === undefined) continue;
      this.overlayEntryKeysByOwnerId.set(
        overlayId,
        overlayKeyIds.map((keyId) =>
          keyId === previousKeyId ? nextKeyId : keyId,
        ),
      );
    }
    this.attachToCurrentWindow(entry);
    this.emitStatus(entry);
    this.queueDebugSnapshot(entry);
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
    args: readonly unknown[],
  ): void {
    if (entry.internalNavigation) return;
    const flags = readHostNavigationFlags(args);
    if (!flags.isMainFrame || flags.isInPlace) return;
    this.endAnnotationSession(entry, "navigation");
  }

  private handleCommittedNavigation(
    entry: BrowserViewEntry,
    args: readonly unknown[],
  ): void {
    if (entry.internalNavigation) return;
    const isMainFrame = readMainFrameFlag(args);
    if (!isMainFrame) return;
    const url = readNavigationUrl(args) ?? entry.view.webContents.getURL();
    entry.currentUrl = url;
    entry.requestedUrl = url;
    entry.currentTitle = entry.view.webContents.getTitle();
    this.rememberPrimaryProfileOrigin(entry);
    entry.certificateError = null;
    this.cancelControl(entry, "navigation committed", null);
    this.invalidateOverlaySnapshot(entry, "navigation-committed");
    this.setStatus(entry, "ready", null);
    this.enableDebugAfterCommit(entry);
    this.applyEntryVisibility(entry);
  }

  private handleInPageNavigation(
    entry: BrowserViewEntry,
    args: readonly unknown[],
  ): void {
    if (entry.internalNavigation) return;
    if (!readInPageMainFrameFlag(args)) return;
    const url = readNavigationUrl(args) ?? entry.view.webContents.getURL();
    entry.currentUrl = url;
    entry.requestedUrl = url;
    entry.currentTitle = entry.view.webContents.getTitle();
    this.rememberPrimaryProfileOrigin(entry);
    this.endAnnotationSession(entry, "navigation");
    this.cancelControl(entry, "navigation committed", null);
    this.invalidateOverlaySnapshot(entry, "in-page-navigation");
    this.emitStatus(entry);
  }

  private handleRenderProcessGone(
    entry: BrowserViewEntry,
    args: readonly unknown[],
  ): void {
    const detail = readRenderGoneReason(args);
    this.endAnnotationSession(entry, "crash");
    this.cancelControl(entry, "renderer process gone", null);
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

  private handleFoundInPage(
    entry: BrowserViewEntry,
    args: readonly unknown[],
  ): void {
    const result = readFoundInPageResult(args);
    if (result === null) return;
    const session = entry.findState.sessionsByElectronRequestId.get(
      result.requestId,
    );
    if (session === undefined) return;
    this.emitFind(entry, {
      appRequestId: session.appRequestId,
      query: session.query,
      matchCase: session.matchCase,
      status: "ready",
      current: result.current,
      total: result.total,
      finalUpdate: result.finalUpdate,
      errorMessage: null,
    });
  }

  private handleBeforeInputEvent(
    entry: BrowserViewEntry,
    args: readonly unknown[],
  ): void {
    const input = readBeforeInput(args);
    if (input === null) return;
    // BT-302: reserved app chords win before the guest sees them. The chord
    // set is registered by the renderer; only interceptable+forwardable
    // chords are claimed, so pages keep everything the app cannot replay.
    const reserved = this.matchReservedChord(input);
    if (reserved !== null) {
      preventInputDefault(args);
      this.handleNativeUserInput(entry, "reserved app chord");
      this.forwardReservedChordToHostWindow(entry, reserved);
      return;
    }
    this.handleNativeUserInput(entry, "user took over");
    if (!input.modifier) return;
    const step = browserZoomStepForKey(input.key);
    if (step === null) return;
    preventInputDefault(args);
    if (step === 0) {
      this.trySetEntryZoom(entry, 1);
      return;
    }
    this.applyZoomStep(entry, step);
  }

  private matchReservedChord(input: {
    readonly key: string;
    readonly control: boolean;
    readonly meta: boolean;
    readonly shift: boolean;
    readonly alt: boolean;
  }): ReservedChord | null {
    if (this.reservedChords.length === 0) return null;
    const event = reservedChordFromKeyEvent(
      {
        key: input.key,
        control: input.control,
        meta: input.meta,
        shift: input.shift,
        alt: input.alt,
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
    const window = this.getWindow(entry.key.windowId);
    const hostWebContents =
      window === null || window.isDestroyed() ? null : window.webContents;
    if (hostWebContents === null) return;
    const modifiers: string[] = [];
    if (chord.mod) modifiers.push(this.hostPlatform === "darwin" ? "meta" : "control");
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
    // Decision #22: real popups keep opener, while target=_blank gets a tile.
    // Electron exposes featureless scripted window.open the same as _blank
    // tab opens, so the available guardrail is non-empty popup features.
    if (windowOpenShouldCreateTile(details)) {
      this.notifyOpenTileRequest(entry.key.windowId, {
        ...toTileKey(entry.key),
        url: normalizeOpenedUrl(details.url, entry.currentUrl),
        disposition: details.disposition,
      });
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: this.createPopupWindowOptions(
        entry.key.windowId,
      ),
      outlivesOpener: false,
    };
  }

  private handleDidCreateWindow(
    entry: BrowserViewEntry,
    args: readonly unknown[],
  ): void {
    const window = readPopupWindow(args);
    if (window === null) {
      log.warn("[browser-view] popup created without trackable window", {
        webContentsId: entry.view.webContents.id,
      });
      return;
    }
    this.registerPopupWebContents(window.webContents);
    const popupId = `${entry.key.tileInstanceId}:${window.webContents.id}`;
    const popupEntry: BrowserViewPopupEntry = {
      popupId,
      openerKey: entry.key,
      window,
      listeners: {
        closed: () => {
          this.closePopupEntry(popupEntry, false);
        },
        renderProcessGone: (...renderArgs) => {
          log.warn("[browser-view] popup renderer gone", {
            popupId,
            reason: readRenderGoneReason(renderArgs),
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
    if (entry !== null) {
      this.notifyDownload(entry.key.windowId, {
        ...toTileKey(entry.key),
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
    if (entry !== null) {
      const tileChange: BrowserViewCertificateErrorChange = {
        ...toTileKey(entry.key),
        certificateErrorId: change.certificateErrorId,
        url: change.url,
        hostname: change.hostname,
        error: change.error,
        fingerprint: change.fingerprint,
        subject: change.subject,
        issuer: change.issuer,
      };
      entry.certificateError = tileChange;
      this.notifyCertificateError(entry.key.windowId, tileChange);
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
    for (const entry of this.entriesByKey.values()) {
      if (entry.view.webContents.id === webContentsId) return entry;
    }
    return null;
  }

  private async occludeEntryForOverlay(
    overlayId: string,
    keyId: string,
  ): Promise<BrowserViewOverlaySnapshot | null> {
    const entry = this.entriesByKey.get(keyId);
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
    const currentEntry = this.entriesByKey.get(keyId);
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
      ...toTileKey(currentEntry.key),
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
      const entry = this.entriesByKey.get(keyId);
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
    const effective = effectiveViewportBounds(entry.bounds, entry.viewportPreset);
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
        const entry = this.entriesByKey.get(keyId);
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
        return [toTileKey(entry.key)];
      });
  }

  private enableDebugAfterCommit(entry: BrowserViewEntry): void {
    this.ensureDebugSession(entry).enableAfterCommit();
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
      onTargetAttached: (event) => {
        this.notifyCdpTargetAttached(entry.key.windowId, {
          ...toTileKey(entry.key),
          ...event,
        });
      },
    });
    entry.debugSession = session;
    return session;
  }

  /**
   * A tile's CDP debugger can detach for reasons outside our control - the
   * target being destroyed, a renderer crash, or an explicit
   * `Target.detachFromTarget`/`Debugger.detach`. A detached debugger means
   * whatever was driving the tile has a stale view of it, so detach must end
   * that access rather than only be logged (ticket 03). This is generic
   * across both consumers of `BrowserViewManager`: the visible tile's T18
   * control grant (if one is active) is revoked through the same path
   * user-initiated cancellation already uses, and the agent tile's CDP
   * bridge is notified so the host can fail fast instead of discovering the
   * detach lazily on the next dispatch. `BrowserDebugSession` re-attaches on
   * the next committed navigation on its own; this only closes the gap in
   * between.
   *
   * Verified 2026-07-28, live: opening DevTools does NOT trigger this path
   * on Electron 42.7.1/Chromium 148 - `webContents.debugger.attach()` and
   * `openDevTools()` coexist there (confirmed via a real `devtools://`
   * target plus 8s of post-open polling with no detach, twice, independent
   * tile keys). That is a design upgrade, not a gap: a user can open
   * DevTools to watch the agent drive without ending its access, and
   * revocation still has its own paths (`revokeControl`, `releaseTile`). Do
   * not cite DevTools-open as a trigger for this path; it remains correct
   * for the causes above.
   */
  private handleDebugSessionDetached(
    entry: BrowserViewEntry,
    reason: string,
  ): void {
    log.warn("[browser-view] debugger detached", {
      reason,
      webContentsId: entry.view.webContents.id,
    });
    if (this.pipCaptureEntry === entry) this.pipCaptureEntry = null;
    if (entry.control !== null) {
      this.cancelControl(entry, `debugger detached: ${reason}`, null);
    }
    this.notifyCdpSessionEnded(entry.key.windowId, {
      ...toTileKey(entry.key),
      reason,
    });
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
    const keyId = entryKeyId(entry.key);
    if (this.pendingDebugSnapshotsByKey.has(keyId)) return;
    const task = this.scheduleDebugSnapshot(() => {
      this.pendingDebugSnapshotsByKey.delete(keyId);
      if (this.entriesByKey.get(keyId) !== entry) return;
      this.emitDebugSnapshotNow(entry);
    });
    this.pendingDebugSnapshotsByKey.set(keyId, task);
  }

  private cancelDebugSnapshot(entry: BrowserViewEntry): void {
    const keyId = entryKeyId(entry.key);
    const task = this.pendingDebugSnapshotsByKey.get(keyId);
    if (task === undefined) return;
    task.cancel();
    this.pendingDebugSnapshotsByKey.delete(keyId);
  }

  private emitDebugSnapshotNow(entry: BrowserViewEntry): void {
    this.notifyDebugSnapshot(entry.key.windowId, {
      ...toTileKey(entry.key),
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
      this.endAnnotationSession(
        entry,
        status === "dead" ? "crash" : "reload",
      );
      this.cancelControl(entry, reason ?? "browser tile is not ready", null);
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
    this.notifyStatus(entry.key.windowId, {
      viewTabId: entry.key.viewTabId,
      paneId: entry.key.paneId,
      tileInstanceId: entry.key.tileInstanceId,
      pageSessionId: entry.key.pageSessionId,
      url: entry.currentUrl,
      title: entry.currentTitle,
      status: entry.status,
      reason: entry.statusReason,
      canGoBack: navigationState.canGoBack,
      canGoForward: navigationState.canGoForward,
      zoomPercent,
    });
  }

  private isEntryCurrent(entry: BrowserViewEntry): boolean {
    return this.entriesByRuntimeKey.get(runtimeEntryKey(entry)) === entry;
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
    this.notifyFind(entry.key.windowId, {
      ...toTileKey(entry.key),
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
    size: { readonly width: number; readonly height: number },
  ): void {
    this.attachToCurrentWindow(entry);
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
      keyId: entryKeyId(entry.key),
      attached: entry.parentWindowId !== null,
      bounds: entry.bounds,
      captureOffscreen,
    });
  }

  private attachToCurrentWindow(entry: BrowserViewEntry): void {
    const targetWindow = this.getWindow(entry.key.windowId);
    if (targetWindow !== null) {
      this.ensureHostWindowResetListener(entry.key.windowId, targetWindow);
    }
    const currentWindow =
      entry.parentWindowId === null
        ? null
        : this.getWindow(entry.parentWindowId);
    if (entry.parentWindowId === entry.key.windowId && targetWindow !== null) {
      return;
    }
    if (currentWindow !== null) {
      currentWindow.contentView.removeChildView(entry.view);
    }
    entry.parentWindowId = null;
    if (targetWindow === null || targetWindow.isDestroyed()) return;
    targetWindow.contentView.addChildView(entry.view);
    entry.parentWindowId = entry.key.windowId;
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
    const onNavigate = (...args: unknown[]): void => {
      const { isMainFrame, isInPlace } = readHostNavigationFlags(args);
      if (!isMainFrame || isInPlace) return;
      this.handleHostWindowRendererReset(windowId, "navigation", null);
    };
    const onGone = (...args: unknown[]): void => {
      this.handleHostWindowRendererReset(
        windowId,
        "crash",
        readRenderGoneReason(args),
      );
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
    const stillUsed = Array.from(this.entriesByKey.values()).some(
      (entry) => entry.key.windowId === windowId,
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
    for (const entry of this.entriesByKey.values()) {
      if (entry.key.windowId !== windowId) continue;
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
  frameCacheStats(): ReturnType<TileFrameCache["stats"]> {
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
    for (const entry of this.entriesByRuntimeKey.values()) {
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
      evicting: victims.map((victim) => entryKeyId(victim.key)),
    });
    victims.forEach((victim) => {
      // BT-403 silent reload: the renderer keeps the tile's last known
      // title/favicon/URL from prior status events; the next upsert for this
      // key creates a fresh guest and shows its normal loading skeleton.
      this.evictedKeyIdsLog.push(entryKeyId(victim.key));
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
    for (const [keyId, entry] of this.entriesByKey) {
      if (entry.lastAppliedBounds === null) continue;
      out[keyId] = { ...entry.lastAppliedBounds };
    }
    return out;
  }

  /** BT-501: entries currently parked under an overlay owner. */
  debugOccludedKeyIds(): readonly string[] {
    const out: string[] = [];
    for (const [keyId, entry] of this.entriesByKey) {
      if (entry.overlayOwnerIds.length > 0) out.push(keyId);
    }
    return out;
  }

  /** BT-501: guests evicted by the hidden-guest LRU since startup. */
  debugEvictedKeyIds(): readonly string[] {
    return this.evictedKeyIdsLog;
  }

  private isEntryEvictionExempt(entry: BrowserViewEntry): boolean {
    if (entry.overlayOwnerIds.length > 0) return true; // parked (BT-202)
    if (entry.control !== null) return true; // agent holds control grant
    if (entry.annotationSession !== null) return true;
    if (this.pipCaptureEntry === entry) return true;
    if (isAgentBrowserPostureActive(entry.view.webContents)) return true;
    return false;
  }

  private applyEntryVisibility(entry: BrowserViewEntry): void {
    const window = this.getWindow(entry.key.windowId);
    // A tile parked under an active overlay (BT-202) keeps its
    // offscreen-visible posture so its compositor keeps feeding the frame
    // cache; visibility is recomputed when the last owner releases. A dead
    // tile must never stay parked-visible, so it falls through instead.
    if (
      entry.overlayOwnerIds.length > 0 &&
      entry.status !== "dead"
    ) {
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
        keyId: entryKeyId(entry.key),
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
    const keyId = entryKeyId(entry.key);
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
    for (const entry of Array.from(this.entriesByRuntimeKey.values())) {
      if (this.entriesByKey.get(entryKeyId(entry.key)) !== entry) {
        entry.desiredVisible = false;
        entry.parentWindowId = null;
        entry.view.setVisible(false);
        continue;
      }
      const window = this.getWindow(entry.key.windowId);
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
    handoffReason: AgentBrowserViewTileHandoffChange["reason"] | null,
  ): Promise<void> {
    const keyId = entryKeyId(entry.key);
    this.tileFrames.detach(keyId);
    // Claim this entry synchronously, before the `await` below yields
    // control: `closeEntry` is now async (the handoff capture needs a live
    // `webContents`), and every one of its three call sites fires-and-
    // forgets rather than awaiting, so a second teardown trigger racing the
    // first (e.g. two window-change events) must not find this entry again
    // via `entriesByKey` and process it a second time.
    if (this.entriesByRuntimeKey.get(runtimeEntryKey(entry)) !== entry) {
      log.info("[browser-view] view destroy skipped: already claimed", {
        keyId,
        handoffReason,
      });
      return;
    }
    log.info("[browser-view] view destroy started", {
      keyId,
      handoffReason,
      status: entry.status,
    });
    this.entriesByKey.delete(keyId);
    this.entriesByRuntimeKey.delete(runtimeEntryKey(entry));
    this.detachHostWindowResetListenerIfUnused(entry.key.windowId);
    this.destroyDevToolsWindow(entry);
    this.cancelControl(entry, "browser tile closed", null);
    // Ticket 12 item 2: capture and push before anything below tears the
    // tile down - `webContents` must still be alive for the capture.
    // `entry.status === "dead"` means `handleRenderProcessGone` already
    // fired for this tile (the renderer crashed) - the caller's requested
    // reason is overridden with "crash-no-capture" regardless of which of
    // the three teardown paths is processing it now, since a crashed
    // renderer cannot safely be captured from either way.
    if (handoffReason !== null) {
      await this.pushTileHandoff(
        entry,
        entry.status === "dead" ? "crash-no-capture" : handoffReason,
      );
    }
    // Ticket 02 fixup: `pushTileHandoff` above returns immediately for a
    // claimed sibling (its `handedOff` guard), so on its own this `await`
    // does nothing to protect it from the teardown below - it is whichever
    // OTHER tile's `pushTileHandoff` claimed this one that is still busy
    // capturing it. Wait for that (bounded, so a hung capture cannot block
    // quit) before closing `webContents` out from under it.
    if (entry.pendingHandoffCapture !== null) {
      await Promise.race([
        entry.pendingHandoffCapture,
        delay(SIBLING_HANDOFF_CAPTURE_TIMEOUT_MS),
      ]);
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
    webContents.off("input-event", entry.listeners.inputEvent);
    webContents.off("context-menu", entry.listeners.contextMenu);
    webContents.off("blur", entry.listeners.blur);
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
    this.failPendingAnnotationAttachResultsForEntry(entry);
    entry.annotationSession?.dispose("tile-close");
    entry.annotationSession = null;
    if (this.pipCaptureEntry === entry) this.pipCaptureEntry = null;
    entry.debugSession?.dispose();
    entry.debugSession = null;
    entry.view.setVisible(false);
    webContents.close();
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
    this.notifySnapshotInvalidated(entry.key.windowId, {
      ...toTileKey(entry.key),
      reason,
    });
  }

  private handleNativeUserInput(entry: BrowserViewEntry, reason: string): void {
    this.cancelControl(entry, reason, null);
  }

  /**
   * Ticket 12 / ticket 10's design, extended by ticket 02 for multi-tab
   * sessions. Captures `{url, storageState}` and pushes it to the host just
   * before a tile dies, for whatever `reason` the caller names. Best-effort
   * by construction, same posture already accepted for `cdpSessionEnded`: a
   * push that is delayed, dropped, or fails to capture storage still lets
   * the host continue the session headless at `capturedUrl`, and
   * `reclaimUnreachableTileSession`'s TTL path is the fallback if the push
   * never arrives at all.
   *
   * Ticket 02: before capturing anything, this synchronously claims every
   * OTHER still-live tile of the same session as a sibling and marks it
   * `handedOff`, so one frame carries the whole session atomically. This
   * must happen before the first `await` below: `dispose()`'s group
   * teardown fires one `closeEntry` per tile back-to-back with no `await`
   * between them, so a later iteration's own `pushTileHandoff` call must
   * already see `handedOff` set by an earlier iteration rather than racing
   * it to also claim the same siblings.
   *
   * Ticket 02 fixup: that same no-await teardown loop means a claimed
   * sibling's own `closeEntry` (and the `webContents.close()` at the end of
   * it) runs before this function ever reaches the sibling's capture below -
   * `handedOff` alone stops it from pushing a duplicate frame, but does
   * nothing to keep its `webContents` alive long enough to be captured. So
   * this also hands each claimed sibling a shared `pendingHandoffCapture`
   * promise, synchronously, in the same pass - `closeEntry` awaits it
   * (bounded) before tearing down.
   */
  private async pushTileHandoff(
    entry: BrowserViewEntry,
    reason: AgentBrowserViewTileHandoffChange["reason"],
  ): Promise<void> {
    if (entry.handedOff) return;
    entry.handedOff = true;
    const siblings = Array.from(this.entriesByRuntimeKey.values()).filter(
      (candidate) =>
        candidate !== entry &&
        candidate.runtimeTabId !== null &&
        candidate.runtimeSessionId === entry.runtimeSessionId &&
        !candidate.handedOff,
    );
    const { promise: aggregationPromise, resolve: resolveAggregation } =
      Promise.withResolvers<void>();
    for (const sibling of siblings) {
      sibling.handedOff = true;
      sibling.pendingHandoffCapture = aggregationPromise;
    }
    try {
      const capturedStorageState = await this.captureHandoffStorageState(
        entry,
        reason,
      );
      const siblingTabs = await Promise.all(
        siblings.map(async (sibling) => ({
          tabId: sibling.runtimeTabId ?? sibling.key.pageSessionId,
          url: sibling.currentUrl,
          capturedStorageState: await this.captureHandoffStorageState(
            sibling,
            sibling.status === "dead" ? "crash-no-capture" : reason,
          ),
        })),
      );
      this.notifyTileHandoff(entry.key.windowId, {
        ...toTileKey(entry.key),
        capturedUrl: entry.currentUrl,
        capturedStorageState,
        siblingTabs,
        reason,
      });
    } finally {
      for (const sibling of siblings) {
        if (sibling.pendingHandoffCapture === aggregationPromise) {
          sibling.pendingHandoffCapture = null;
        }
      }
      resolveAggregation();
    }
  }

  private async captureHandoffStorageState(
    entry: BrowserViewEntry,
    reason: AgentBrowserViewTileHandoffChange["reason"],
  ): Promise<unknown> {
    // A crashed renderer cannot safely run `executeJavaScript` for
    // localStorage, and its webContents state is not trustworthy - honor
    // "no-capture" in the reason literally rather than attempting one.
    if (reason === "crash-no-capture") return null;
    try {
      const result = await this.captureStorageStateFromBrowser(
        { ...toTileKey(entry.key), origin: entry.currentUrl },
        entry.view.webContents,
      );
      return result.storageState;
    } catch {
      // `entry.currentUrl` is not http(s) (e.g. a fresh "about:blank" tile
      // never navigated), or the capture raced the teardown it precedes.
      // Still hand the session off at its URL, just without carried
      // storage, rather than dropping the whole handoff over this.
      return null;
    }
  }

  private cancelControl(
    entry: BrowserViewEntry,
    reason: string,
    controlId: string | null,
  ): void {
    const control = entry.control;
    if (control === null) return;
    if (controlId !== null && control.controlId !== controlId) return;
    control.generation += 1;
    entry.control = null;
    this.notifyControlRevoked(entry.key.windowId, {
      ...entry.key,
      controlId: control.controlId,
      reason,
    });
    log.info("[browser-view] visible tile control revoked", {
      tileInstanceId: entry.key.tileInstanceId,
      controlId: control.controlId,
      reason,
    });
  }

  private sendControlCommand(
    entry: BrowserViewEntry,
    input: BrowserViewControlAction,
  ): Promise<BrowserViewControlActionResult> {
    const browserDebugger = entry.view.webContents.debugger;
    if (!browserDebugger.isAttached()) {
      browserDebugger.attach("1.3");
    }
    if (input.action.kind === "navigate") {
      return browserDebugger
        .sendCommand("Page.navigate", { url: input.action.url }, undefined)
        .then((value) => ({ status: "completed" as const, value }));
    }
    if (input.action.kind === "scroll") {
      return browserDebugger
        .sendCommand(
          "Input.dispatchMouseEvent",
          {
            type: "mouseWheel",
            x: 1,
            y: 1,
            deltaX: input.action.deltaX,
            deltaY: input.action.deltaY,
          },
          undefined,
        )
        .then((value) => ({ status: "completed" as const, value }));
    }
    if (input.action.kind === "click") {
      return this.clickSelector(browserDebugger, input.action.selector).then(
        (value) => ({ status: "completed" as const, value }),
      );
    }
    return this.typeIntoSelector(entry.control, browserDebugger, input);
  }

  private async clickSelector(
    browserDebugger: BrowserViewDebugger,
    selector: string,
  ): Promise<unknown> {
    const point = await this.resolveSelectorCenter(browserDebugger, selector);
    await browserDebugger.sendCommand(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: point.x, y: point.y },
      undefined,
    );
    await browserDebugger.sendCommand(
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      },
      undefined,
    );
    return await browserDebugger.sendCommand(
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      },
      undefined,
    );
  }

  private async typeIntoSelector(
    control: BrowserViewControlState | null,
    browserDebugger: BrowserViewDebugger,
    input: BrowserViewControlAction,
  ): Promise<BrowserViewControlActionResult> {
    if (control === null || input.action.kind !== "type") {
      return {
        status: "cancelled",
        reason: "Browser control lock is not active.",
      };
    }
    const target = await this.focusSelectorForTyping(
      browserDebugger,
      input.action.selector,
    );
    if (target.sensitive) {
      const approval = this.consumeSensitiveApproval(control, input);
      if (!approval) {
        const approvalId = randomUUID();
        control.pendingSensitiveApprovals.set(approvalId, {
          actionId: input.actionId,
          action: input.action,
        });
        return {
          status: "needs-approval",
          approvalId,
          reason: "Typing into a password field requires explicit approval.",
        };
      }
    }
    const value = await browserDebugger.sendCommand(
      "Input.insertText",
      { text: input.action.text },
      undefined,
    );
    return { status: "completed", value };
  }

  private consumeSensitiveApproval(
    control: BrowserViewControlState,
    input: BrowserViewControlAction,
  ): boolean {
    if (input.sensitiveApprovalId === null || input.action.kind !== "type") {
      return false;
    }
    const approval = control.pendingSensitiveApprovals.get(
      input.sensitiveApprovalId,
    );
    if (approval === undefined) return false;
    if (
      approval.actionId !== input.actionId ||
      !browserViewControlActionsEqual(approval.action, input.action)
    ) {
      return false;
    }
    control.pendingSensitiveApprovals.delete(input.sensitiveApprovalId);
    return true;
  }

  private async resolveSelectorCenter(
    browserDebugger: BrowserViewDebugger,
    selector: string,
  ): Promise<{ readonly x: number; readonly y: number }> {
    const result = await browserDebugger.sendCommand(
      "Runtime.evaluate",
      {
        expression: selectorCenterExpression(selector),
        returnByValue: true,
      },
      undefined,
    );
    if (!isRecord(result)) {
      throw new Error("Could not resolve selector center.");
    }
    const payload = result.result;
    if (!isRecord(payload) || !isRecord(payload.value)) {
      throw new Error("Could not resolve selector center.");
    }
    const x = payload.value.x;
    const y = payload.value.y;
    if (typeof x !== "number" || typeof y !== "number") {
      throw new Error("Could not resolve selector center.");
    }
    return { x, y };
  }

  private async focusSelectorForTyping(
    browserDebugger: BrowserViewDebugger,
    selector: string,
  ): Promise<{ readonly sensitive: boolean }> {
    const result = await browserDebugger.sendCommand(
      "Runtime.evaluate",
      {
        expression: focusSelectorForTypingExpression(selector),
        returnByValue: true,
      },
      undefined,
    );
    if (!isRecord(result)) {
      throw new Error("Could not focus selector.");
    }
    const payload = result.result;
    if (!isRecord(payload) || !isRecord(payload.value)) {
      throw new Error("Could not focus selector.");
    }
    const focused = payload.value.focused;
    const sensitive = payload.value.sensitive;
    if (focused !== true || typeof sensitive !== "boolean") {
      throw new Error("Could not focus selector.");
    }
    return { sensitive };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function entryKeyId(key: BrowserViewEntryKey): string {
  return [key.windowId, key.viewTabId, key.paneId, key.tileInstanceId].join(
    "\u001f",
  );
}

function runtimeEntryKey(entry: BrowserViewEntry): string {
  return [
    entry.runtimeSessionId,
    entry.runtimeTabId ?? entry.key.pageSessionId,
  ].join("\u001f");
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

function readNavigationUrl(args: readonly unknown[]): string | null {
  const value = args[1];
  return typeof value === "string" ? value : null;
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

function readMainFrameFlag(args: readonly unknown[]): boolean {
  const value = args[4];
  return typeof value === "boolean" ? value : true;
}

/**
 * `did-start-navigation` on the host window's own `webContents`:
 * `(event, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId)`.
 * `isInPlace` is Electron's same-document flag (hash change, pushState).
 */
function readHostNavigationFlags(args: readonly unknown[]): {
  readonly isMainFrame: boolean;
  readonly isInPlace: boolean;
} {
  const isInPlace = args[2];
  const isMainFrame = args[3];
  return {
    isMainFrame: typeof isMainFrame === "boolean" ? isMainFrame : true,
    isInPlace: typeof isInPlace === "boolean" ? isInPlace : false,
  };
}

function readInPageMainFrameFlag(args: readonly unknown[]): boolean {
  const value = args[2];
  return typeof value === "boolean" ? value : true;
}

function readRenderGoneReason(args: readonly unknown[]): string {
  const detail = args.find(
    (value): value is { readonly reason: string } =>
      isRecord(value) && typeof value.reason === "string",
  );
  return detail?.reason ?? "Renderer process gone";
}

function readFoundInPageResult(args: readonly unknown[]): {
  readonly requestId: number;
  readonly current: number;
  readonly total: number;
  readonly finalUpdate: boolean;
} | null {
  const value = args.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && typeof candidate.requestId === "number",
  );
  if (value === undefined) return null;
  const requestId = value.requestId;
  const matches = value.matches;
  const activeMatchOrdinal = value.activeMatchOrdinal;
  if (
    typeof requestId !== "number" ||
    typeof matches !== "number" ||
    typeof activeMatchOrdinal !== "number"
  ) {
    return null;
  }
  return {
    requestId,
    current: matches > 0 ? activeMatchOrdinal : 0,
    total: matches,
    finalUpdate: value.finalUpdate === true,
  };
}

function readBeforeInput(args: readonly unknown[]): {
  readonly key: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly modifier: boolean;
} | null {
  const value = args.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && typeof candidate.key === "string",
  );
  if (value === undefined) return null;
  const key = value.key;
  if (typeof key !== "string") return null;
  if (typeof value.type === "string" && value.type !== "keyDown") return null;
  const control = value.control === true;
  const meta = value.meta === true;
  return {
    key,
    control,
    meta,
    shift: value.shift === true,
    alt: value.alt === true,
    modifier: control || meta || value.shift === true || value.alt === true,
  };
}

function browserZoomStepForKey(key: string): 1 | -1 | 0 | null {
  if (key === "+" || key === "=") return 1;
  if (key === "-" || key === "_") return -1;
  if (key === "0" || key === ")") return 0;
  return null;
}

function preventInputDefault(args: readonly unknown[]): void {
  const event = args[0];
  if (!isRecord(event)) return;
  const preventDefault = Reflect.get(event, "preventDefault");
  if (typeof preventDefault !== "function") return;
  Reflect.apply(preventDefault, event, []);
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

function readPopupWindow(
  args: readonly unknown[],
): BrowserViewPopupWindow | null {
  const value = args[0];
  if (!isRecord(value)) return null;
  const webContents = toPopupWebContents(Reflect.get(value, "webContents"));
  const isDestroyed = Reflect.get(value, "isDestroyed");
  const close = Reflect.get(value, "close");
  const on = Reflect.get(value, "on");
  const off = Reflect.get(value, "off");
  if (
    webContents === null ||
    typeof isDestroyed !== "function" ||
    typeof close !== "function" ||
    typeof on !== "function" ||
    typeof off !== "function"
  ) {
    return null;
  }
  return {
    webContents,
    isDestroyed: () => Boolean(Reflect.apply(isDestroyed, value, [])),
    close: () => {
      Reflect.apply(close, value, []);
    },
    on: (event, listener) => {
      Reflect.apply(on, value, [event, listener]);
    },
    off: (event, listener) => {
      Reflect.apply(off, value, [event, listener]);
    },
  };
}

function toPopupWebContents(
  value: unknown,
): BrowserViewPopupWebContents | null {
  if (!isRecord(value)) return null;
  const id = Reflect.get(value, "id");
  const once = Reflect.get(value, "once");
  const on = Reflect.get(value, "on");
  const off = Reflect.get(value, "off");
  if (
    typeof id !== "number" ||
    typeof once !== "function" ||
    typeof on !== "function" ||
    typeof off !== "function"
  ) {
    return null;
  }
  return {
    id,
    once: (event, listener) => {
      Reflect.apply(once, value, [event, listener]);
    },
    on: (event, listener) => {
      Reflect.apply(on, value, [event, listener]);
    },
    off: (event, listener) => {
      Reflect.apply(off, value, [event, listener]);
    },
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function selectorCenterExpression(selector: string): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  })()`;
}

function focusSelectorForTypingExpression(selector: string): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return { focused: false, sensitive: false };
    element.focus();
    const sensitiveAutocomplete = new Set([
      "current-password",
      "new-password",
      "one-time-code",
    ]);
    const autocompleteTokens = element
      .autocomplete
      .toLowerCase()
      .split(/\\s+/u)
      .filter((token) => token.length > 0);
    const isInput = element instanceof HTMLInputElement;
    const sensitive =
      isInput &&
      (element.type.toLowerCase() === "password" ||
        autocompleteTokens.some(
          (token) =>
            sensitiveAutocomplete.has(token) || token.startsWith("cc-"),
        ));
    return { focused: document.activeElement === element, sensitive };
  })()`;
}

function browserViewControlActionsEqual(
  left: BrowserViewControlAction["action"],
  right: BrowserViewControlAction["action"],
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "click") {
    return right.kind === "click" && left.selector === right.selector;
  }
  if (left.kind === "type") {
    return (
      right.kind === "type" &&
      left.selector === right.selector &&
      left.text === right.text
    );
  }
  if (left.kind === "scroll") {
    return (
      right.kind === "scroll" &&
      left.deltaX === right.deltaX &&
      left.deltaY === right.deltaY
    );
  }
  return right.kind === "navigate" && left.url === right.url;
}

/**
 * Ticket 03's enumerated CDP dispatch. Each `AgentBrowserViewCdpCommand` kind
 * maps to exactly one CDP method - deliberately not a generic
 * `sendCommand(method, params)` passthrough, so growth here always means
 * adding a case, never widening what a single case accepts.
 */
async function sendCdpCommand(
  browserDebugger: BrowserViewDebugger,
  sessionId: string | undefined,
  command: AgentBrowserViewCdpCommand,
): Promise<AgentBrowserViewCdpResult> {
  switch (command.kind) {
    case "cdpNavigate": {
      const value = await browserDebugger.sendCommand(
        "Page.navigate",
        { url: command.url },
        sessionId,
      );
      const record = isRecord(value) ? value : {};
      return {
        kind: "cdpNavigate",
        ok: true,
        frameId: stringOrNull(record.frameId),
        loaderId: stringOrNull(record.loaderId),
        errorText: stringOrNull(record.errorText),
      };
    }
    case "cdpCaptureScreenshot": {
      const params: Record<string, unknown> = { format: command.format };
      if (command.quality !== null) params.quality = command.quality;
      const value = await browserDebugger.sendCommand(
        "Page.captureScreenshot",
        params,
        sessionId,
      );
      const record = isRecord(value) ? value : {};
      return {
        kind: "cdpCaptureScreenshot",
        ok: true,
        dataBase64: stringOrNull(record.data) ?? "",
      };
    }
    case "cdpGetFrameTree": {
      const value = await browserDebugger.sendCommand(
        "Page.getFrameTree",
        {},
        sessionId,
      );
      const record = isRecord(value) ? value : {};
      return {
        kind: "cdpGetFrameTree",
        ok: true,
        frames: flattenFrameTree(record.frameTree),
      };
    }
    case "cdpCreateIsolatedWorld": {
      const value = await browserDebugger.sendCommand(
        "Page.createIsolatedWorld",
        {
          frameId: command.frameId,
          worldName: command.worldName,
          grantUniveralAccess: command.grantUniversalAccess,
        },
        sessionId,
      );
      const record = isRecord(value) ? value : {};
      return {
        kind: "cdpCreateIsolatedWorld",
        ok: true,
        executionContextId: numberOrNull(record.executionContextId),
      };
    }
    case "cdpEvaluate": {
      const params: Record<string, unknown> = {
        expression: command.expression,
        awaitPromise: command.awaitPromise,
        returnByValue: command.returnByValue,
      };
      if (command.contextId !== null) params.contextId = command.contextId;
      const value = await browserDebugger.sendCommand(
        "Runtime.evaluate",
        params,
        sessionId,
      );
      return remoteObjectResult("cdpEvaluate", value);
    }
    case "cdpCallFunctionOn": {
      const params: Record<string, unknown> = {
        functionDeclaration: command.functionDeclaration,
        returnByValue: command.returnByValue,
      };
      if (command.objectId !== null) params.objectId = command.objectId;
      if (command.executionContextId !== null) {
        params.executionContextId = command.executionContextId;
      }
      if (command.argumentsJson !== null) {
        params.arguments = command.argumentsJson;
      }
      const value = await browserDebugger.sendCommand(
        "Runtime.callFunctionOn",
        params,
        sessionId,
      );
      return remoteObjectResult("cdpCallFunctionOn", value);
    }
    case "cdpReleaseObject": {
      await browserDebugger.sendCommand(
        "Runtime.releaseObject",
        { objectId: command.objectId },
        sessionId,
      );
      return { kind: "cdpReleaseObject", ok: true };
    }
    case "cdpDispatchMouseEvent": {
      const params: Record<string, unknown> = {
        type: command.type,
        x: command.x,
        y: command.y,
      };
      if (command.button !== null) params.button = command.button;
      if (command.clickCount !== null) params.clickCount = command.clickCount;
      if (command.deltaX !== null) params.deltaX = command.deltaX;
      if (command.deltaY !== null) params.deltaY = command.deltaY;
      await browserDebugger.sendCommand(
        "Input.dispatchMouseEvent",
        params,
        sessionId,
      );
      return { kind: "cdpDispatchMouseEvent", ok: true };
    }
    case "cdpInsertText": {
      await browserDebugger.sendCommand(
        "Input.insertText",
        { text: command.text },
        sessionId,
      );
      return { kind: "cdpInsertText", ok: true };
    }
    case "cdpDispatchKeyEvent": {
      const params: Record<string, unknown> = { type: command.type };
      if (command.key !== null) params.key = command.key;
      if (command.code !== null) params.code = command.code;
      if (command.text !== null) params.text = command.text;
      if (command.modifiers !== null) params.modifiers = command.modifiers;
      if (command.unmodifiedText !== null)
        params.unmodifiedText = command.unmodifiedText;
      if (command.windowsVirtualKeyCode !== null)
        params.windowsVirtualKeyCode = command.windowsVirtualKeyCode;
      if (command.location !== null) params.location = command.location;
      if (command.isKeypad !== null) params.isKeypad = command.isKeypad;
      if (command.autoRepeat !== null) params.autoRepeat = command.autoRepeat;
      if (command.commands !== null) params.commands = command.commands;
      await browserDebugger.sendCommand(
        "Input.dispatchKeyEvent",
        params,
        sessionId,
      );
      return { kind: "cdpDispatchKeyEvent", ok: true };
    }
    case "cdpSetDeviceMetricsOverride": {
      await browserDebugger.sendCommand(
        "Emulation.setDeviceMetricsOverride",
        {
          width: command.width,
          height: command.height,
          deviceScaleFactor: command.deviceScaleFactor,
          mobile: command.mobile,
        },
        sessionId,
      );
      return { kind: "cdpSetDeviceMetricsOverride", ok: true };
    }
    case "cdpSetAutoAttach": {
      await browserDebugger.sendCommand(
        "Target.setAutoAttach",
        {
          autoAttach: command.autoAttach,
          flatten: true,
          waitForDebuggerOnStart: command.waitForDebuggerOnStart,
        },
        sessionId,
      );
      return { kind: "cdpSetAutoAttach", ok: true };
    }
    case "cdpDescribeNode": {
      const params: Record<string, unknown> = {
        objectId: command.objectId,
        pierce: command.pierce,
      };
      if (command.depth !== null) params.depth = command.depth;
      const value = await browserDebugger.sendCommand(
        "DOM.describeNode",
        params,
        sessionId,
      );
      const record = isRecord(value) ? value : {};
      const node = isRecord(record.node) ? record.node : null;
      return {
        kind: "cdpDescribeNode",
        ok: true,
        nodeId: node === null ? null : numberOrNull(node.nodeId),
        backendNodeId: node === null ? null : numberOrNull(node.backendNodeId),
        nodeName: node === null ? null : stringOrNull(node.nodeName),
        frameId: node === null ? null : stringOrNull(node.frameId),
      };
    }
    case "cdpGetFullAXTree": {
      const params: Record<string, unknown> = {};
      if (command.depth !== null) params.depth = command.depth;
      const value = await browserDebugger.sendCommand(
        "Accessibility.getFullAXTree",
        params,
        sessionId,
      );
      const record = isRecord(value) ? value : {};
      return {
        kind: "cdpGetFullAXTree",
        ok: true,
        nodesJson: record.nodes ?? null,
      };
    }
    default: {
      const exhaustive: never = command;
      throw new Error(
        `Unhandled agent CDP command: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

function remoteObjectResult(
  kind: "cdpEvaluate" | "cdpCallFunctionOn",
  value: unknown,
): AgentBrowserViewCdpResult {
  const record = isRecord(value) ? value : {};
  const result = isRecord(record.result) ? record.result : null;
  const exceptionDetails = isRecord(record.exceptionDetails)
    ? record.exceptionDetails
    : null;
  return {
    kind,
    ok: true,
    resultJson: result === null ? null : (result.value ?? null),
    objectId: result === null ? null : stringOrNull(result.objectId),
    exceptionDescription:
      exceptionDetails === null ? null : describeException(exceptionDetails),
  };
}

/**
 * `exceptionDetails.text` alone is a generic CDP placeholder ("Uncaught" /
 * "Uncaught (in promise)") whenever the thrown/rejected value isn't itself an
 * `Error` with a message baked into that placeholder - a syntax error's real
 * reason lives only in `exceptionDetails.exception.description`, and a
 * rejected primitive (`Promise.reject("boom")`) has no `description` at all
 * and would otherwise vanish entirely behind the bare placeholder. Enriching
 * only when `text` is one of the known-generic placeholders leaves the
 * already-informative case (a thrown `Error`, whose `text` already includes
 * its message) untouched. Mirrors `traycer-host`'s
 * `playwright-cdp-dispatch.ts`'s `describeException` for the same CDP shape
 * on the other runtime - kept as a parallel implementation rather than a
 * shared one, per this module's cross-repo boundary with `traycer-host`.
 */
const GENERIC_EXCEPTION_TEXT = new Set(["Uncaught", "Uncaught (in promise)"]);

function describeException(exceptionDetails: Record<string, unknown>): string {
  const text = stringOrNull(exceptionDetails.text) ?? "Uncaught exception";
  if (!GENERIC_EXCEPTION_TEXT.has(text)) return text;
  const exception = isRecord(exceptionDetails.exception)
    ? exceptionDetails.exception
    : null;
  if (exception === null) return text;
  const description = stringOrNull(exception.description);
  if (description !== null) return `${text}: ${description}`;
  if ("value" in exception)
    return `${text}: ${JSON.stringify(exception.value)}`;
  return text;
}

function flattenFrameTree(value: unknown): AgentBrowserViewCdpFrameInfo[] {
  const root = isRecord(value) ? value : null;
  if (root === null) return [];
  const out: AgentBrowserViewCdpFrameInfo[] = [];
  collectFrameTreeNode(root, out);
  return out;
}

function collectFrameTreeNode(
  node: Record<string, unknown>,
  out: AgentBrowserViewCdpFrameInfo[],
): void {
  const frame = isRecord(node.frame) ? node.frame : null;
  if (frame !== null) {
    out.push({
      frameId: stringOrNull(frame.id) ?? "",
      parentFrameId: stringOrNull(frame.parentId),
      url: stringOrNull(frame.url) ?? "",
      securityOrigin: stringOrNull(frame.securityOrigin),
    });
  }
  const childFrames = Array.isArray(node.childFrames) ? node.childFrames : [];
  for (const child of childFrames) {
    if (isRecord(child)) collectFrameTreeNode(child, out);
  }
}

function classifyCdpError(err: unknown): AgentBrowserViewCdpErrorInfo {
  const message = err instanceof Error ? err.message : String(err);
  if (message.toLowerCase().includes("not attached")) {
    return { kind: "not_attached", message, code: null };
  }
  const code = isRecord(err) && typeof err.code === "number" ? err.code : null;
  return { kind: "cdp_error", message, code };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
