import type { BrowserWindowConstructorOptions } from "electron";
import type {
  BrowserCdpCommand,
  BrowserCdpTarget,
  BrowserSessionProfileKind,
  BrowserStorageState,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserViewNativeTabCapability,
  BrowserViewNativeTabKey,
} from "@traycer-clients/shared/platform/browser-view";
import type { BrowserStorageSession } from "./storage/browser-storage-state";

/**
 * One `createElectronTab` frame on its way into the native manager.
 *
 * MAIN-side only, and that is the point (H10): the frame is consumed by the
 * process that owns the jar, so the seed never crosses an IPC boundary and no
 * renderer can inject one. Every check the seed goes through - domain
 * re-derivation against the tab's own origin, expiry, the bound, the ledger
 * gate, the serializer - is unchanged (H05 item 1).
 */
export interface BrowserViewEnsureTab extends BrowserViewNativeTabKey {
  readonly requestedUrl: string;
  /**
   * Which jar the guest is born into. It travels from the host's
   * `createElectronTab` frame; `isolated` selects the session's own in-memory
   * partition and never carries a seed.
   */
  readonly profile: BrowserSessionProfileKind;
  readonly seedStorageState: BrowserStorageState | null;
  /**
   * The live stream incarnation the `createElectronTab` frame arrived on - the
   * SAME provenance `primaryProfileObserved` carries, and for the same reason:
   * the seed is a host->jar write, so it is priced against the connection that
   * sent it (the forget ledger's per-connection ack watermark and the observed
   * rate budget both key on this). Null off-connection, which fails the ledger
   * gate closed.
   */
  readonly connectionId: string | null;
}

export interface BrowserViewElectronTabCdpDispatch extends BrowserViewNativeTabCapability {
  readonly target: BrowserCdpTarget;
  readonly command: BrowserCdpCommand;
}

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

interface BrowserViewOpenDevToolsOptions {
  readonly mode: "detach";
  readonly activate: boolean;
  readonly title: string;
}

interface BrowserViewFindInPageOptions {
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

interface BrowserViewDevToolsWebContents {
  readonly id: number;
}

export interface BrowserViewDevToolsWindow {
  readonly webContents: BrowserViewDevToolsWebContents;
  isDestroyed(): boolean;
  destroy(): void;
}

export interface BrowserViewPopupWebContents {
  readonly id: number;
  once(event: "destroyed", listener: () => void): void;
  setWindowOpenHandler(
    handler: (
      details: BrowserViewWindowOpenDetails,
    ) => BrowserViewWindowOpenResult,
  ): void;
  on: NodeJS.EventEmitter["on"];
  off: NodeJS.EventEmitter["off"];
}

export interface BrowserViewPopupWindow {
  readonly webContents: BrowserViewPopupWebContents;
  isDestroyed(): boolean;
  close(): void;
  on(event: "closed", listener: () => void): void;
  off(event: "closed", listener: () => void): void;
}

export interface BrowserViewWebContents {
  readonly id: number;
  readonly session: BrowserStorageSession;
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
  on: NodeJS.EventEmitter["on"];
  off: NodeJS.EventEmitter["off"];
}

/**
 * Main-owned mint of a renderer `<webview>` guest.
 * `onAttached` runs seed/CDP while the request gate is still up.
 * The mint's `ready` Promise settles after that gate is disposed, or
 * rejects on timeout/terminal drop. It is not a renderer payload.
 */
export interface BrowserViewGuestAttachRequest {
  readonly partition: string;
  readonly onAttached: (guest: BrowserViewWebContents) => Promise<void>;
}

export interface BrowserViewGuestAttachResult {
  readonly registrationId: string;
  readonly ready: Promise<void>;
}

export type BrowserViewInputModifier = "meta" | "control" | "shift" | "alt";

export interface BrowserViewHostWebContents {
  on: NodeJS.EventEmitter["on"];
  off: NodeJS.EventEmitter["off"];
  /**
   * Move OS keyboard focus off a focused guest and onto the host renderer.
   * Focusing a host DOM element is not enough by itself - the caret would
   * render while keystrokes still went to the guest `webContents`.
   */
  focus(): void;
  sendInputEvent(event: {
    readonly type: "keyDown";
    readonly keyCode: string;
    readonly modifiers?: BrowserViewInputModifier[];
  }): void;
}

export interface BrowserViewWindow {
  readonly webContents: BrowserViewHostWebContents | null;
  isDestroyed(): boolean;
}
