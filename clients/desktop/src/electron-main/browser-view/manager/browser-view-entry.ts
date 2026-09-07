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

export type BrowserViewSend = (
  windowId: string,
  channel: (typeof RunnerHostEvent)[keyof typeof RunnerHostEvent],
  payload: unknown,
) => boolean;

/** Attach and teardown both iterate this map, so the two cannot drift. */
export type BrowserViewListenerMap = Readonly<
  Record<string, Parameters<NodeJS.EventEmitter["on"]>[1]>
>;

export interface BrowserViewEntry {
  surface: BrowserViewEntryKey | null;
  surfaceBindingId: string | null;
  readonly guestKey: string;
  readonly identity: BrowserViewNativeIdentity;
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
  /** Set when the host window's own renderer starts a fresh main-frame navigation or crashes, before the new renderer has re-upserted this entry. */
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
