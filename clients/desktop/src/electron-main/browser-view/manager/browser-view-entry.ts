import type {
  BrowserViewCertificateErrorChange,
  BrowserViewNativeTabKey,
  BrowserViewStatus,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import type { BrowserAnnotationSession } from "../annotation/browser-annotation-session";
import type { BrowserSessionProfile } from "../browser-session";
import type { BrowserDebugSession } from "../debug/browser-debug-session";
import type { BrowserPageEmulation } from "../emulation/browser-page-emulation";
import type { BrowserPreviewWindowHandle } from "./browser-preview-window";
import type { BrowserPageRecording } from "../recording/browser-page-recording";
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
  /**
   * The current document's declared icon, or `null` when it declares none.
   *
   * Cleared on navigation rather than carried: Chromium emits the event only
   * when a page HAS an icon, so a page without one would otherwise keep showing
   * the previous page's - which reads as the tile having navigated nowhere.
   */
  currentFaviconUrl: string | null;
  /**
   * The icon URL the page itself declared, kept only to notice when it changes.
   *
   * Distinct from {@link currentFaviconUrl}, which holds the `data:` URL read
   * from it: a renderer is never given a guest-chosen remote address to fetch,
   * so the address the page named and the value the tile displays are two
   * different things and both have to be remembered.
   */
  declaredFaviconUrl: string | null;
  status: BrowserViewStatus;
  statusReason: string | null;
  findState: BrowserViewEntryFindState;
  certificateError: BrowserViewCertificateErrorChange | null;
  debugSession: BrowserDebugSession | null;
  /**
   * This tile's viewport/appearance emulation, minted with its first use.
   *
   * Lives on the entry rather than beside the debug session because it is the
   * tile's INTENT, which outlives any one CDP attachment: a debugger that
   * detaches and reattaches must find the same overrides waiting to be
   * restated, and a guest replaced by a cross-window move gets a fresh one
   * exactly as it gets a fresh registration id.
   */
  emulation: BrowserPageEmulation | null;
  annotationSession: BrowserAnnotationSession | null;
  devToolsWindow: BrowserViewDevToolsWindow | null;
  /** The always-on-top window on this tile's page, while one is open. */
  previewWindow: BrowserPreviewWindowHandle | null;
  /** The frame pump for a recording in progress, minted on first use. */
  recording: BrowserPageRecording | null;
  /**
   * Set when the host window's own renderer starts a fresh main-frame
   * navigation or crashes, before the new renderer has re-upserted this
   * entry. Cleared when the surface is rebound.
   */
  rendererResetPending: boolean;
  internalNavigation: boolean;
  /**
   * Set when this guest is being closed only to be re-born in another window
   * at the same tab identity ("Show here"). Its close must then leave the
   * session's storage alone: an isolated partition is released with the
   * session's last guest, and at that moment the successor does not exist
   * yet, so without this the replacement would be born into a partition the
   * close had just cleared. Cleared again if the successor's birth fails, at
   * which point the close's release runs after all.
   */
  succeededByReplacement: boolean;
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
