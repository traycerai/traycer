import type { BrowserWindowConstructorOptions } from "electron";
import type { BrowserViewBounds } from "@traycer-clients/shared/platform/browser-view";
import type { BrowserStorageSession } from "./storage/browser-storage-state";

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
