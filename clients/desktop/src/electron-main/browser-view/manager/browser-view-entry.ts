import type {
  BrowserViewBounds,
  BrowserViewCertificateErrorChange,
  BrowserViewNativeTabKey,
  BrowserViewStatus,
  BrowserViewTileKey,
  BrowserViewViewportPresetId,
} from "@traycer-clients/shared/platform/browser-view";
import type { BrowserAnnotationSession } from "../annotation/browser-annotation-session";
import type { BrowserDebugSession } from "../debug/browser-debug-session";
import type { BrowserViewEntryKey } from "./browser-view-entry-registry";
import type {
  BrowserViewDevToolsWindow,
  ManagedBrowserView,
} from "../browser-view-port";
import type { NativeBrowserViewLifecycle } from "./native-browser-view-lifecycle";
import type { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";

/**
 * The single renderer-notification seam every subsystem writes through
 * (`RunnerIpcBridge.safeSendToWindow`); the boolean reports delivery.
 */
export type BrowserViewSend = (
  windowId: string,
  channel: (typeof RunnerHostEvent)[keyof typeof RunnerHostEvent],
  payload: unknown,
) => boolean;

/**
 * Every `webContents.on(...)` registration for one guest, keyed by event name.
 * Attach and teardown both iterate this map, so the two cannot drift. The
 * handler type is the emitter's own so both loops type-check against it.
 */
export type BrowserViewListenerMap = Readonly<
  Record<string, Parameters<NodeJS.EventEmitter["on"]>[1]>
>;

export interface BrowserViewEntry {
  surface: BrowserViewEntryKey | null;
  surfaceBindingId: string | null;
  readonly guestKey: string;
  readonly identity: BrowserViewNativeIdentity;
  readonly view: ManagedBrowserView;
  readonly listeners: BrowserViewListenerMap;
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
  /** Visibility last computed by the geometry pass; null before the first. */
  visible: boolean | null;
  /** Last `visible` value logged, so forensics logging fires only on change. */
  lastLoggedVisible: boolean | null;
  /**
   * Set when the host window's own renderer starts a fresh main-frame
   * navigation or crashes, before the new renderer has re-upserted this
   * entry. Forces `applyEntryVisibility` to hide the tile so it cannot
   * composite over the blank/reloading window; cleared when the surface is
   * rebound.
   */
  rendererResetPending: boolean;
  internalNavigation: boolean;
  /** One teardown shared by every close trigger for this guest. */
  closePromise: Promise<void> | null;
}

export interface BrowserViewNativeIdentity {
  readonly key: BrowserViewNativeTabKey;
  readonly registrationId: string;
  /** Current renderer connection that owns this guest's lifecycle stream. */
  lifecycleWindowId: string;
  readonly lifecycle: NativeBrowserViewLifecycle;
}

export interface BrowserViewEntryFindState {
  readonly appRequestId: number;
  readonly query: string;
  readonly matchCase: boolean;
  readonly sessionsByElectronRequestId: Map<
    number,
    BrowserViewEntryFindSession
  >;
}

export interface BrowserViewEntryFindSession {
  readonly appRequestId: number;
  readonly query: string;
  readonly matchCase: boolean;
}

export function requireSurface(entry: BrowserViewEntry): BrowserViewEntryKey {
  if (entry.surface === null) {
    throw new Error(`Browser guest ${entry.guestKey} has no surface.`);
  }
  return entry.surface;
}

export function toTileKey(key: BrowserViewEntryKey): BrowserViewTileKey {
  return {
    viewTabId: key.viewTabId,
    paneId: key.paneId,
    tileInstanceId: key.tileInstanceId,
    pageSessionId: key.pageSessionId,
  };
}
