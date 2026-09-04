import type { BrowserWindowConstructorOptions } from "electron";
import type {
  BrowserCdpCommand,
  BrowserCdpTarget,
  BrowserSessionProfileKind,
  BrowserStorageState,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserViewBounds,
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

/**
 * A live guest whose lifecycle just moved from the window that held it to the
 * window that ensured it - the desktop half of "Show here".
 *
 * MAIN-side only, deliberately: the window that LOST the tab still holds an
 * accepted birth for it, and nothing else retires one (the move sends no
 * `releaseElectronTab`, and the rollback path returns early for an accepted
 * birth). That window's `ElectronTabs` is a main-process object, so this
 * reaches it directly rather than through a renderer event - and its
 * `retireBirth` already emits `tabReleased`, which is how the renderer's
 * binding directory hears about it.
 *
 * `previousRegistrationId` is the incarnation the OLD window knows the guest
 * by; the transfer minted a new one, so it is also the id every stale
 * capability in that window now quotes.
 */
export interface BrowserViewNativeTabTransfer {
  readonly key: BrowserViewNativeTabKey;
  readonly previousRegistrationId: string;
  readonly toWindowId: string;
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

/**
 * Compositor frames additionally support downscaling: the BT-201 frame cache
 * caps the long edge before encoding, and `NativeImage` - the only production
 * source - provides `resize`. Kept separate from `BrowserViewCapturedImage`
 * so the crop/annotation paths keep the smaller contract they actually use.
 */
export interface BrowserViewFrameImage extends BrowserViewCapturedImage {
  resize(options: {
    readonly width: number;
    readonly height: number;
  }): BrowserViewFrameImage;
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
  beginFrameSubscription(
    callback: (image: BrowserViewFrameImage) => void,
  ): void;
  endFrameSubscription(): void;
  on: NodeJS.EventEmitter["on"];
  off: NodeJS.EventEmitter["off"];
}

export interface ManagedBrowserView {
  readonly webContents: BrowserViewWebContents;
  setBounds(bounds: BrowserViewBounds): void;
  setVisible(visible: boolean): void;
}

interface ManagedContentView {
  addChildView(view: ManagedBrowserView): void;
  removeChildView(view: ManagedBrowserView): void;
}

export type BrowserViewInputModifier = "meta" | "control" | "shift" | "alt";

export interface BrowserViewHostWebContents {
  on: NodeJS.EventEmitter["on"];
  off: NodeJS.EventEmitter["off"];
  /**
   * Move OS keyboard focus off a focused guest and onto the host renderer.
   * Focusing a host DOM element is not enough by itself - the caret would
   * render while keystrokes still went to the `WebContentsView`.
   */
  focus(): void;
  sendInputEvent(event: {
    readonly type: "keyDown";
    readonly keyCode: string;
    readonly modifiers?: BrowserViewInputModifier[];
  }): void;
}

export interface BrowserViewWindow {
  readonly contentView: ManagedContentView;
  readonly webContents: BrowserViewHostWebContents | null;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
}
