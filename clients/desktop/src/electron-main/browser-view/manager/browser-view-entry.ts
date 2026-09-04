import type {
  BrowserViewCertificateErrorChange,
  BrowserViewNativeTabKey,
  BrowserViewStatus,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import type { BrowserAnnotationSession } from "../annotation/browser-annotation-session";
import type { BrowserSessionProfile } from "../browser-session";
import type { BrowserDebugSession } from "../debug/browser-debug-session";
import type { BrowserViewEntryKey } from "./browser-view-entry-registry";
import type {
  BrowserViewDevToolsWindow,
  BrowserViewWebContents,
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
  /**
   * The jar this guest was born into, kept on the entry because teardown is
   * the only thing that can tell an isolated session's partition it may go:
   * by then the host frame that named the profile is long gone.
   */
  readonly profile: BrowserSessionProfile;
  /** The guest itself. Capability code talks only to this. */
  readonly webContents: BrowserViewWebContents;
  readonly listeners: BrowserViewListenerMap;
  desiredVisible: boolean;
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
  /**
   * Set when the host window's own renderer starts a fresh main-frame
   * navigation or crashes, before the new renderer has re-upserted this
   * entry. Cleared when the surface is rebound.
   */
  rendererResetPending: boolean;
  internalNavigation: boolean;
  /** One teardown shared by every close trigger for this guest. */
  closePromise: Promise<void> | null;
}

export interface BrowserViewNativeIdentity {
  readonly key: BrowserViewNativeTabKey;
  /**
   * The incarnation every host-side capability quotes. Fixed for the entry's
   * life: a cross-window move REPLACES the entry (see
   * `BrowserViewProvisioning.replaceNativeGuestForWindow`), so the new window's
   * guest carries a freshly minted id and every call still quoting the old one
   * finds no entry (`findExactNativeEntry` and `releaseTab`'s own check).
   */
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
