import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../../app/logger";
import { BrowserViewManager } from "../browser-view-manager";
import type {
  BrowserViewCapturedImage,
  BrowserViewDebugger,
  BrowserViewPopupWebContents,
  BrowserViewWebContents,
  BrowserViewWindow,
  ManagedBrowserView,
} from "../browser-view-port";
import type {
  BrowserViewElectronTabHandoffChange,
  BrowserViewCertificateErrorChange,
  BrowserViewDebugSnapshotChange,
  BrowserViewDownloadChange,
  BrowserViewFindChange,
  BrowserViewOpenTileRequest,
  BrowserViewNativeTabStatusChange,
  BrowserViewSnapshotInvalidatedChange,
  BrowserViewStatusChange,
  BrowserViewStorageStateApply,
  BrowserViewStorageStateApplyResult,
  BrowserViewStorageStateCaptureResult,
  BrowserViewTileKey,
  BrowserViewTileUpsert,
} from "../../../ipc-contracts/browser-view-types";
import type { PipCaptureIpcPayload } from "../../../ipc-contracts/pip-capture-types";
import type {
  BrowserAnnotationAttachedIpcEvent,
  BrowserAnnotationSessionIpcEvent,
} from "../../../ipc-contracts/browser-annotation-types";
import { ANNOTATION_BINDING_NAME } from "../browser-annotation-overlay-script";
import type {
  BrowserSessionCertificateErrorChange,
  BrowserSessionDownloadChange,
} from "../browser-session";

type BrowserViewManagerOptions = ConstructorParameters<
  typeof BrowserViewManager
>[0];
type ManagedContentView = BrowserViewWindow["contentView"];

const BASE_KEY: BrowserViewTileKey = {
  viewTabId: "view-tab-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-1",
};

function upsert(
  key: BrowserViewTileKey,
  url: string,
  visible: boolean,
): BrowserViewTileUpsert {
  return { ...key, url, visible, viewportPreset: "responsive" };
}

class FakeDebugger implements BrowserViewDebugger {
  attached = false;
  detached = false;
  deferCommands = false;
  readonly commandResolvers: Array<(value: unknown) => void> = [];
  readonly commands: Array<{
    readonly method: string;
    readonly params: Record<string, unknown>;
    readonly sessionId: string | undefined;
  }> = [];
  readonly passwordSelectors = new Set<string>();
  private readonly events = new EventEmitter();

  constructor(
    private readonly lifecycle: string[],
    private readonly requireLoadedTargetForPageCommands: boolean,
  ) {}

  isAttached(): boolean {
    return this.attached;
  }

  attach(_protocolVersion: string): void {
    this.attached = true;
  }

  detach(): void {
    this.detached = true;
    this.attached = false;
  }

  sendCommand(
    method: string,
    commandParams: Record<string, unknown>,
    sessionId: string | undefined,
  ): Promise<unknown> {
    this.lifecycle.push(method);
    this.commands.push({ method, params: commandParams, sessionId });
    if (this.deferCommands) {
      return new Promise((resolve) => {
        this.commandResolvers.push(resolve);
      });
    }
    if (
      this.requireLoadedTargetForPageCommands &&
      method === "Page.addScriptToEvaluateOnNewDocument" &&
      !this.lifecycle.includes("loadURL")
    ) {
      return Promise.reject(new Error("Page target is not ready"));
    }
    if (method === "Runtime.evaluate") {
      return Promise.resolve(this.evaluateRuntime(commandParams));
    }
    if (method === "Page.addScriptToEvaluateOnNewDocument") {
      return Promise.resolve({ identifier: "seed-script-1" });
    }
    if (method === "Page.getFrameTree") {
      return Promise.resolve({
        frameTree: {
          frame: { id: "FRAME-1", url: "https://example.com/" },
        },
      });
    }
    if (method === "Page.createIsolatedWorld") {
      return Promise.resolve({ executionContextId: 77 });
    }
    if (
      method === "Page.enable" ||
      method === "Runtime.enable" ||
      method === "Runtime.addBinding" ||
      method === "Runtime.removeBinding"
    ) {
      return Promise.resolve({});
    }
    return Promise.resolve(null);
  }

  private evaluateRuntime(commandParams: Record<string, unknown>): {
    readonly result: { readonly value: unknown };
  } {
    const expression =
      typeof commandParams.expression === "string"
        ? commandParams.expression
        : "";
    if (expression.includes("sensitiveAutocomplete")) {
      const selectorSensitive = [...this.passwordSelectors].some((selector) =>
        expression.includes(JSON.stringify(selector)),
      );
      const creditCardAutocompleteSensitive =
        expression.includes('startsWith("cc-")') &&
        expression.includes("cc-number");
      return {
        result: {
          value: {
            focused: true,
            sensitive: selectorSensitive || creditCardAutocompleteSensitive,
          },
        },
      };
    }
    if (
      expression.includes("getBoundingClientRect") &&
      !expression.includes("__traycerAnnotation")
    ) {
      return { result: { value: { x: 10, y: 10 } } };
    }
    if (expression.includes("traycerAnnotationViewport")) {
      return { result: { value: { width: 320, height: 180 } } };
    }
    return { result: { value: true } };
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.events.on(event, listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.events.off(event, listener);
  }

  emitMessage(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    this.events.emit("message", {}, method, params, sessionId);
  }

  emitDetach(reason: string): void {
    this.attached = false;
    this.events.emit("detach", {}, reason);
  }
}

class FakeWebContents extends EventEmitter implements BrowserViewWebContents {
  readonly lifecycle: string[] = [];
  readonly debugger: FakeDebugger;
  readonly navigationHistory = {
    canGoBack: () => this.canGoBackValue,
    canGoForward: () => this.canGoForwardValue,
    clear: () => {
      this.clearNavigationHistoryCalls += 1;
    },
    goBack: () => {
      this.goBackCalls += 1;
    },
    goForward: () => {
      this.goForwardCalls += 1;
    },
  };
  readonly loadUrls: string[] = [];
  readonly executedJavaScript: string[] = [];
  readonly captureVisibleStates: boolean[] = [];
  readonly findInPageCalls: Array<{
    readonly requestId: number;
    readonly text: string;
    readonly options: {
      readonly forward: boolean;
      readonly findNext: boolean;
      readonly matchCase: boolean;
    };
  }> = [];
  closeCalls = 0;
  reloadCalls = 0;
  goBackCalls = 0;
  goForwardCalls = 0;
  clearNavigationHistoryCalls = 0;
  stopFindCalls = 0;
  readonly backgroundThrottlingStates: boolean[] = [];
  canGoBackValue = false;
  canGoForwardValue = false;
  throwDeprecatedNavigation = false;
  destroyed = false;
  zoomFactor = 1;
  title = "";
  emptyCapture = false;
  deferCaptures = false;
  private readonly captureResolvers: Array<
    (image: BrowserViewCapturedImage) => void
  > = [];
  devToolsWebContentsId: number | null = null;
  openDevToolsCalls: unknown[] = [];
  windowOpenHandler:
    | ((details: {
        readonly url: string;
        readonly frameName: string;
        readonly features: string;
        readonly disposition: string;
      }) =>
        | { readonly action: "deny" }
        | {
            readonly action: "allow";
            readonly overrideBrowserWindowOptions: unknown;
            readonly outlivesOpener: boolean;
          })
    | null = null;
  private url = "about:blank";
  readonly frameSubscriptions: Array<
    (image: BrowserViewCapturedImage) => void
  > = [];
  frameSubscriptionEnds = 0;

  constructor(
    readonly id: number,
    private readonly readVisible: () => boolean,
    requireLoadedTargetForPageCommands: boolean,
  ) {
    super();
    this.debugger = new FakeDebugger(
      this.lifecycle,
      requireLoadedTargetForPageCommands,
    );
  }

  beginFrameSubscription(
    callback: (image: BrowserViewCapturedImage) => void,
  ): void {
    this.frameSubscriptions.push(callback);
  }

  endFrameSubscription(): void {
    this.frameSubscriptionEnds += 1;
  }

  emitCompositorFrame(image: BrowserViewCapturedImage | undefined): void {
    const frame = image ?? this.buildCaptureImage();
    this.frameSubscriptions.forEach((callback) => {
      callback(frame);
    });
  }

  loadURL(url: string): Promise<unknown> {
    this.lifecycle.push("loadURL");
    this.url = url;
    this.loadUrls.push(url);
    if (url === "http://127.0.0.1:65535/") {
      return Promise.reject(new Error("ERR_CONNECTION_REFUSED"));
    }
    return Promise.resolve(null);
  }

  executeJavaScript(script: string): Promise<unknown> {
    this.executedJavaScript.push(script);
    return Promise.resolve([]);
  }

  resolveNextCapture(): void {
    const resolve = this.captureResolvers.shift();
    if (resolve === undefined) throw new Error("No capture is pending");
    resolve(this.buildCaptureImage());
  }

  capturePage(): Promise<BrowserViewCapturedImage> {
    this.lifecycle.push("capturePage");
    this.captureVisibleStates.push(this.readVisible());
    if (this.deferCaptures) {
      return new Promise((resolve) => {
        this.captureResolvers.push(resolve);
      });
    }
    if (this.emptyCapture) {
      const emptyBytes = new Uint8Array();
      const empty: BrowserViewCapturedImage = {
        getSize: () => ({ width: 0, height: 0 }),
        toJPEG: () => emptyBytes,
        toDataURL: () => "",
        isEmpty: () => true,
        crop: () => empty,
        toPNG: () => emptyBytes,
      };
      return Promise.resolve(empty);
    }
    return Promise.resolve(this.buildCaptureImage());
  }

  private buildCaptureImage(): BrowserViewCapturedImage {
    // Real toJPEG results are Buffers; the frame-cache encoder relies on
    // Buffer#toString("base64"), so the fixture must be one too.
    const bytes: Buffer = Buffer.from([1, 2, 3]);
    const image: BrowserViewCapturedImage = {
      getSize: () => ({ width: 320, height: 180 }),
      toJPEG: () => bytes,
      toDataURL: () => `data:image/png;base64,${this.id}`,
      isEmpty: () => false,
      crop: () => image,
      toPNG: () => bytes,
    };
    return image;
  }

  getURL(): string {
    return this.url;
  }

  getTitle(): string {
    return this.title;
  }

  canGoBack(): boolean {
    if (this.destroyed || this.throwDeprecatedNavigation) {
      throw new Error("deprecated canGoBack should not be used");
    }
    return this.canGoBackValue;
  }

  canGoForward(): boolean {
    if (this.destroyed || this.throwDeprecatedNavigation) {
      throw new Error("deprecated canGoForward should not be used");
    }
    return this.canGoForwardValue;
  }

  goBack(): void {
    this.goBackCalls += 1;
  }

  goForward(): void {
    this.goForwardCalls += 1;
  }

  close(): void {
    this.closeCalls += 1;
    this.destroyed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  reload(): void {
    this.reloadCalls += 1;
  }

  findInPage(
    text: string,
    options: {
      readonly forward: boolean;
      readonly findNext: boolean;
      readonly matchCase: boolean;
    },
  ): number {
    const requestId = this.findInPageCalls.length + 1;
    this.findInPageCalls.push({ requestId, text, options });
    return requestId;
  }

  stopFindInPage(_action: "clearSelection"): void {
    this.stopFindCalls += 1;
  }

  getZoomFactor(): number {
    return this.zoomFactor;
  }

  setZoomFactor(factor: number): void {
    this.zoomFactor = factor;
  }

  setBackgroundThrottling(allowed: boolean): void {
    this.backgroundThrottlingStates.push(allowed);
  }

  setDevToolsWebContents(webContents: { readonly id: number }): void {
    this.devToolsWebContentsId = webContents.id;
  }

  openDevTools(options: unknown): void {
    this.openDevToolsCalls.push(options);
  }

  setWindowOpenHandler(
    handler: (details: {
      readonly url: string;
      readonly frameName: string;
      readonly features: string;
      readonly disposition: string;
    }) =>
      | { readonly action: "deny" }
      | {
          readonly action: "allow";
          readonly overrideBrowserWindowOptions: unknown;
          readonly outlivesOpener: boolean;
        },
  ): void {
    this.windowOpenHandler = handler;
  }
}

class FakeBrowserView implements ManagedBrowserView {
  readonly webContents: FakeWebContents;
  readonly bounds: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [];
  readonly visibleStates: boolean[] = [];

  constructor(
    webContentsId: number,
    requireLoadedTargetForPageCommands: boolean,
  ) {
    this.webContents = new FakeWebContents(
      webContentsId,
      () => this.visible,
      requireLoadedTargetForPageCommands,
    );
  }

  setBounds(bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }): void {
    this.bounds.push(bounds);
  }

  setVisible(visible: boolean): void {
    this.visibleStates.push(visible);
  }

  get visible(): boolean {
    return this.visibleStates[this.visibleStates.length - 1] ?? false;
  }
}

class FakeContentView implements ManagedContentView {
  readonly children: ManagedBrowserView[] = [];

  addChildView(view: ManagedBrowserView): void {
    if (!this.children.includes(view)) {
      this.children.push(view);
    }
  }

  removeChildView(view: ManagedBrowserView): void {
    const index = this.children.indexOf(view);
    if (index !== -1) this.children.splice(index, 1);
  }
}

class FakeHostWebContents extends EventEmitter {
  readonly sentInputEvents: Array<{
    readonly type: "keyDown";
    readonly keyCode: string;
    readonly modifiers: readonly string[];
  }> = [];

  sendInputEvent(event: {
    readonly type: "keyDown";
    readonly keyCode: string;
    readonly modifiers?: readonly string[];
  }): void {
    this.sentInputEvents.push({
      type: event.type,
      keyCode: event.keyCode,
      modifiers: event.modifiers ?? [],
    });
  }
}

class FakeWindow implements BrowserViewWindow {
  readonly contentView = new FakeContentView();
  readonly webContents = new FakeHostWebContents();
  destroyed = false;
  visible = true;
  minimized = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isVisible(): boolean {
    return this.visible;
  }

  isMinimized(): boolean {
    return this.minimized;
  }
}

class FakePopupWebContents extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }

  once(event: "destroyed", listener: () => void): this {
    return super.once(event, listener);
  }
}

class FakePopupWindow extends EventEmitter {
  readonly webContents: FakePopupWebContents;
  destroyed = false;
  closeCalls = 0;

  constructor(webContentsId: number) {
    super();
    this.webContents = new FakePopupWebContents(webContentsId);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  close(): void {
    this.closeCalls += 1;
    this.destroyed = true;
  }
}

class FakeDevToolsWindow {
  readonly webContents: { readonly id: number };
  destroyed = false;

  constructor(webContentsId: number) {
    this.webContents = { id: webContentsId };
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

interface Harness {
  readonly manager: BrowserViewManager;
  readonly windows: Map<string, FakeWindow>;
  readonly views: FakeBrowserView[];
  readonly statuses: BrowserViewStatusChange[];
  readonly statusWindowIds: string[];
  readonly nativeTabStatuses: BrowserViewNativeTabStatusChange[];
  readonly nativeTabStatusWindowIds: string[];
  readonly finds: BrowserViewFindChange[];
  readonly downloads: BrowserViewDownloadChange[];
  readonly certificateErrors: BrowserViewCertificateErrorChange[];
  readonly openTileRequests: BrowserViewOpenTileRequest[];
  readonly debugSnapshots: BrowserViewDebugSnapshotChange[];
  readonly electronTabHandoffNotifications: BrowserViewElectronTabHandoffChange[];
  readonly electronTabHandoffWindowIds: string[];
  readonly snapshotInvalidations: BrowserViewSnapshotInvalidatedChange[];
  readonly annotationEvents: BrowserAnnotationSessionIpcEvent[];
  readonly annotationAttached: BrowserAnnotationAttachedIpcEvent[];
  readonly rendererResetWindowIds: string[];
  readonly storageStateApplications: BrowserViewStorageStateApply[];
  readonly storageStateCaptures: Array<{ readonly origin: string }>;
  readonly primaryProfileCaptureSourceOrigins: string[][];
  readonly registeredPopupWebContents: BrowserViewPopupWebContents[];
  emitDownload(change: BrowserSessionDownloadChange): void;
  emitCertificateError(change: BrowserSessionCertificateErrorChange): void;
  emitWindowChange(): void;
}

type HarnessOptions = {
  readonly captureStorageState?: BrowserViewManagerOptions["captureStorageState"];
  readonly notifyElectronTabHandoff?: BrowserViewManagerOptions["notifyElectronTabHandoff"];
  readonly boundsStreamLogIntervalMs?: number;
  readonly hostPlatform?: "darwin" | "other";
  readonly requireLoadedTargetForPageCommands?: boolean;
};

const DEFAULT_CAPTURE_STORAGE_STATE: BrowserViewManagerOptions["captureStorageState"] =
  (_input, _webContents): Promise<BrowserViewStorageStateCaptureResult> =>
    Promise.resolve({
      storageState: { cookies: [], origins: [] },
      cookieCount: 0,
      cookieDomains: [],
      localStorageCount: 0,
      localStorageAvailable: true,
      localStorageReason: null,
    });

function createHarness(): Harness {
  return createHarnessWithOptions(undefined);
}

function createHarnessWithOptions(
  harnessOptions: HarnessOptions | undefined,
): Harness {
  const windows = new Map<string, FakeWindow>([
    ["window-1", new FakeWindow()],
    ["window-2", new FakeWindow()],
  ]);
  const views: FakeBrowserView[] = [];
  const statuses: BrowserViewStatusChange[] = [];
  const statusWindowIds: string[] = [];
  const nativeTabStatuses: BrowserViewNativeTabStatusChange[] = [];
  const nativeTabStatusWindowIds: string[] = [];
  const finds: BrowserViewFindChange[] = [];
  const downloads: BrowserViewDownloadChange[] = [];
  const certificateErrors: BrowserViewCertificateErrorChange[] = [];
  const openTileRequests: BrowserViewOpenTileRequest[] = [];
  const debugSnapshots: BrowserViewDebugSnapshotChange[] = [];
  const electronTabHandoffNotifications: BrowserViewElectronTabHandoffChange[] =
    [];
  const electronTabHandoffWindowIds: string[] = [];
  const snapshotInvalidations: BrowserViewSnapshotInvalidatedChange[] = [];
  const annotationEvents: BrowserAnnotationSessionIpcEvent[] = [];
  const annotationAttached: BrowserAnnotationAttachedIpcEvent[] = [];
  const rendererResetWindowIds: string[] = [];
  const storageStateApplications: BrowserViewStorageStateApply[] = [];
  const storageStateCaptures: Array<{ readonly origin: string }> = [];
  const primaryProfileCaptureSourceOrigins: string[][] = [];
  const registeredPopupWebContents: BrowserViewPopupWebContents[] = [];
  const windowListeners = new Set<() => void>();
  const downloadListeners = new Set<
    (change: BrowserSessionDownloadChange) => void
  >();
  const certificateListeners = new Set<
    (change: BrowserSessionCertificateErrorChange) => void
  >();
  let nextWebContentsId = 1;
  const options: BrowserViewManagerOptions = {
    createView: () => {
      const view = new FakeBrowserView(
        nextWebContentsId,
        harnessOptions?.requireLoadedTargetForPageCommands ?? false,
      );
      nextWebContentsId += 1;
      views.push(view);
      return view;
    },
    getWindow: (windowId) => windows.get(windowId) ?? null,
    onWindowChange: (listener) => {
      windowListeners.add(listener);
      return () => {
        windowListeners.delete(listener);
      };
    },
    notifyHostWindowRendererReset: (windowId) => {
      rendererResetWindowIds.push(windowId);
    },
    createPopupWindowOptions: () => ({ width: 900 }),
    createDevToolsWindow: () => {
      const window = new FakeDevToolsWindow(nextWebContentsId);
      nextWebContentsId += 1;
      return window;
    },
    registerPopupWebContents: (webContents) => {
      registeredPopupWebContents.push(webContents);
    },
    onDownloadChange: (listener) => {
      downloadListeners.add(listener);
      return () => {
        downloadListeners.delete(listener);
      };
    },
    onCertificateError: (listener) => {
      certificateListeners.add(listener);
      return () => {
        certificateListeners.delete(listener);
      };
    },
    notifyStatus: (windowId, change) => {
      statusWindowIds.push(windowId);
      statuses.push(change);
    },
    notifyNativeTabStatus: (windowId, change) => {
      nativeTabStatusWindowIds.push(windowId);
      nativeTabStatuses.push(change);
    },
    notifyFind: (_windowId, change) => {
      finds.push(change);
    },
    notifyDownload: (_windowId, change) => {
      downloads.push(change);
    },
    notifyCertificateError: (_windowId, change) => {
      certificateErrors.push(change);
    },
    notifyOpenTileRequest: (_windowId, change) => {
      openTileRequests.push(change);
    },
    notifySnapshotInvalidated: (_windowId, change) => {
      snapshotInvalidations.push(change);
    },
    notifyDebugSnapshot: (_windowId, change) => {
      debugSnapshots.push(change);
    },
    notifyElectronTabHandoff: (windowId, change) => {
      const delivered =
        harnessOptions?.notifyElectronTabHandoff?.(windowId, change) ?? true;
      if (!delivered) return false;
      electronTabHandoffWindowIds.push(windowId);
      electronTabHandoffNotifications.push(change);
      return true;
    },
    notifyAnnotationEvent: (_windowId, change) => {
      annotationEvents.push(change);
    },
    notifyAnnotationAttached: (_windowId, change) => {
      annotationAttached.push(change);
    },
    scheduleDebugSnapshot: (callback) => {
      const timer = setTimeout(callback, 16);
      return {
        cancel: () => {
          clearTimeout(timer);
        },
      };
    },
    applyStorageState: (input) => {
      storageStateApplications.push(input);
      return Promise.resolve({
        status: "applied",
        cookieCount: 1,
        localStorageApplied: false,
        reason: "cookies-only",
      } satisfies BrowserViewStorageStateApplyResult);
    },
    captureStorageState: (input, webContents) => {
      storageStateCaptures.push(input);
      return (
        harnessOptions?.captureStorageState ?? DEFAULT_CAPTURE_STORAGE_STATE
      )(input, webContents);
    },
    capturePrimaryProfile: (origins) => {
      primaryProfileCaptureSourceOrigins.push(
        origins.map((origin) => origin.origin),
      );
      return Promise.resolve({
        status: "captured",
        storageState: {
          cookies: [],
          origins: origins.map((origin) => ({
            origin: origin.origin,
            localStorage: [...origin.localStorage],
          })),
        },
        reason: null,
      });
    },
    capturePrimaryProfileLocalStorage: (origin, _webContents) =>
      Promise.resolve({
        origin,
        localStorage: [{ name: "k", value: origin }],
      }),
    boundsStreamLogIntervalMs:
      harnessOptions?.boundsStreamLogIntervalMs ?? 1000,
    hostPlatform: harnessOptions?.hostPlatform ?? "darwin",
  };
  return {
    manager: new BrowserViewManager(options),
    windows,
    views,
    statuses,
    statusWindowIds,
    nativeTabStatuses,
    nativeTabStatusWindowIds,
    finds,
    downloads,
    certificateErrors,
    openTileRequests,
    debugSnapshots,
    electronTabHandoffNotifications,
    electronTabHandoffWindowIds,
    snapshotInvalidations,
    annotationEvents,
    annotationAttached,
    rendererResetWindowIds,
    storageStateApplications,
    storageStateCaptures,
    primaryProfileCaptureSourceOrigins,
    registeredPopupWebContents,
    emitDownload: (change) => {
      for (const listener of downloadListeners) listener(change);
    },
    emitCertificateError: (change) => {
      for (const listener of certificateListeners) listener(change);
    },
    emitWindowChange: () => {
      for (const listener of windowListeners) listener();
    },
  };
}

/** Flush the async closeEntry → electron-tab handoff → capture chain. */
async function flushCloseEntry(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("BrowserViewManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies handoff storage state through the configured browser store", async () => {
    const harness = createHarness();
    const storageState = {
      cookies: [],
      origins: [],
    };

    await expect(
      harness.manager.applyStorageState({
        storageState,
        sessionId: "session-manager-test",
        tabId: "tab-manager-test",
        purpose: "sync-back",
      }),
    ).resolves.toEqual({
      status: "applied",
      cookieCount: 1,
      localStorageApplied: false,
      reason: "cookies-only",
    });
    expect(harness.storageStateApplications).toEqual([
      {
        storageState,
        sessionId: "session-manager-test",
        tabId: "tab-manager-test",
        purpose: "sync-back",
      },
    ]);
  });

  it("releaseTile unbinds the view without destroying WebContents (ticket 05)", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 1, y: 2, width: 300, height: 200 },
    });
    const view = harness.views[0];

    expect(view.visible).toBe(true);
    expect(view.webContents.closeCalls).toBe(0);

    harness.manager.releaseTile("window-1", BASE_KEY);
    expect(view.visible).toBe(false);
    expect(view.webContents.closeCalls).toBe(0);
    expect(harness.windows.get("window-1")?.contentView.children).toEqual([]);
    // No grace-period destruction: tile close is unbind only.
    vi.advanceTimersByTime(60_000);
    expect(view.webContents.closeCalls).toBe(0);
    expect(harness.electronTabHandoffNotifications).toEqual([]);
  });

  it("rebinds the same WebContents when a released tile is reopened (ticket 05)", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 1, y: 2, width: 300, height: 200 },
    });
    const view = harness.views[0];
    expect(view.visible).toBe(true);

    harness.manager.releaseTile("window-1", BASE_KEY);
    expect(view.visible).toBe(false);

    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );

    expect(view.webContents.closeCalls).toBe(0);
    expect(view.visible).toBe(true);
    expect(harness.views).toHaveLength(1);
    expect(harness.windows.get("window-1")?.contentView.children).toContain(
      view,
    );
  });

  it("applies fixed viewport presets within the tile bounds", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 1200, height: 900 },
    });
    const view = harness.views[0];

    harness.manager.setViewportPreset("window-1", {
      ...BASE_KEY,
      viewportPreset: "mobile",
    });

    expect(view.bounds.at(-1)).toEqual({
      x: 405,
      y: 28,
      width: 390,
      height: 844,
    });
  });

  it("coalesces identical streamed bounds updates to a single setBounds (BT-101)", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];
    const rect = { x: 10, y: 20, width: 300, height: 200 };

    harness.manager.updateBounds("window-1", { ...BASE_KEY, bounds: rect });
    const appliedAfterFirst = view.bounds.length;
    for (let i = 0; i < 5; i += 1) {
      // Streamed echoes of the same rect (sub-pixel jitter rounded away)
      // must not relayout the guest.
      harness.manager.updateBounds("window-1", {
        ...BASE_KEY,
        bounds: rect,
      });
    }

    expect(appliedAfterFirst).toBe(1);
    expect(view.bounds).toHaveLength(1);
    expect(view.bounds[0]).toEqual(rect);
  });

  it("applies each distinct rect in a streamed drag burst and lands on the last (BT-101)", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];

    const rects = [
      { x: 0, y: 0, width: 400, height: 300 },
      { x: 0, y: 0, width: 420, height: 310 },
      { x: 2, y: 4, width: 460, height: 340 },
    ];
    rects.forEach((bounds) => {
      harness.manager.updateBounds("window-1", { ...BASE_KEY, bounds });
    });

    expect(
      view.bounds.map((bounds) => ({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      })),
    ).toEqual(rects);
  });

  it("reapplies identical raw bounds when the viewport preset changes effective geometry (BT-101)", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];
    const containerRect = { x: 0, y: 0, width: 1200, height: 900 };
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: containerRect,
    });
    const appliedBeforePresetChange = view.bounds.length;

    harness.manager.setViewportPreset("window-1", {
      ...BASE_KEY,
      viewportPreset: "mobile",
    });

    expect(view.bounds.length).toBe(appliedBeforePresetChange + 1);
    expect(view.bounds.at(-1)).toMatchObject({ width: 390, height: 844 });
  });

  it("flushes one aggregate bounds_stream log per interval window (BT-101)", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => undefined);
    try {
      const harness = createHarnessWithOptions({
        boundsStreamLogIntervalMs: 10,
      });
      harness.manager.upsertTile(
        "window-1",
        upsert(BASE_KEY, "http://localhost:3000", true),
      );
      infoSpy.mockClear();

      harness.manager.updateBounds("window-1", {
        ...BASE_KEY,
        bounds: { x: 0, y: 0, width: 400, height: 300 },
      });
      // Identical echo coalesces; zero-area update is rejected.
      harness.manager.updateBounds("window-1", {
        ...BASE_KEY,
        bounds: { x: 0, y: 0, width: 400, height: 300 },
      });
      harness.manager.updateBounds("window-1", {
        ...BASE_KEY,
        bounds: { x: 5, y: 5, width: 0, height: 0 },
      });
      vi.advanceTimersByTime(10);

      const streamLogs = infoSpy.mock.calls.filter(
        (call) => call[0] === "[browser-view] bounds stream",
      );
      expect(streamLogs).toHaveLength(1);
      expect(streamLogs[0]?.[1]).toMatchObject({
        kind: "bounds_stream",
        windowMs: 10,
        received: 3,
        applied: 1,
        coalesced: 1,
        rejected: 1,
        maxDeltaPx: null,
      });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("opens manual DevTools with a dedicated WebContents", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];

    harness.manager.openDevTools("window-1", BASE_KEY);

    expect(view.webContents.devToolsWebContentsId).toBe(2);
    expect(view.webContents.openDevToolsCalls).toEqual([
      {
        mode: "detach",
        activate: true,
        title: "Traycer Browser DevTools",
      },
    ]);
  });

  it("does not share webContents when a browser tile is duplicated", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.upsertTile(
      "window-1",
      upsert(
        {
          ...BASE_KEY,
          tileInstanceId: "tile-2",
          pageSessionId: "page-2",
        },
        "http://localhost:3000",
        true,
      ),
    );

    expect(harness.views).toHaveLength(2);
    expect(harness.views[0].webContents.id).not.toBe(
      harness.views[1].webContents.id,
    );
  });

  it("keeps background tabs hidden and non-interactive", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", false),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];
    expect(view.visible).toBe(false);

    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    expect(view.visible).toBe(true);

    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", false),
    );
    expect(view.visible).toBe(false);
  });

  it("reparents the same view across panes and windows without reloading", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];
    const nextKey = {
      ...BASE_KEY,
      viewTabId: "view-tab-2",
      paneId: "pane-2",
    };

    harness.manager.upsertTile(
      "window-2",
      upsert(nextKey, "http://localhost:3000", true),
    );

    expect(harness.views).toHaveLength(1);
    expect(view.webContents.loadUrls).toEqual(["http://localhost:3000"]);
    expect(harness.windows.get("window-1")?.contentView.children).toEqual([]);
    expect(harness.windows.get("window-2")?.contentView.children).toEqual([
      view,
    ]);
  });

  it("gates native visibility on the owning window visibility", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];
    expect(view.visible).toBe(true);

    const window = harness.windows.get("window-1");
    expect(window).toBeDefined();
    if (window === undefined) return;
    window.visible = false;
    harness.emitWindowChange();
    expect(view.visible).toBe(false);

    window.visible = true;
    window.minimized = true;
    harness.emitWindowChange();
    expect(view.visible).toBe(false);

    window.minimized = false;
    harness.emitWindowChange();
    expect(view.visible).toBe(true);
  });

  it("enables debugger domains only after the first committed navigation", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];
    expect(view.webContents.debugger.commands).toEqual([]);

    view.webContents.emit(
      "did-frame-navigate",
      {},
      "http://localhost:3000",
      200,
      "OK",
      true,
    );
    await Promise.resolve();

    expect(view.webContents.debugger.attached).toBe(true);
    expect(view.webContents.debugger.commands).toEqual([
      { method: "Page.enable", params: {}, sessionId: undefined },
      { method: "Runtime.enable", params: {}, sessionId: undefined },
      { method: "Log.enable", params: {}, sessionId: undefined },
      { method: "Network.enable", params: {}, sessionId: undefined },
      { method: "DOM.enable", params: {}, sessionId: undefined },
    ]);
  });

  it("projects console and network debug rows and clears them on request", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];
    view.webContents.emit(
      "did-frame-navigate",
      {},
      "http://localhost:3000",
      200,
      "OK",
      true,
    );
    await Promise.resolve();

    view.webContents.debugger.emitMessage(
      "Runtime.consoleAPICalled",
      {
        type: "error",
        timestamp: 1234,
        args: [{ type: "string", value: "boom" }],
        stackTrace: {
          callFrames: [
            {
              functionName: "fail",
              url: "http://localhost:3000/app.js",
              lineNumber: 7,
              columnNumber: 12,
            },
          ],
        },
      },
      undefined,
    );
    view.webContents.debugger.emitMessage(
      "Network.requestWillBeSent",
      {
        requestId: "request-1",
        type: "Fetch",
        wallTime: 1_750_000_000,
        timestamp: 100_000,
        request: {
          url: "http://localhost:3000/api",
          method: "GET",
        },
      },
      undefined,
    );
    view.webContents.debugger.emitMessage(
      "Network.loadingFailed",
      {
        requestId: "request-1",
        timestamp: 100_001.234,
        errorText: "net::ERR_FAILED",
      },
      undefined,
    );

    const snapshot = harness.manager.getDebugSnapshot("window-1", BASE_KEY);
    expect(snapshot.consoleEntries).toMatchObject([
      {
        level: "error",
        text: "boom",
        url: "http://localhost:3000/app.js",
        lineNumber: 7,
      },
    ]);
    expect(snapshot.networkEntries).toMatchObject([
      {
        id: "root:request-1",
        url: "http://localhost:3000/api",
        method: "GET",
        status: "failed",
        startedAt: 1_750_000_000_000,
        completedAt: 1_750_000_001_234,
        durationMs: 1234,
        failureText: "net::ERR_FAILED",
      },
    ]);
    vi.advanceTimersByTime(16);
    expect(harness.debugSnapshots.at(-1)?.networkEntries).toHaveLength(1);

    harness.manager.clearDebugEvents("window-1", BASE_KEY);
    expect(
      harness.manager.getDebugSnapshot("window-1", BASE_KEY),
    ).toMatchObject({
      consoleEntries: [],
      networkEntries: [],
    });
  });

  it("coalesces bursty debug snapshots before crossing IPC", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];
    view.webContents.emit(
      "did-frame-navigate",
      {},
      "http://localhost:3000",
      200,
      "OK",
      true,
    );
    await Promise.resolve();

    Array.from({ length: 25 }, (_value, index) => index).forEach((index) => {
      view.webContents.debugger.emitMessage(
        "Runtime.consoleAPICalled",
        {
          type: "log",
          timestamp: index,
          args: [{ type: "string", value: `row-${index}` }],
        },
        undefined,
      );
    });

    expect(harness.debugSnapshots).toHaveLength(0);
    vi.advanceTimersByTime(15);
    expect(harness.debugSnapshots).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(harness.debugSnapshots).toHaveLength(1);
    expect(harness.debugSnapshots[0]?.consoleEntries).toHaveLength(25);
  });

  it("truncates oversized console text and URLs before snapshotting", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];
    view.webContents.emit(
      "did-frame-navigate",
      {},
      "http://localhost:3000",
      200,
      "OK",
      true,
    );
    await Promise.resolve();

    const longText = "x".repeat(5000);
    const longUrl = `http://localhost:3000/${"u".repeat(3000)}`;
    view.webContents.debugger.emitMessage(
      "Runtime.consoleAPICalled",
      {
        type: "error",
        timestamp: 1234,
        args: [{ type: "string", value: longText }],
        stackTrace: {
          callFrames: [
            {
              functionName: "fail",
              url: longUrl,
              lineNumber: 7,
              columnNumber: 12,
            },
          ],
        },
      },
      undefined,
    );
    view.webContents.debugger.emitMessage(
      "Network.requestWillBeSent",
      {
        requestId: "request-long",
        timestamp: 100_000,
        wallTime: 1_750_000_000,
        request: {
          url: longUrl,
          method: "GET",
        },
      },
      undefined,
    );

    const snapshot = harness.manager.getDebugSnapshot("window-1", BASE_KEY);
    expect(snapshot.consoleEntries[0]?.text).toHaveLength(4096);
    expect(snapshot.consoleEntries[0]?.text.endsWith("...")).toBe(true);
    expect(snapshot.consoleEntries[0]?.url).toHaveLength(2048);
    expect(snapshot.consoleEntries[0]?.url?.endsWith("...")).toBe(true);
    expect(snapshot.networkEntries[0]?.url).toHaveLength(2048);
    expect(snapshot.networkEntries[0]?.url.endsWith("...")).toBe(true);
  });

  it("captures a content-addressed page screenshot", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    harness.views[0].webContents.emit(
      "did-frame-navigate",
      {},
      "http://localhost:3000",
      200,
      "OK",
      true,
    );

    const result = await harness.manager.capturePage("window-1", BASE_KEY);

    expect(result).toMatchObject({
      ...BASE_KEY,
      mediaType: "image/png",
      base64: "1",
    });
    expect(result.byteLength).toBeGreaterThanOrEqual(0);
    expect(result.sha256).toHaveLength(64);
    expect(result.capturedAt).toBeGreaterThan(0);
  });

  it("rejects screenshot capture while loading or occluded", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });

    await expect(
      harness.manager.capturePage("window-1", BASE_KEY),
    ).rejects.toThrow("tile is still loading");

    const view = harness.views[0];
    view.webContents.emit(
      "did-frame-navigate",
      {},
      "http://localhost:3000",
      200,
      "OK",
      true,
    );
    await harness.manager.occludeForOverlay("window-1", {
      overlayId: "command-palette",
      tiles: [BASE_KEY],
    });

    await expect(
      harness.manager.capturePage("window-1", BASE_KEY),
    ).rejects.toThrow("tile is occluded");
  });

  it("keeps the debugger attached after releaseTile so the durable tab stays drivable (ticket 05)", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];
    view.webContents.emit(
      "did-frame-navigate",
      {},
      "http://localhost:3000",
      200,
      "OK",
      true,
    );
    await Promise.resolve();
    expect(view.webContents.debugger.attached).toBe(true);

    harness.manager.releaseTile("window-1", BASE_KEY);
    vi.advanceTimersByTime(60_000);

    expect(view.webContents.debugger.attached).toBe(true);
    expect(view.webContents.debugger.detached).toBe(false);
    expect(view.webContents.closeCalls).toBe(0);
  });

  it("rebind after release keeps the same debug session without requiring navigation (ticket 05)", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];
    view.webContents.emit(
      "did-frame-navigate",
      {},
      "http://localhost:3000",
      200,
      "OK",
      true,
    );
    await Promise.resolve();
    expect(view.webContents.debugger.attached).toBe(true);

    harness.manager.releaseTile("window-1", BASE_KEY);
    expect(view.webContents.debugger.attached).toBe(true);

    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    await Promise.resolve();

    expect(view.webContents.debugger.attached).toBe(true);
    expect(view.webContents.closeCalls).toBe(0);
    expect(harness.views).toHaveLength(1);
  });

  it("ignores subframe in-page navigations when projecting tile URL", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];
    view.webContents.emit(
      "did-frame-navigate",
      {},
      "http://localhost:3000",
      200,
      "OK",
      true,
    );
    const statusCount = harness.statuses.length;

    view.webContents.emit(
      "did-navigate-in-page",
      {},
      "http://iframe.example/#step",
      false,
      1,
      2,
    );

    expect(harness.statuses).toHaveLength(statusCount);

    view.webContents.emit(
      "did-navigate-in-page",
      {},
      "http://localhost:3000/#top",
      true,
      1,
      2,
    );

    expect(harness.statuses.at(-1)).toMatchObject({
      url: "http://localhost:3000/#top",
    });
  });

  it("captures a snapshot before hiding a browser view for an overlay", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];
    expect(view.visible).toBe(true);

    const result = await harness.manager.occludeForOverlay("window-1", {
      overlayId: "command-palette",
      tiles: [BASE_KEY],
    });

    expect(view.webContents.captureVisibleStates).toEqual([true]);
    // Two-phase park: pre-ack the view is untouched at real geometry; the
    // ack then applies the offscreen posture.
    expect(view.visible).toBe(true);
    expect(view.bounds.at(-1)).toMatchObject({
      x: 0,
      y: 0,
      width: 500,
      height: 300,
    });
    harness.manager.paintAckOverlay("command-palette");
    expect(view.visible).toBe(true);
    expect(view.bounds.at(-1)).toMatchObject({
      x: -500,
      y: -300,
      width: 500,
      height: 300,
    });
    expect(result.restoredTiles).toEqual([]);
    expect(result.snapshots).toEqual([
      {
        ...BASE_KEY,
        dataUrl: "data:image/png;base64,1",
        stale: false,
      },
    ]);
  });

  it("keeps nested overlay ownership ref-counted until the last owner closes", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];

    await harness.manager.occludeForOverlay("window-1", {
      overlayId: "dialog",
      tiles: [BASE_KEY],
    });
    await harness.manager.occludeForOverlay("window-1", {
      overlayId: "dropdown",
      tiles: [BASE_KEY],
    });
    harness.manager.paintAckOverlay("dialog");

    expect(view.webContents.captureVisibleStates).toEqual([true]);
    expect(view.visible).toBe(true);

    expect(
      harness.manager.releaseOverlay("window-1", {
        overlayId: "dropdown",
      }),
    ).toEqual({ restoredTiles: [] });
    expect(view.visible).toBe(true);

    expect(
      harness.manager.releaseOverlay("window-1", {
        overlayId: "dialog",
      }),
    ).toEqual({ restoredTiles: [BASE_KEY] });
    expect(view.visible).toBe(true);
  });

  it("keeps overlay ownership releasable when a view is rekeyed", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];

    await harness.manager.occludeForOverlay("window-1", {
      overlayId: "dialog",
      tiles: [BASE_KEY],
    });
    const rekeyed = { ...BASE_KEY, tileInstanceId: "tile-2" };
    harness.manager.upsertTile(
      "window-1",
      upsert(rekeyed, "http://localhost:3000", true),
    );

    expect(
      harness.manager.releaseOverlay("window-1", {
        overlayId: "dialog",
      }),
    ).toEqual({ restoredTiles: [rekeyed] });
    expect(view.visible).toBe(true);
  });

  it("does not duplicate overlay ownership when a rekeyed view is occluded again", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    await harness.manager.occludeForOverlay("window-1", {
      overlayId: "dialog",
      tiles: [BASE_KEY],
    });
    const rekeyed = { ...BASE_KEY, tileInstanceId: "tile-2" };
    harness.manager.upsertTile(
      "window-1",
      upsert(rekeyed, "http://localhost:3000", true),
    );

    await harness.manager.occludeForOverlay("window-1", {
      overlayId: "dialog",
      tiles: [rekeyed],
    });

    expect(
      harness.manager.releaseOverlay("window-1", {
        overlayId: "dialog",
      }),
    ).toEqual({ restoredTiles: [rekeyed] });
  });

  it("serves occlusion from the live frame cache without capturePage (BT-202)", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];
    // Visibility pass attached the feed; a compositor frame warms the slot.
    expect(view.webContents.frameSubscriptions).toHaveLength(1);
    view.webContents.emitCompositorFrame(undefined);

    const result = await harness.manager.occludeForOverlay("window-1", {
      overlayId: "palette",
      tiles: [BASE_KEY],
    });

    expect(view.webContents.lifecycle).not.toContain("capturePage");
    // The cache stores the ENCODED frame (JPEG), not the capturePage PNG.
    expect(result.snapshots).toEqual([
      {
        ...BASE_KEY,
        dataUrl: `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
        stale: false,
      },
    ]);
    // Two-phase park (flicker fix): the view stays at REAL geometry until
    // the renderer acknowledges the painted replacement frame.
    expect(view.visible).toBe(true);
    expect(view.bounds.at(-1)).toMatchObject({
      x: 0,
      y: 0,
      width: 500,
      height: 300,
    });

    harness.manager.paintAckOverlay("palette");

    expect(view.bounds.at(-1)).toMatchObject({ x: -500, y: -300 });
    expect(view.visible).toBe(true);
  });

  it("marks cached snapshots stale once the freshness window lapses (BT-202)", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];
    view.webContents.emitCompositorFrame(undefined);
    vi.advanceTimersByTime(400);

    const result = await harness.manager.occludeForOverlay("window-1", {
      overlayId: "palette",
      tiles: [BASE_KEY],
    });

    expect(view.webContents.lifecycle).not.toContain("capturePage");
    expect(result.snapshots[0]).toMatchObject({
      dataUrl: `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
      stale: true,
    });
  });

  it("parked tiles do not flip their snapshot stale on paint churn (BT-202 ⌘K white-out)", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];
    view.webContents.emitCompositorFrame(undefined);
    const result = await harness.manager.occludeForOverlay("window-1", {
      overlayId: "palette",
      tiles: [BASE_KEY],
    });
    harness.manager.paintAckOverlay("palette");
    expect(result.snapshots[0]).toMatchObject({ stale: false });
    expect(harness.snapshotInvalidations).toEqual([]);

    // The parked view keeps compositing (by design); each frame used to
    // emit an invalidation that made the renderer drop the frozen <img>
    // and paint bare background — the reported white-out.
    view.webContents.emit("paint");
    view.webContents.emit("paint");

    expect(harness.snapshotInvalidations).toEqual([]);

    // Content-level changes still invalidate.
    harness.manager.reloadTile("window-1", BASE_KEY);
    expect(harness.snapshotInvalidations.length).toBeGreaterThanOrEqual(1);
    expect(harness.snapshotInvalidations.at(-1)).toMatchObject({
      reason: "reload",
    });
  });

  it("release restores the parked view to its real geometry (BT-202)", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];
    view.webContents.emitCompositorFrame(undefined);
    await harness.manager.occludeForOverlay("window-1", {
      overlayId: "palette",
      tiles: [BASE_KEY],
    });
    harness.manager.paintAckOverlay("palette");
    expect(view.bounds.at(-1)).toMatchObject({ x: -500, y: -300 });

    // Streamed renderer updates while the menu is open must not move the
    // parked view.
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 40, y: 60, width: 520, height: 320 },
    });
    expect(view.bounds.at(-1)).toMatchObject({ x: -500, y: -300 });

    expect(
      harness.manager.releaseOverlay("window-1", { overlayId: "palette" }),
    ).toEqual({ restoredTiles: [BASE_KEY] });
    expect(view.bounds.at(-1)).toMatchObject({
      x: 40,
      y: 60,
      width: 520,
      height: 320,
    });
    expect(view.visible).toBe(true);
  });

  it("detaches the frame feed when the tile closes (BT-202)", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];
    expect(view.webContents.frameSubscriptions).toHaveLength(1);

    harness.manager.releaseTile("window-1", BASE_KEY);

    expect(view.webContents.frameSubscriptionEnds).toBe(1);
  });

  it("never blanks the tile before the paint ack (flicker fix)", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];

    await harness.manager.occludeForOverlay("window-1", {
      overlayId: "palette",
      tiles: [BASE_KEY],
    });

    // Between occlusion and ack the native view must still be at its real
    // rect showing live pixels — that is the whole point of the fix.
    expect(view.bounds.at(-1)).toMatchObject({ x: 0, y: 0 });
    expect(view.visible).toBe(true);
  });

  it("duplicate paint acks park exactly once (flicker fix)", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];
    await harness.manager.occludeForOverlay("window-1", {
      overlayId: "palette",
      tiles: [BASE_KEY],
    });

    harness.manager.paintAckOverlay("palette");
    const parkedBounds = view.bounds.length;
    harness.manager.paintAckOverlay("palette");
    harness.manager.paintAckOverlay("palette");

    expect(view.bounds.length).toBe(parkedBounds);
    expect(view.bounds.at(-1)).toMatchObject({ x: -500, y: -300 });
  });

  it("a late ack after release never parks a restored view (flicker fix)", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];
    await harness.manager.occludeForOverlay("window-1", {
      overlayId: "palette",
      tiles: [BASE_KEY],
    });

    // User dismissed the overlay before the ack round-trip landed.
    harness.manager.releaseOverlay("window-1", { overlayId: "palette" });
    harness.manager.paintAckOverlay("palette");

    expect(view.bounds.every((b) => b.x >= 0 && b.y >= 0)).toBe(true);
    expect(view.visible).toBe(true);
  });

  it("intercepts reserved chords and replays them into the host renderer (BT-302)", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];
    harness.manager.setReservedChords(["mod+k"]);
    const preventDefault = vi.fn();

    view.webContents.emit(
      "before-input-event",
      { preventDefault },
      { type: "keyDown", key: "k", meta: true },
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(
      harness.windows.get("window-1")?.webContents.sentInputEvents,
    ).toEqual([{ type: "keyDown", keyCode: "K", modifiers: ["meta"] }]);
  });

  it("lets unreserved keystrokes through to the guest untouched (BT-302)", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];
    harness.manager.setReservedChords(["mod+k"]);
    const preventDefault = vi.fn();

    // Plain typing and an unregistered chord both pass through.
    view.webContents.emit(
      "before-input-event",
      { preventDefault },
      { type: "keyDown", key: "k" },
    );
    view.webContents.emit(
      "before-input-event",
      { preventDefault },
      { type: "keyDown", key: "t", control: true },
    );

    expect(preventDefault).not.toHaveBeenCalled();
    expect(
      harness.windows.get("window-1")?.webContents.sentInputEvents,
    ).toEqual([]);
  });

  it("does not intercept chords that cannot be replayed to the host (BT-302)", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];
    // Unprintable/unmappable keys are refused at registration time.
    harness.manager.setReservedChords(["mod+mediatracknext"]);

    const preventDefault = vi.fn();
    view.webContents.emit(
      "before-input-event",
      { preventDefault },
      { type: "keyDown", key: "MediaTrackNext", meta: true },
    );

    expect(preventDefault).not.toHaveBeenCalled();
    expect(
      harness.windows.get("window-1")?.webContents.sentInputEvents,
    ).toEqual([]);
  });

  it("folds physical Control into mod on non-mac platforms (BT-302)", async () => {
    const harness = createHarnessWithOptions({ hostPlatform: "other" });
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    harness.manager.setReservedChords(["ctrl+k"]);
    const view = harness.views[0];
    const preventDefault = vi.fn();

    view.webContents.emit(
      "before-input-event",
      { preventDefault },
      { type: "keyDown", key: "k", control: true },
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(
      harness.windows.get("window-1")?.webContents.sentInputEvents,
    ).toEqual([{ type: "keyDown", keyCode: "K", modifiers: ["control"] }]);
  });

  function makeHiddenGuestsFixture(): {
    readonly harness: Harness;
    readonly views: FakeBrowserView[];
  } {
    const harness = createHarness();
    const views: FakeBrowserView[] = [];
    ["a", "b", "c"].forEach((suffix, index) => {
      const key = {
        ...BASE_KEY,
        paneId: `pane-${suffix}`,
        tileInstanceId: `tile-${suffix}`,
        pageSessionId: `page-${suffix}`,
      };
      harness.manager.upsertTile(
        "window-1",
        upsert(key, "http://localhost:3000", true),
      );
      harness.manager.updateBounds("window-1", {
        ...key,
        bounds: { x: index * 10, y: 0, width: 400, height: 300 },
      });
      views.push(harness.views[index]);
      // Distinct show times give distinct recency stamps.
      vi.advanceTimersByTime(10);
    });
    return { harness, views };
  }

  /** Give a born-hidden guest real recency so MRU order is deterministic. */
  function cycleGuestThroughVisible(
    harness: Harness,
    key: BrowserViewTileKey,
  ): void {
    // Upsert FIRST (creates the guest), then give it geometry —
    // updateBounds is a no-op for unknown keys.
    harness.manager.upsertTile(
      "window-1",
      upsert(key, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...key,
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    });
    vi.advanceTimersByTime(5);
    harness.manager.upsertTile(
      "window-1",
      upsert(key, "http://localhost:3000", false),
    );
  }

  it("evicts the least-recently-visible guest once hidden guests exceed the cap (BT-401)", async () => {
    const { harness, views } = makeHiddenGuestsFixture();
    const keys = ["a", "b", "c"].map((suffix) => ({
      ...BASE_KEY,
      paneId: `pane-${suffix}`,
      tileInstanceId: `tile-${suffix}`,
      pageSessionId: `page-${suffix}`,
    }));

    // Hide in an order unrelated to show order; recency comes from SHOWS.
    [keys[1], keys[2], keys[0]].forEach((key) => {
      harness.manager.upsertTile(
        "window-1",
        upsert(key, "http://localhost:3000", false),
      );
    });
    vi.advanceTimersByTime(1);

    expect(harness.views).toHaveLength(3);
    expect(views[0].webContents.closeCalls).toBe(0);

    // A fourth hidden guest pushes the count one over the cap; the oldest
    // SHOW (tile-a) must go.
    const fourthKey = {
      ...BASE_KEY,
      paneId: "pane-d",
      tileInstanceId: "tile-d",
      pageSessionId: "page-d",
    };
    cycleGuestThroughVisible(harness, fourthKey);
    await vi.advanceTimersByTimeAsync(1);

    expect(views[0].webContents.closeCalls).toBe(1);
    expect(views[1].webContents.closeCalls).toBe(0);
    expect(views[2].webContents.closeCalls).toBe(0);
    expect(harness.views[3]?.webContents.closeCalls).toBe(0);
    expect(
      harness.views.filter((view) => view.webContents.closeCalls === 0),
    ).toHaveLength(3);
  });

  it("revisiting an evicted guest builds a fresh one (silent reload, BT-403)", async () => {
    const { harness, views } = makeHiddenGuestsFixture();
    const keys = ["a", "b", "c"].map((suffix) => ({
      ...BASE_KEY,
      paneId: `pane-${suffix}`,
      tileInstanceId: `tile-${suffix}`,
      pageSessionId: `page-${suffix}`,
    }));
    keys.forEach((key) => {
      harness.manager.upsertTile(
        "window-1",
        upsert(key, "http://localhost:3000", false),
      );
    });
    const fourthKey = {
      ...BASE_KEY,
      paneId: "pane-d",
      tileInstanceId: "tile-d",
      pageSessionId: "page-d",
    };
    cycleGuestThroughVisible(harness, fourthKey);
    await vi.advanceTimersByTimeAsync(1);
    expect(views[0].webContents.closeCalls).toBe(1);

    // Revisit: renderer upserts the same key again; a FRESH guest is built.
    harness.manager.upsertTile(
      "window-1",
      upsert(keys[0], "http://localhost:3000", true),
    );

    expect(harness.views).toHaveLength(5);
    expect(views[0].webContents.closeCalls).toBe(1);
    const revived = harness.views[4];
    expect(revived.webContents.id).not.toBe(views[0].webContents.id);
    // The fresh guest has no geometry yet; the renderer's bounds bridge
    // streams it right after upsert, which is what makes it visible.
    harness.manager.updateBounds("window-1", {
      ...keys[0],
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    });
    expect(revived.visible).toBe(true);
  });

  it("restores overlay-owned views in reverse occlusion order", async () => {
    const harness = createHarness();
    const secondKey: BrowserViewTileKey = {
      ...BASE_KEY,
      tileInstanceId: "tile-2",
      pageSessionId: "page-2",
    };
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    harness.manager.upsertTile(
      "window-1",
      upsert(secondKey, "http://localhost:3001", true),
    );
    harness.manager.updateBounds("window-1", {
      ...secondKey,
      bounds: { x: 500, y: 0, width: 500, height: 300 },
    });

    await harness.manager.occludeForOverlay("window-1", {
      overlayId: "drag",
      tiles: [BASE_KEY, secondKey],
    });

    expect(
      harness.manager
        .releaseOverlay("window-1", {
          overlayId: "drag",
        })
        .restoredTiles.map((tile) => tile.tileInstanceId),
    ).toEqual(["tile-2", "tile-1"]);
  });

  it("guards browser history navigation with Chromium availability", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];

    harness.manager.goBack("window-1", BASE_KEY);
    harness.manager.goForward("window-1", BASE_KEY);

    expect(view.webContents.goBackCalls).toBe(0);
    expect(view.webContents.goForwardCalls).toBe(0);

    view.webContents.canGoBackValue = true;
    view.webContents.canGoForwardValue = true;
    view.webContents.emit("did-navigate", {}, "http://localhost:3000", 0, 0);
    harness.manager.goBack("window-1", BASE_KEY);
    harness.manager.goForward("window-1", BASE_KEY);

    expect(view.webContents.goBackCalls).toBe(1);
    expect(view.webContents.goForwardCalls).toBe(1);
    expect(harness.statuses.at(-1)).toMatchObject({
      status: "loading",
      canGoBack: true,
      canGoForward: true,
    });
  });

  it("uses navigationHistory instead of deprecated webContents history checks", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];
    view.webContents.canGoBackValue = true;
    view.webContents.canGoForwardValue = true;
    view.webContents.emit("did-navigate", {}, "http://localhost:3000", 0, 0);
    view.webContents.throwDeprecatedNavigation = true;

    expect(() => {
      harness.manager.goBack("window-1", BASE_KEY);
      harness.manager.goForward("window-1", BASE_KEY);
    }).not.toThrow();

    expect(view.webContents.goBackCalls).toBe(1);
    expect(view.webContents.goForwardCalls).toBe(1);
    expect(harness.statuses.at(-1)).toMatchObject({
      status: "loading",
      canGoBack: true,
      canGoForward: true,
    });
  });

  it("reports a failed initial load as a dead browser tile", async () => {
    const harness = createHarness();

    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://127.0.0.1:65535/", true),
    );
    await Promise.resolve();

    expect(harness.statuses.at(-1)).toMatchObject({
      ...BASE_KEY,
      status: "dead",
      reason: "Navigation failed",
      canGoBack: false,
      canGoForward: false,
    });
  });

  it("keeps the durable WebContents after release even when a subsequent load fails (ticket 05)", async () => {
    const harness = createHarness();

    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://127.0.0.1:65535/", true),
    );
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected view");
    harness.manager.releaseTile("window-1", BASE_KEY);

    view.webContents.emit(
      "did-fail-load",
      {},
      -102,
      "CONNECTION_REFUSED",
      "http://127.0.0.1:65535/",
      true,
    );
    await Promise.resolve();

    // Tile unbind is not a close: failed loads must not destroy the entry.
    expect(view.webContents.closeCalls).toBe(0);
    expect(harness.electronTabHandoffNotifications).toEqual([]);
  });

  it("runs in-page find and forwards native match updates", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];

    harness.manager.findInPage("window-1", {
      ...BASE_KEY,
      requestId: 7,
      query: "needle",
      matchCase: true,
      forward: true,
      findNext: false,
    });

    expect(view.webContents.findInPageCalls).toEqual([
      {
        requestId: 1,
        text: "needle",
        options: {
          forward: true,
          findNext: false,
          matchCase: true,
        },
      },
    ]);
    expect(harness.finds.at(-1)).toMatchObject({
      requestId: 7,
      query: "needle",
      matchCase: true,
      status: "searching",
    });

    view.webContents.emit(
      "found-in-page",
      {},
      {
        requestId: 1,
        matches: 3,
        activeMatchOrdinal: 2,
        finalUpdate: true,
      },
    );
    expect(harness.finds.at(-1)).toMatchObject({
      requestId: 7,
      status: "ready",
      current: 2,
      total: 3,
      finalUpdate: true,
    });

    harness.manager.findInPage("window-1", {
      ...BASE_KEY,
      requestId: 7,
      query: "needle",
      matchCase: true,
      forward: true,
      findNext: true,
    });
    expect(view.webContents.findInPageCalls.at(-1)).toEqual({
      requestId: 2,
      text: "needle",
      options: {
        forward: true,
        findNext: true,
        matchCase: true,
      },
    });
    view.webContents.emit(
      "found-in-page",
      {},
      {
        requestId: 2,
        matches: 3,
        activeMatchOrdinal: 3,
        finalUpdate: true,
      },
    );
    expect(harness.finds.at(-1)).toMatchObject({
      requestId: 7,
      status: "ready",
      current: 3,
      total: 3,
      finalUpdate: true,
    });

    harness.manager.stopFindInPage("window-1", {
      ...BASE_KEY,
      requestId: 8,
    });

    expect(view.webContents.stopFindCalls).toBe(1);
    expect(harness.finds.at(-1)).toMatchObject({
      requestId: 8,
      query: "",
      status: "idle",
      finalUpdate: true,
    });
  });

  it("updates zoom from manager calls and chromium keyboard shortcuts", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    const view = harness.views[0];

    harness.manager.zoomIn("window-1", BASE_KEY);

    expect(view.webContents.zoomFactor).toBe(1.1);
    expect(harness.statuses.at(-1)).toMatchObject({ zoomPercent: 110 });

    const preventDefault = vi.fn();
    view.webContents.emit(
      "before-input-event",
      { preventDefault },
      { type: "keyDown", key: "-", control: true },
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(view.webContents.zoomFactor).toBe(1);
    expect(harness.statuses.at(-1)).toMatchObject({ zoomPercent: 100 });

    view.webContents.emit(
      "before-input-event",
      { preventDefault },
      { type: "keyDown", key: "+", meta: true },
    );
    view.webContents.emit(
      "before-input-event",
      { preventDefault },
      { type: "keyDown", key: "0", meta: true },
    );

    expect(view.webContents.zoomFactor).toBe(1);
    expect(harness.statuses.at(-1)).toMatchObject({ zoomPercent: 100 });
  });

  it("routes target blank to a tile and featureful window.open popups to registered child windows", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "https://app.test/root", true),
    );
    const view = harness.views[0];
    view.webContents.emit(
      "did-frame-navigate",
      {},
      "https://app.test/root",
      200,
      "OK",
      true,
    );
    const handler = view.webContents.windowOpenHandler;
    if (handler === null) throw new Error("window open handler missing");

    const targetBlankResult = handler({
      url: "/docs",
      frameName: "_blank",
      features: "",
      disposition: "new-window",
    });

    expect(targetBlankResult).toEqual({ action: "deny" });
    expect(harness.openTileRequests.at(-1)).toMatchObject({
      ...BASE_KEY,
      url: "https://app.test/docs",
      disposition: "new-window",
    });

    const popupResult = handler({
      url: "https://auth.test/login",
      frameName: "oauth",
      features: "width=500,height=640",
      disposition: "new-window",
    });

    expect(popupResult).toMatchObject({
      action: "allow",
      overrideBrowserWindowOptions: { width: 900 },
      outlivesOpener: false,
    });

    const popup = new FakePopupWindow(55);
    view.webContents.emit("did-create-window", popup);

    expect(harness.registeredPopupWebContents).toHaveLength(1);
    expect(harness.registeredPopupWebContents[0]?.id).toBe(55);
  });

  it("maps browser session download and certificate events to the owning tile", () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "https://app.test/root", true),
    );
    const view = harness.views[0];

    harness.emitDownload({
      webContentsId: view.webContents.id,
      downloadId: "download-1",
      url: "https://app.test/file.zip",
      filename: "file.zip",
      mimeType: "application/zip",
      totalBytes: 100,
      receivedBytes: 25,
      state: "progressing",
      savePath: "/tmp/file.zip",
      dangerType: null,
      canCancel: true,
    });

    expect(harness.downloads.at(-1)).toMatchObject({
      ...BASE_KEY,
      downloadId: "download-1",
      receivedBytes: 25,
      state: "progressing",
    });

    harness.emitCertificateError({
      webContentsId: view.webContents.id,
      certificateErrorId: "cert-error-1",
      url: "https://self-signed.test/",
      hostname: "self-signed.test",
      error: "ERR_CERT_AUTHORITY_INVALID",
      fingerprint: "fingerprint",
      subject: "self-signed.test",
      issuer: "self-signed.test",
    });

    expect(harness.certificateErrors.at(-1)).toMatchObject({
      ...BASE_KEY,
      certificateErrorId: "cert-error-1",
      hostname: "self-signed.test",
    });
    expect(harness.statuses.at(-1)).toMatchObject({
      status: "dead",
      reason: "Certificate error",
    });
    expect(
      harness.manager.canTrustCertificateError("window-1", {
        ...BASE_KEY,
        certificateErrorId: "cert-error-1",
      }),
    ).toBe(true);

    harness.manager.clearCertificateError("window-1", {
      ...BASE_KEY,
      certificateErrorId: "cert-error-1",
    });

    expect(view.webContents.reloadCalls).toBe(1);
    expect(harness.statuses.at(-1)).toMatchObject({ status: "loading" });
  });

  it("marks a crashed renderer dead and closes the durable entry (ticket 05)", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    const view = harness.views[0];
    view.webContents.emit("render-process-gone", {}, { reason: "crashed" });

    expect(view.visible).toBe(false);
    expect(harness.statuses.at(-1)).toMatchObject({
      status: "dead",
      reason: "crashed",
    });
    // Ticket 05: renderer crash is a destructive close of the durable entry.
    await flushCloseEntry();
    expect(view.webContents.closeCalls).toBe(1);
    harness.manager.reloadTile("window-1", BASE_KEY);
    expect(view.webContents.reloadCalls).toBe(0);
  });
});

async function upsertAndAttach(
  harness: Harness,
  windowId: string,
  key: BrowserViewTileKey,
): Promise<FakeBrowserView> {
  harness.manager.upsertTile(
    windowId,
    upsert(key, "http://localhost:3000", true),
  );
  const view = harness.views[harness.views.length - 1];
  view.webContents.emit(
    "did-frame-navigate",
    {},
    "http://localhost:3000",
    200,
    "OK",
    true,
  );
  await Promise.resolve();
  return view;
}

// Ticket 12: closeEntry re-entrancy + handoff reason mapping
// -------------------------------------------------------------------------

describe("BrowserViewManager primary profile capture (ticket 06)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("snapshots plain localStorage at navigation time and keeps an MRU of 8 origins", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "https://origin-0.example/", true),
    );
    const view = harness.views[0];
    if (view === undefined) throw new Error("missing view");

    for (let i = 0; i < 11; i += 1) {
      const url = `https://origin-${i}.example/path`;
      view.webContents.emit("did-navigate", {}, url, 0, true);
      // rememberPrimaryProfileOrigin captures localStorage asynchronously.
      await Promise.resolve();
      await Promise.resolve();
    }

    const result = await harness.manager.capturePrimaryProfile();

    expect(result.status).toBe("captured");
    expect(harness.primaryProfileCaptureSourceOrigins).toHaveLength(1);
    const origins = harness.primaryProfileCaptureSourceOrigins[0] ?? [];
    expect(origins).toHaveLength(8);
    expect(origins[0]).toBe("https://origin-10.example");
    expect(origins.at(-1)).toBe("https://origin-3.example");
    // Capture path receives plain snapshots, not live WebContents handles.
    expect(result.storageState).toEqual({
      cookies: [],
      origins: origins.map((origin) => ({
        origin,
        localStorage: [{ name: "k", value: origin }],
      })),
    });
  });
});

describe("BrowserViewManager native tab lifecycle", () => {
  it("provisions CDP before acceptance and starts navigation only after acceptance", async () => {
    const harness = createHarnessWithOptions({
      requireLoadedTargetForPageCommands: true,
    });
    const provisioned = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/target",
      seedStorageState: {
        cookies: [],
        origins: [
          {
            origin: "https://example.com",
            localStorage: [{ name: "token", value: "carried" }],
          },
        ],
      },
    });

    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");
    expect(view.webContents.loadUrls).toEqual(["about:blank"]);
    expect(view.webContents.lifecycle).toEqual([
      "loadURL",
      "Page.addScriptToEvaluateOnNewDocument",
      "Page.enable",
      "Runtime.enable",
      "Log.enable",
      "Network.enable",
      "DOM.enable",
    ]);

    await harness.manager.acceptTab(provisioned);

    expect(view.webContents.loadUrls).toEqual([
      "about:blank",
      "https://example.com/target",
    ]);
    expect(view.webContents.lifecycle).toEqual([
      "loadURL",
      "Page.addScriptToEvaluateOnNewDocument",
      "Page.enable",
      "Runtime.enable",
      "Log.enable",
      "Network.enable",
      "DOM.enable",
      "loadURL",
      "Page.removeScriptToEvaluateOnNewDocument",
    ]);
  });

  it("does not report a native tab provisioned until its tab-keyed CDP route is enabled", async () => {
    const harness = createHarness();
    const ensure = harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    });
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");
    view.webContents.debugger.deferCommands = true;

    let settled = false;
    void ensure.finally(() => {
      settled = true;
    });
    await flushCloseEntry();

    expect(settled).toBe(false);
    expect(
      view.webContents.debugger.commands.map(({ method }) => method),
    ).toEqual([
      "Page.enable",
      "Runtime.enable",
      "Log.enable",
      "Network.enable",
      "DOM.enable",
    ]);

    for (const resolve of view.webContents.debugger.commandResolvers.splice(
      0,
    )) {
      resolve(null);
    }
    await expect(ensure).resolves.toMatchObject({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
    });
  });

  it("reattaches an existing native guest after its debugger detaches", async () => {
    const harness = createHarness();
    const input = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    } as const;
    const ready = await harness.manager.ensureTab("window-1", input);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");

    view.webContents.emit(
      "did-navigate",
      {},
      "https://example.com/next",
      200,
      "OK",
    );
    view.webContents.debugger.emitDetach("target closed");

    expect(harness.nativeTabStatuses.at(-1)).toMatchObject({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: ready.registrationId,
    });
    await expect(harness.manager.ensureTab("window-1", input)).resolves.toEqual(
      ready,
    );
    expect(harness.views).toHaveLength(1);
    expect(view.webContents.debugger.isAttached()).toBe(true);
    expect(
      view.webContents.debugger.commands.filter(
        ({ method, sessionId }) =>
          method === "Page.enable" && sessionId === undefined,
      ),
    ).toHaveLength(2);
  });

  it("reattaches before the next CDP command after debugger detach", async () => {
    const harness = createHarness();
    const nativeKey = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
    } as const;
    const ready = await harness.manager.ensureTab("window-1", {
      ...nativeKey,
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    });
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");
    view.webContents.debugger.emitDetach("target closed");

    await expect(
      harness.manager.dispatchElectronTabCdp({
        ...nativeKey,
        registrationId: ready.registrationId,
        target: { kind: "root" },
        command: { kind: "cdpGetFrameTree" },
      }),
    ).resolves.toMatchObject({ kind: "cdpGetFrameTree", ok: true });
    expect(
      view.webContents.debugger.commands.filter(
        ({ method, sessionId }) =>
          method === "Page.enable" && sessionId === undefined,
      ),
    ).toHaveLength(2);
  });

  it("controls an unbound tab through its native identity", async () => {
    const harness = createHarness();
    const nativeKey = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
    } as const;
    const ready = await harness.manager.ensureTab("window-1", {
      ...nativeKey,
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    });
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");
    await harness.manager.acceptTab(ready);
    view.webContents.canGoBackValue = true;
    view.webContents.canGoForwardValue = true;

    await expect(
      harness.manager.controlElectronTab("window-1", {
        ...nativeKey,
        registrationId: ready.registrationId,
        action: { kind: "navigate", url: "https://example.com/next" },
      }),
    ).resolves.toBe(true);
    await expect(
      harness.manager.controlElectronTab("window-1", {
        ...nativeKey,
        registrationId: ready.registrationId,
        action: { kind: "reload" },
      }),
    ).resolves.toBe(true);
    await harness.manager.controlElectronTab("window-1", {
      ...nativeKey,
      registrationId: ready.registrationId,
      action: { kind: "goBack" },
    });
    await harness.manager.controlElectronTab("window-1", {
      ...nativeKey,
      registrationId: ready.registrationId,
      action: { kind: "goForward" },
    });
    await harness.manager.controlElectronTab("window-1", {
      ...nativeKey,
      registrationId: ready.registrationId,
      action: { kind: "setViewportPreset", viewportPreset: "mobile" },
    });
    await harness.manager.controlElectronTab("window-1", {
      ...nativeKey,
      registrationId: ready.registrationId,
      action: { kind: "zoomIn" },
    });
    await harness.manager.controlElectronTab("window-1", {
      ...nativeKey,
      registrationId: ready.registrationId,
      action: { kind: "zoomOut" },
    });
    await harness.manager.controlElectronTab("window-1", {
      ...nativeKey,
      registrationId: ready.registrationId,
      action: { kind: "resetZoom" },
    });
    await harness.manager.controlElectronTab("window-1", {
      ...nativeKey,
      registrationId: ready.registrationId,
      action: { kind: "openDevTools" },
    });

    expect(view.webContents.loadUrls).toEqual([
      "about:blank",
      "https://example.com/",
      "https://example.com/next",
    ]);
    expect(view.webContents.reloadCalls).toBe(1);
    expect(view.webContents.goBackCalls).toBe(1);
    expect(view.webContents.goForwardCalls).toBe(1);
    expect(view.webContents.zoomFactor).toBe(1);
    expect(view.webContents.openDevToolsCalls).toHaveLength(1);

    await expect(
      harness.manager.controlElectronTab("window-1", {
        ...nativeKey,
        tabId: "missing-tab",
        registrationId: ready.registrationId,
        action: { kind: "reload" },
      }),
    ).resolves.toBe(false);
  });

  it("rejects stale native capabilities before any post-ready mutation", async () => {
    const harness = createHarness();
    const nativeKey = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
    } as const;
    const ready = await harness.manager.ensureTab("window-1", {
      ...nativeKey,
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    });
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");
    const surface = {
      ...BASE_KEY,
      tileInstanceId: "native-tile",
    };

    expect(
      harness.manager.attachSurface("window-1", {
        ...nativeKey,
        registrationId: "stale-registration",
        bindingId: "binding-1",
        surface,
        visible: true,
      }),
    ).toBe(false);
    expect(harness.windows.get("window-1")?.contentView.children).not.toContain(
      view,
    );

    await expect(
      harness.manager.controlElectronTab("window-1", {
        ...nativeKey,
        registrationId: "stale-registration",
        action: { kind: "reload" },
      }),
    ).resolves.toBe(false);
    expect(view.webContents.reloadCalls).toBe(0);

    await expect(
      harness.manager.startPipCapture(
        "window-1",
        {
          ...nativeKey,
          registrationId: "stale-registration",
          maxWidth: 640,
          maxHeight: 360,
          quality: 75,
        },
        () => undefined,
      ),
    ).resolves.toBe(false);
    expect(view.webContents.lifecycle).not.toContain("capturePage");

    expect(
      harness.manager.attachSurface("window-1", {
        ...nativeKey,
        registrationId: ready.registrationId,
        bindingId: "binding-1",
        surface,
        visible: true,
      }),
    ).toBe(true);
    expect(harness.windows.get("window-1")?.contentView.children).toContain(
      view,
    );
    expect(
      harness.manager.detachSurface("window-1", {
        ...nativeKey,
        registrationId: "stale-registration",
        bindingId: "binding-1",
      }),
    ).toBe(false);
    expect(harness.windows.get("window-1")?.contentView.children).toContain(
      view,
    );
    expect(
      harness.manager.detachSurface("window-1", {
        ...nativeKey,
        registrationId: ready.registrationId,
        bindingId: "binding-1",
      }),
    ).toBe(true);
  });

  it("transfers the lifecycle notification lease on authoritative ensure", async () => {
    const harness = createHarness();
    const nativeKey = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
    } as const;
    const ensureInput = {
      ...nativeKey,
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    } as const;
    const ready = await harness.manager.ensureTab("window-1", ensureInput);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");
    await harness.manager.acceptTab(ready);

    // Stable guest identity is independent of the renderer connection that
    // currently owns lifecycle notifications.
    await harness.manager.ensureTab("window-2", ensureInput);
    harness.statusWindowIds.length = 0;
    harness.nativeTabStatusWindowIds.length = 0;

    expect(
      harness.manager.attachSurface("window-2", {
        ...nativeKey,
        registrationId: ready.registrationId,
        bindingId: "binding-2",
        surface: {
          ...BASE_KEY,
          tileInstanceId: "native-tile-window-2",
        },
        visible: true,
      }),
    ).toBe(true);
    expect(harness.statusWindowIds.at(-1)).toBe("window-2");
    expect(harness.nativeTabStatusWindowIds.at(-1)).toBe("window-2");

    harness.manager.dispose();
    await flushCloseEntry();
    expect(harness.electronTabHandoffWindowIds).toEqual(["window-2"]);
  });

  it("transfers a provisioning tab's lifecycle lease before awaiting readiness", async () => {
    const harness = createHarness();
    const ensureInput = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    } as const;
    const firstEnsure = harness.manager.ensureTab("window-1", ensureInput);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");
    view.webContents.debugger.deferCommands = true;
    await flushCloseEntry();

    const reclaimedEnsure = harness.manager.ensureTab("window-2", ensureInput);
    const previousOwner = harness.windows.get("window-1")?.webContents;
    if (previousOwner === undefined) throw new Error("expected host window");
    previousOwner.emit(
      "did-start-navigation",
      {},
      "http://localhost:31873/",
      false,
      true,
      1,
      1,
    );

    for (const resolve of view.webContents.debugger.commandResolvers.splice(
      0,
    )) {
      resolve(null);
    }
    const [firstReady, reclaimedReady] = await Promise.all([
      firstEnsure,
      reclaimedEnsure,
    ]);

    expect(reclaimedReady).toEqual(firstReady);
    expect(view.webContents.closeCalls).toBe(0);
    expect(harness.views).toHaveLength(1);
  });

  it("echoes an existing native tab's current status when a renderer ensures it again", async () => {
    const harness = createHarness();
    const input = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    } as const;
    const provisioned = await harness.manager.ensureTab("window-1", input);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");
    await harness.manager.acceptTab(provisioned);
    view.webContents.emit(
      "did-frame-navigate",
      {},
      "https://example.com/",
      200,
      "OK",
      true,
    );
    view.webContents.title = "Example Domain";
    view.webContents.emit("page-title-updated", {}, "Example Domain");
    harness.nativeTabStatuses.length = 0;

    await harness.manager.ensureTab("window-1", input);

    expect(harness.nativeTabStatuses).toEqual([
      expect.objectContaining({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: provisioned.registrationId,
        url: "https://example.com/",
        title: "Example Domain",
        status: "ready",
      }),
    ]);
  });

  it("owns one guest per native identity across concurrent ensure, surface moves, and exact release", async () => {
    const harness = createHarness();
    const nativeKey = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
    } as const;
    const ensureInput = {
      ...nativeKey,
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    };

    const firstEnsure = harness.manager.ensureTab("window-1", ensureInput);
    const replayedEnsure = harness.manager.ensureTab("window-1", ensureInput);

    expect(harness.views).toHaveLength(1);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");
    view.webContents.title = "Example Domain";
    view.webContents.emit(
      "did-navigate",
      {},
      "https://example.com/",
      200,
      "OK",
    );

    const [firstReady, replayedReady] = await Promise.all([
      firstEnsure,
      replayedEnsure,
    ]);
    expect(replayedReady).toEqual(firstReady);
    expect(firstReady).toMatchObject({
      ...nativeKey,
    });
    expect(firstReady.registrationId).not.toBe("");
    await harness.manager.acceptTab(firstReady);

    expect(
      harness.manager.attachSurface("window-1", {
        ...nativeKey,
        registrationId: firstReady.registrationId,
        bindingId: "binding-1",
        surface: BASE_KEY,
        visible: true,
      }),
    ).toBe(true);
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    });
    expect(harness.windows.get("window-1")?.contentView.children).toContain(
      view,
    );

    const movedSurface = {
      ...BASE_KEY,
      tileInstanceId: "tile-2",
    };
    expect(
      harness.manager.attachSurface("window-2", {
        ...nativeKey,
        registrationId: firstReady.registrationId,
        bindingId: "binding-2",
        surface: movedSurface,
        visible: true,
      }),
    ).toBe(true);
    expect(harness.views).toHaveLength(1);
    expect(harness.windows.get("window-1")?.contentView.children).not.toContain(
      view,
    );
    expect(harness.windows.get("window-2")?.contentView.children).toContain(
      view,
    );
    expect(
      harness.windows
        .get("window-1")
        ?.webContents.listenerCount("did-start-navigation"),
    ).toBe(1);
    expect(
      harness.windows
        .get("window-2")
        ?.webContents.listenerCount("did-start-navigation"),
    ).toBe(1);

    expect(
      harness.manager.detachSurface("window-1", {
        ...nativeKey,
        registrationId: firstReady.registrationId,
        bindingId: "binding-1",
      }),
    ).toBe(false);
    expect(harness.windows.get("window-2")?.contentView.children).toContain(
      view,
    );

    expect(
      harness.manager.detachSurface("window-2", {
        ...nativeKey,
        registrationId: firstReady.registrationId,
        bindingId: "binding-2",
      }),
    ).toBe(true);
    expect(harness.windows.get("window-2")?.contentView.children).not.toContain(
      view,
    );
    expect(view.webContents.closeCalls).toBe(0);

    await expect(
      harness.manager.dispatchElectronTabCdp({
        ...nativeKey,
        registrationId: "stale-registration",
        target: { kind: "root" },
        command: { kind: "cdpGetFrameTree" },
      }),
    ).resolves.toMatchObject({
      kind: "cdpGetFrameTree",
      ok: false,
      error: { kind: "tab_not_found" },
    });
    await expect(
      harness.manager.dispatchElectronTabCdp({
        ...nativeKey,
        registrationId: firstReady.registrationId,
        target: { kind: "root" },
        command: { kind: "cdpGetFrameTree" },
      }),
    ).resolves.toMatchObject({ kind: "cdpGetFrameTree", ok: true });

    await expect(
      harness.manager.releaseTab({
        ...nativeKey,
        registrationId: "stale-registration",
      }),
    ).resolves.toBe(false);
    expect(view.webContents.closeCalls).toBe(0);

    await expect(
      harness.manager.releaseTab({
        ...nativeKey,
        registrationId: firstReady.registrationId,
      }),
    ).resolves.toBe(true);
    expect(view.webContents.closeCalls).toBe(1);
    expect(
      harness.windows
        .get("window-1")
        ?.webContents.listenerCount("did-start-navigation"),
    ).toBe(0);
    expect(
      harness.windows
        .get("window-2")
        ?.webContents.listenerCount("did-start-navigation"),
    ).toBe(0);
  });

  it("serializes ensure behind an in-flight close for the same native identity", async () => {
    const capture =
      Promise.withResolvers<BrowserViewStorageStateCaptureResult>();
    const harness = createHarnessWithOptions({
      captureStorageState: () => capture.promise,
    });
    const input = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    };
    const ready = await harness.manager.ensureTab("window-1", input);
    await harness.manager.acceptTab(ready);
    const firstView = harness.views[0];
    if (firstView === undefined) throw new Error("expected native guest");

    const handoff = harness.manager.drainBrowserHandoffsForWindow("window-1");
    await flushCloseEntry();
    const firstRelease = harness.manager.releaseTab({
      hostId: input.hostId,
      sessionId: input.sessionId,
      tabId: input.tabId,
      registrationId: ready.registrationId,
    });
    const duplicateRelease = harness.manager.releaseTab({
      hostId: input.hostId,
      sessionId: input.sessionId,
      tabId: input.tabId,
      registrationId: ready.registrationId,
    });
    const replacement = harness.manager.ensureTab("window-1", input);

    expect(harness.views).toHaveLength(1);
    expect(firstView.webContents.closeCalls).toBe(0);

    capture.resolve({
      storageState: { cookies: [], origins: [] },
      cookieCount: 0,
      cookieDomains: [],
      localStorageCount: 0,
      localStorageAvailable: true,
      localStorageReason: null,
    });
    await expect(
      Promise.all([handoff, firstRelease, duplicateRelease]),
    ).resolves.toEqual([undefined, true, true]);
    await expect(replacement).resolves.toMatchObject({
      hostId: input.hostId,
      sessionId: input.sessionId,
      tabId: input.tabId,
    });
    expect(firstView.webContents.closeCalls).toBe(1);
    expect(harness.views).toHaveLength(2);
  });

  it("leaves a native handoff retryable when renderer delivery fails", async () => {
    let rendererAvailable = false;
    const harness = createHarnessWithOptions({
      notifyElectronTabHandoff: () => rendererAvailable,
    });
    const provisioned = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    });
    await harness.manager.acceptTab(provisioned);

    await expect(
      harness.manager.drainBrowserHandoffsForWindow("window-1"),
    ).rejects.toThrow("Electron tab handoff could not be delivered");
    expect(harness.electronTabHandoffNotifications).toEqual([]);

    rendererAvailable = true;

    await expect(
      harness.manager.drainBrowserHandoffsForWindow("window-1"),
    ).resolves.toBeUndefined();
    expect(harness.electronTabHandoffNotifications).toHaveLength(1);
    harness.manager.dispose();
  });

  it("hands off and closes only native sessions owned by the closing window", async () => {
    const harness = createHarness();
    const closing = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-closing",
      tabId: "tab-closing",
      requestedUrl: "https://example.com/closing",
      seedStorageState: null,
    });
    const remaining = await harness.manager.ensureTab("window-2", {
      hostId: "host-1",
      sessionId: "session-remaining",
      tabId: "tab-remaining",
      requestedUrl: "https://example.com/remaining",
      seedStorageState: null,
    });
    await harness.manager.acceptTab(closing);
    await harness.manager.acceptTab(remaining);

    expect(harness.manager.hasNativeTabsForWindow("window-1")).toBe(true);
    expect(harness.manager.hasNativeTabsForWindow("window-2")).toBe(true);

    await harness.manager.drainBrowserHandoffsForWindow("window-1");
    expect(harness.electronTabHandoffWindowIds).toEqual(["window-1"]);
    expect(harness.electronTabHandoffNotifications[0]).toMatchObject({
      sessionId: "session-closing",
      tabId: "tab-closing",
    });

    await harness.manager.closeNativeSessionsForWindow("window-1");
    expect(harness.views[0]?.webContents.closeCalls).toBe(1);
    expect(harness.views[1]?.webContents.closeCalls).toBe(0);
    expect(harness.manager.hasNativeTabsForWindow("window-1")).toBe(false);
    expect(harness.manager.hasNativeTabsForWindow("window-2")).toBe(true);
    harness.manager.dispose();
    await flushCloseEntry();
  });

  it("hands off a detached native tab by exact identity and incarnation", async () => {
    const harness = createHarness();
    const ready = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    });
    await harness.manager.acceptTab(ready);

    harness.manager.dispose();
    await flushCloseEntry();

    expect(harness.electronTabHandoffNotifications).toEqual([
      {
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: ready.registrationId,
        capturedUrl: "https://example.com/",
        capturedStorageState: { cookies: [], origins: [] },
        siblingTabs: [],
        reason: "gui-quit",
      },
    ]);
  });

  it("reads the live document URL when handing off a native tab", async () => {
    const harness = createHarness();
    const ready = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    });
    await harness.manager.acceptTab(ready);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");

    await view.webContents.loadURL("https://www.thecapitalgrille.com/");
    harness.manager.dispose();
    await flushCloseEntry();

    expect(harness.electronTabHandoffNotifications[0]?.capturedUrl).toBe(
      "https://www.thecapitalgrille.com/",
    );
  });

  it("excludes an unaccepted sibling from session handoff", async () => {
    const harness = createHarness();
    const accepted = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "accepted-tab",
      requestedUrl: "https://example.com/accepted",
      seedStorageState: null,
    });
    await harness.manager.acceptTab(accepted);
    await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "provisional-tab",
      requestedUrl: "https://example.com/provisional",
      seedStorageState: null,
    });

    harness.manager.dispose();
    await flushCloseEntry();

    expect(harness.electronTabHandoffNotifications).toHaveLength(1);
    expect(harness.electronTabHandoffNotifications[0]).toMatchObject({
      tabId: "accepted-tab",
      siblingTabs: [],
    });
    expect(harness.views.map((view) => view.webContents.closeCalls)).toEqual([
      1, 1,
    ]);
  });

  it("closes provisional guests but retains accepted guests when their renderer crashes", async () => {
    const harness = createHarness();
    await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "provisional-tab",
      requestedUrl: "https://example.com/provisional",
      seedStorageState: null,
    });
    const accepted = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "accepted-tab",
      requestedUrl: "https://example.com/accepted",
      seedStorageState: null,
    });
    await harness.manager.acceptTab(accepted);

    harness.windows
      .get("window-1")
      ?.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    await flushCloseEntry();

    expect(harness.views.map((view) => view.webContents.closeCalls)).toEqual([
      1, 0,
    ]);
  });

  it("does not start PiP without a live compositor window", async () => {
    const harness = createHarness();
    const nativeKey = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
    } as const;
    const ready = await harness.manager.ensureTab("window-1", {
      ...nativeKey,
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    });
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");

    await expect(
      harness.manager.startPipCapture(
        "missing-window",
        {
          ...nativeKey,
          registrationId: ready.registrationId,
          maxWidth: 640,
          maxHeight: 360,
          quality: 75,
        },
        () => undefined,
      ),
    ).resolves.toBe(false);
    expect(view.visible).toBe(false);
    expect(view.bounds).toEqual([]);
  });

  it("holds and releases the compositor lease for an unbound PiP tab", async () => {
    const harness = createHarness();
    const nativeKey = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
    } as const;
    const ready = await harness.manager.ensureTab("window-1", {
      ...nativeKey,
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    });
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");

    await expect(
      harness.manager.startPipCapture(
        "window-1",
        {
          ...nativeKey,
          registrationId: ready.registrationId,
          maxWidth: 640,
          maxHeight: 360,
          quality: 75,
        },
        () => undefined,
      ),
    ).resolves.toBe(true);
    expect(harness.windows.get("window-1")?.contentView.children).toContain(
      view,
    );
    expect(view.visible).toBe(true);

    harness.emitWindowChange();

    expect(harness.windows.get("window-1")?.contentView.children).toContain(
      view,
    );
    expect(view.visible).toBe(true);

    harness.manager.stopPipCapture();

    expect(harness.windows.get("window-1")?.contentView.children).not.toContain(
      view,
    );
    expect(view.visible).toBe(false);
  });
});

describe("BrowserViewManager host window renderer reset (fix round 2)", () => {
  function makeVisible(harness: Harness, key: BrowserViewTileKey): void {
    harness.manager.upsertTile(
      "window-1",
      upsert(key, "https://example.com", true),
    );
    harness.manager.updateBounds("window-1", {
      ...key,
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });
  }

  it("hides every entry on that window when the host renderer starts a fresh main-frame navigation", () => {
    const harness = createHarness();
    makeVisible(harness, BASE_KEY);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected view");
    expect(view.visible).toBe(true);

    const hostWebContents = harness.windows.get("window-1")?.webContents;
    if (hostWebContents === undefined) throw new Error("expected host window");
    // (event, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId)
    hostWebContents.emit(
      "did-start-navigation",
      {},
      "http://localhost:31873/",
      false,
      true,
      1,
      1,
    );

    expect(view.visible).toBe(false);
    expect(harness.rendererResetWindowIds).toEqual(["window-1"]);
  });

  it("ignores same-document and non-main-frame navigations on the host window", () => {
    const harness = createHarness();
    makeVisible(harness, BASE_KEY);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected view");

    const hostWebContents = harness.windows.get("window-1")?.webContents;
    if (hostWebContents === undefined) throw new Error("expected host window");
    hostWebContents.emit(
      "did-start-navigation",
      {},
      "http://localhost:31873/#hash",
      true,
      true,
      1,
      1,
    );
    expect(view.visible).toBe(true);

    hostWebContents.emit(
      "did-start-navigation",
      {},
      "http://localhost:31873/iframe",
      false,
      false,
      1,
      2,
    );
    expect(view.visible).toBe(true);
  });

  it("hides every entry on that window when the host renderer crashes", () => {
    const harness = createHarness();
    makeVisible(harness, BASE_KEY);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected view");

    const hostWebContents = harness.windows.get("window-1")?.webContents;
    if (hostWebContents === undefined) throw new Error("expected host window");
    hostWebContents.emit("render-process-gone", {}, { reason: "crashed" });

    expect(view.visible).toBe(false);
  });

  it("re-upserting the same tile clears the reset and makes it visible again", () => {
    const harness = createHarness();
    makeVisible(harness, BASE_KEY);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected view");

    const hostWebContents = harness.windows.get("window-1")?.webContents;
    if (hostWebContents === undefined) throw new Error("expected host window");
    hostWebContents.emit(
      "did-start-navigation",
      {},
      "http://localhost:31873/",
      false,
      true,
      1,
      1,
    );
    expect(view.visible).toBe(false);

    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "https://example.com", true),
    );
    expect(view.visible).toBe(true);
  });

  it("re-upserting the same tile after a renderer reset echoes the entry's current status to the new renderer", () => {
    const harness = createHarness();
    makeVisible(harness, BASE_KEY);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected view");

    // The tile reached "ready" via its own navigation commit before the
    // reload, so main holds ready while the (future) renderer never saw it.
    // (event, url, httpStatusCode, statusText, isMainFrame)
    view.webContents.emit(
      "did-frame-navigate",
      {},
      "https://example.com",
      200,
      "OK",
      true,
    );
    expect(harness.statuses.at(-1)).toMatchObject({
      ...BASE_KEY,
      status: "ready",
    });
    const statusesAfterReloadStart = harness.statuses.length;

    const hostWebContents = harness.windows.get("window-1")?.webContents;
    if (hostWebContents === undefined) throw new Error("expected host window");
    hostWebContents.emit(
      "did-start-navigation",
      {},
      "http://localhost:31873/",
      false,
      true,
      1,
      1,
    );
    expect(view.visible).toBe(false);

    // The reloaded renderer re-upserts the identical key with the same URL:
    // no navigation cycle runs, so the reconcile echo is the only way the
    // fresh renderer learns the entry is already ready.
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "https://example.com", true),
    );
    expect(view.visible).toBe(true);
    const echoes = harness.statuses.slice(statusesAfterReloadStart);
    expect(
      echoes.some(
        (change) =>
          change.viewTabId === BASE_KEY.viewTabId &&
          change.paneId === BASE_KEY.paneId &&
          change.tileInstanceId === BASE_KEY.tileInstanceId &&
          change.pageSessionId === BASE_KEY.pageSessionId &&
          change.status === "ready" &&
          change.url === "https://example.com",
      ),
    ).toBe(true);
  });

  it("a same-tile upsert with a changed URL navigates instead of echoing stale readiness", () => {
    const harness = createHarness();
    makeVisible(harness, BASE_KEY);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected view");

    view.webContents.emit(
      "did-frame-navigate",
      {},
      "https://example.com",
      200,
      "OK",
      true,
    );
    const statusesBeforeUpsert = harness.statuses.length;

    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "https://example.com/next", true),
    );

    const emitted = harness.statuses.slice(statusesBeforeUpsert);
    expect(emitted).toHaveLength(1);
    // navigate() emits loading with the entry's currentUrl; the requested
    // URL lands in that field only once the navigation commits.
    expect(emitted[0]).toMatchObject({
      ...BASE_KEY,
      status: "loading",
    });
    expect(view.webContents.loadUrls).toContain("https://example.com/next");
  });

  it("does not re-show a stale entry that was never re-upserted, even after further recomputes", () => {
    const harness = createHarness();
    makeVisible(harness, BASE_KEY);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected view");

    const hostWebContents = harness.windows.get("window-1")?.webContents;
    if (hostWebContents === undefined) throw new Error("expected host window");
    hostWebContents.emit(
      "did-start-navigation",
      {},
      "http://localhost:31873/",
      false,
      true,
      1,
      1,
    );
    expect(view.visible).toBe(false);

    // A recompute unrelated to this exact tile (e.g. another tile's bounds
    // update triggering window reconciliation) must not accidentally
    // re-show a stale-generation entry that the new renderer never claimed.
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 5, y: 5, width: 300, height: 200 },
    });
    expect(view.visible).toBe(false);
  });
});

describe("BrowserViewManager overlay occlusion broadcast routing (fix round 3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs once, with counts, when none of the requested tiles belong to this manager instance", async () => {
    const harness = createHarness();
    // No upsertTile call for BASE_KEY - this manager instance owns nothing,
    // exactly the shape of an occlude broadcast landing on the agent
    // manager for a primary-only tile (or vice versa).
    const infoSpy = vi.spyOn(log, "info");

    await harness.manager.occludeForOverlay("window-1", {
      overlayId: "settings-dialog",
      tiles: [BASE_KEY],
    });

    expect(infoSpy).toHaveBeenCalledWith(
      "[browser-view] occlude for overlay: no matching entries",
      expect.objectContaining({
        overlayId: "settings-dialog",
        requestedCount: 1,
        matchedCount: 0,
      }),
    );
  });

  it("does not log a no-match warning when this manager owns the requested tile", async () => {
    const harness = createHarness();
    harness.manager.upsertTile(
      "window-1",
      upsert(BASE_KEY, "http://localhost:3000", true),
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });
    const infoSpy = vi.spyOn(log, "info");

    await harness.manager.occludeForOverlay("window-1", {
      overlayId: "settings-dialog",
      tiles: [BASE_KEY],
    });

    expect(infoSpy).not.toHaveBeenCalledWith(
      "[browser-view] occlude for overlay: no matching entries",
      expect.anything(),
    );
  });
});

describe("BrowserViewManager annotation session", () => {
  function annotationBindingCommands(view: FakeBrowserView): string[] {
    return view.webContents.debugger.commands
      .filter(
        (command) =>
          (command.method === "Runtime.addBinding" ||
            command.method === "Runtime.removeBinding") &&
          command.params.name === "__traycerAnnotation",
      )
      .map((command) => command.method);
  }

  function annotationEventTypes(
    harness: Harness,
  ): BrowserAnnotationSessionIpcEvent["event"][] {
    return harness.annotationEvents.map((change) => change.event);
  }

  it("starts an annotation session after a committed navigation", async () => {
    const harness = createHarness();
    const view = await upsertAndAttach(harness, "window-1", BASE_KEY);
    expect(view.webContents.debugger.attached).toBe(true);

    await expect(
      harness.manager.startAnnotation("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });
    expect(annotationBindingCommands(view)).toEqual(["Runtime.addBinding"]);
    expect(annotationEventTypes(harness)).toEqual([]);
  });

  it("replaces an active session on a second startAnnotation", async () => {
    const harness = createHarness();
    const view = await upsertAndAttach(harness, "window-1", BASE_KEY);

    await expect(
      harness.manager.startAnnotation("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });
    await expect(
      harness.manager.startAnnotation("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });

    expect(annotationBindingCommands(view)).toEqual([
      "Runtime.addBinding",
      "Runtime.removeBinding",
      "Runtime.addBinding",
    ]);
    expect(annotationEventTypes(harness)).toEqual([
      { type: "ended", reason: "replaced" },
    ]);
    expect(harness.annotationEvents[0]).toMatchObject(BASE_KEY);
  });

  it("tears down on reload, navigation, crash, debugger detach, release, and cancel", async () => {
    const reloadHarness = createHarness();
    const reloadView = await upsertAndAttach(
      reloadHarness,
      "window-1",
      BASE_KEY,
    );
    await reloadHarness.manager.startAnnotation("window-1", BASE_KEY);
    reloadHarness.manager.reloadTile("window-1", BASE_KEY);
    expect(annotationBindingCommands(reloadView)).toEqual([
      "Runtime.addBinding",
      "Runtime.removeBinding",
    ]);
    expect(annotationEventTypes(reloadHarness)).toEqual([
      { type: "ended", reason: "reload" },
    ]);

    const navHarness = createHarness();
    const navView = await upsertAndAttach(navHarness, "window-1", BASE_KEY);
    await navHarness.manager.startAnnotation("window-1", BASE_KEY);
    navView.webContents.emit(
      "did-navigate-in-page",
      {},
      "http://localhost:3000/#step",
      true,
      1,
      2,
    );
    expect(annotationBindingCommands(navView)).toEqual([
      "Runtime.addBinding",
      "Runtime.removeBinding",
    ]);
    expect(annotationEventTypes(navHarness)).toEqual([
      { type: "ended", reason: "navigation" },
    ]);

    const crashHarness = createHarness();
    const crashView = await upsertAndAttach(crashHarness, "window-1", BASE_KEY);
    await crashHarness.manager.startAnnotation("window-1", BASE_KEY);
    crashView.webContents.emit(
      "render-process-gone",
      {},
      { reason: "crashed" },
    );
    expect(annotationBindingCommands(crashView)).toEqual([
      "Runtime.addBinding",
      "Runtime.removeBinding",
    ]);
    expect(annotationEventTypes(crashHarness)).toEqual([
      { type: "ended", reason: "crash" },
    ]);
    await flushCloseEntry();

    const detachHarness = createHarness();
    const detachView = await upsertAndAttach(
      detachHarness,
      "window-1",
      BASE_KEY,
    );
    await detachHarness.manager.startAnnotation("window-1", BASE_KEY);
    detachView.webContents.debugger.emitDetach("target closed");
    expect(annotationBindingCommands(detachView)).toEqual([
      "Runtime.addBinding",
    ]);
    expect(annotationEventTypes(detachHarness)).toEqual([
      { type: "ended", reason: "crash" },
    ]);

    const releaseHarness = createHarness();
    const releaseView = await upsertAndAttach(
      releaseHarness,
      "window-1",
      BASE_KEY,
    );
    await releaseHarness.manager.startAnnotation("window-1", BASE_KEY);
    releaseHarness.manager.releaseTile("window-1", BASE_KEY);
    expect(annotationBindingCommands(releaseView)).toEqual([
      "Runtime.addBinding",
      "Runtime.removeBinding",
    ]);
    expect(annotationEventTypes(releaseHarness)).toEqual([
      { type: "ended", reason: "tile-close" },
    ]);

    const cancelHarness = createHarness();
    const cancelView = await upsertAndAttach(
      cancelHarness,
      "window-1",
      BASE_KEY,
    );
    await cancelHarness.manager.startAnnotation("window-1", BASE_KEY);
    cancelHarness.manager.cancelAnnotation("window-1", BASE_KEY);
    expect(annotationBindingCommands(cancelView)).toEqual([
      "Runtime.addBinding",
      "Runtime.removeBinding",
    ]);
    expect(annotationEventTypes(cancelHarness)).toEqual([
      { type: "cancelled" },
    ]);
  });

  const VALID_UNION = { x: 1, y: 2, width: 10, height: 20 };

  const TARGET_CHAT_ID = "chat-target-1";

  const VALID_ATTACH_PAYLOAD = {
    targetChatId: TARGET_CHAT_ID,
    marks: [
      {
        id: "m1",
        kind: "element" as const,
        bounds: VALID_UNION,
        selector: "button#go",
      },
    ],
    elements: [
      {
        selector: "button#go",
        tagName: "BUTTON",
        elementId: "go",
        classNames: ["primary"],
        outerHtml: "<button>Go</button>",
        outerHtmlTruncated: false,
        textPreview: "Go",
        ariaRole: "button",
        accessibleName: "Go",
        boundingBox: {
          x: 1,
          y: 2,
          width: 10,
          height: 20,
          top: 2,
          right: 11,
          bottom: 22,
          left: 1,
        },
      },
    ],
    comment: "look here",
    unionRect: VALID_UNION,
  };

  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function emitAnnotationBinding(
    view: FakeBrowserView,
    payload: unknown,
    executionContextId: number | undefined,
  ): void {
    const params: Record<string, unknown> = {
      name: ANNOTATION_BINDING_NAME,
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    };
    if (executionContextId !== undefined) {
      params.executionContextId = executionContextId;
    }
    view.webContents.debugger.emitMessage(
      "Runtime.bindingCalled",
      params,
      undefined,
    );
  }

  it("forwards a successful attachRequested capture as annotationAttached and does not emit the guest event", async () => {
    const harness = createHarness();
    const view = await upsertAndAttach(harness, "window-1", BASE_KEY);
    await expect(
      harness.manager.startAnnotation("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });

    emitAnnotationBinding(
      view,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();

    expect(harness.annotationAttached).toHaveLength(1);
    const attached = harness.annotationAttached[0];
    expect(attached?.targetChatId).toBe(TARGET_CHAT_ID);
    expect(attached?.payload.annotationId.startsWith("ann-")).toBe(true);
    expect(attached?.pngBytes.byteLength).toBeGreaterThan(0);
    expect(attached).toMatchObject(BASE_KEY);
  });

  it("emits no annotationAttached on empty capture and leaves the session cancellable", async () => {
    const harness = createHarness();
    const view = await upsertAndAttach(harness, "window-1", BASE_KEY);
    view.webContents.emptyCapture = true;
    await expect(
      harness.manager.startAnnotation("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });

    emitAnnotationBinding(
      view,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();

    expect(harness.annotationAttached).toEqual([]);

    harness.manager.cancelAnnotation("window-1", BASE_KEY);
    expect(annotationEventTypes(harness)).toEqual([{ type: "cancelled" }]);
  });

  it("ends the annotation session on page-initiated main-frame navigation", async () => {
    const harness = createHarness();
    const view = await upsertAndAttach(harness, "window-1", BASE_KEY);
    await expect(
      harness.manager.startAnnotation("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });

    view.webContents.emit(
      "did-start-navigation",
      {},
      "http://localhost:3000/next",
      false,
      true,
      1,
      2,
    );

    expect(annotationBindingCommands(view)).toEqual([
      "Runtime.addBinding",
      "Runtime.removeBinding",
    ]);
    expect(annotationEventTypes(harness)).toEqual([
      { type: "ended", reason: "navigation" },
    ]);

    view.webContents.emit(
      "did-frame-navigate",
      {},
      "http://localhost:3000/next",
      200,
      "OK",
      true,
    );
    expect(annotationEventTypes(harness)).toEqual([
      { type: "ended", reason: "navigation" },
    ]);
  });

  it("does not emit annotationAttached when navigation starts during capturePage", async () => {
    const harness = createHarness();
    const view = await upsertAndAttach(harness, "window-1", BASE_KEY);
    view.webContents.deferCaptures = true;
    await expect(
      harness.manager.startAnnotation("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });

    emitAnnotationBinding(
      view,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();
    expect(
      view.webContents.lifecycle.filter((item) => item === "capturePage"),
    ).toHaveLength(1);

    view.webContents.emit(
      "did-start-navigation",
      {},
      "http://localhost:3000/away",
      false,
      true,
      1,
      2,
    );
    view.webContents.resolveNextCapture();
    await flush();

    expect(harness.annotationAttached).toEqual([]);
    expect(annotationEventTypes(harness)).toEqual([
      { type: "ended", reason: "navigation" },
    ]);
  });

  it("refuses keyboard and toolbar zoom while marks exist, and unlocks after erase or attach reset", async () => {
    const harness = createHarness();
    const view = await upsertAndAttach(harness, "window-1", BASE_KEY);
    await expect(
      harness.manager.startAnnotation("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });

    emitAnnotationBinding(
      view,
      { type: "stateChanged", mode: "select", markCount: 1 },
      77,
    );
    const preventDefault = vi.fn();
    harness.manager.zoomIn("window-1", BASE_KEY);
    view.webContents.emit(
      "before-input-event",
      { preventDefault },
      { type: "keyDown", key: "+", meta: true },
    );
    expect(view.webContents.zoomFactor).toBe(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);

    emitAnnotationBinding(
      view,
      { type: "stateChanged", mode: "erase", markCount: 0 },
      77,
    );
    harness.manager.zoomIn("window-1", BASE_KEY);
    expect(view.webContents.zoomFactor).toBe(1.1);

    emitAnnotationBinding(
      view,
      { type: "stateChanged", mode: "select", markCount: 2 },
      77,
    );
    harness.manager.resetZoom("window-1", BASE_KEY);
    expect(view.webContents.zoomFactor).toBe(1.1);

    emitAnnotationBinding(
      view,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();
    expect(harness.annotationAttached).toHaveLength(1);
    reportAttachResult(harness, "window-1", "attached");
    await flush();
    harness.manager.resetZoom("window-1", BASE_KEY);
    expect(view.webContents.zoomFactor).toBe(1);
  });

  it("keeps the bundle when attachResult reports failed", async () => {
    const harness = createHarness();
    const view = await upsertAndAttach(harness, "window-1", BASE_KEY);
    await expect(
      harness.manager.startAnnotation("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });
    emitAnnotationBinding(
      view,
      { type: "stateChanged", mode: "select", markCount: 1 },
      77,
    );
    emitAnnotationBinding(
      view,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();
    expect(harness.annotationAttached).toHaveLength(1);
    reportAttachResult(harness, "window-1", "failed");
    await flush();
    harness.manager.zoomIn("window-1", BASE_KEY);
    expect(view.webContents.zoomFactor).toBe(1);
  });

  it("resets the overlay when attachResult reports attached", async () => {
    const harness = createHarness();
    const view = await upsertAndAttach(harness, "window-1", BASE_KEY);
    await expect(
      harness.manager.startAnnotation("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });
    emitAnnotationBinding(
      view,
      { type: "stateChanged", mode: "select", markCount: 1 },
      77,
    );
    emitAnnotationBinding(
      view,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();
    expect(harness.annotationAttached).toHaveLength(1);
    reportAttachResult(harness, "window-1", "attached");
    await flush();
    harness.manager.zoomIn("window-1", BASE_KEY);
    expect(view.webContents.zoomFactor).toBe(1.1);
  });

  it("keeps the bundle when the attach ack times out", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const view = await upsertAndAttach(harness, "window-1", BASE_KEY);
      await expect(
        harness.manager.startAnnotation("window-1", BASE_KEY),
      ).resolves.toEqual({ ok: true });
      emitAnnotationBinding(
        view,
        { type: "stateChanged", mode: "select", markCount: 1 },
        77,
      );
      emitAnnotationBinding(
        view,
        { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
        77,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.annotationAttached).toHaveLength(1);
      harness.manager.zoomIn("window-1", BASE_KEY);
      expect(view.webContents.zoomFactor).toBe(1);
      await vi.runAllTimersAsync();
      harness.manager.zoomIn("window-1", BASE_KEY);
      expect(view.webContents.zoomFactor).toBe(1);
      reportAttachResult(harness, "window-1", "attached");
      await vi.advanceTimersByTimeAsync(0);
      harness.manager.zoomIn("window-1", BASE_KEY);
      expect(view.webContents.zoomFactor).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a late or unknown attachResult and a wrong-window ack", async () => {
    const harness = createHarness();
    const view = await upsertAndAttach(harness, "window-1", BASE_KEY);
    await expect(
      harness.manager.startAnnotation("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });
    emitAnnotationBinding(
      view,
      { type: "stateChanged", mode: "select", markCount: 1 },
      77,
    );
    emitAnnotationBinding(
      view,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();
    const annotationId = harness.annotationAttached[0]?.payload.annotationId;
    if (annotationId === undefined) {
      throw new Error("expected attached annotation id");
    }
    harness.manager.reportAnnotationAttachResult("window-1", {
      annotationId: "ann-unknown",
      status: "attached",
    });
    harness.manager.reportAnnotationAttachResult("window-2", {
      annotationId,
      status: "attached",
    });
    await flush();
    harness.manager.zoomIn("window-1", BASE_KEY);
    expect(view.webContents.zoomFactor).toBe(1);
    reportAttachResult(harness, "window-1", "failed");
    await flush();
    harness.manager.reportAnnotationAttachResult("window-1", {
      annotationId,
      status: "attached",
    });
    await flush();
    harness.manager.zoomIn("window-1", BASE_KEY);
    expect(view.webContents.zoomFactor).toBe(1);
  });

  it("fails a pending attach ack when the session ends", async () => {
    const harness = createHarness();
    const view = await upsertAndAttach(harness, "window-1", BASE_KEY);
    await expect(
      harness.manager.startAnnotation("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });
    emitAnnotationBinding(
      view,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();
    const annotationId = harness.annotationAttached[0]?.payload.annotationId;
    if (annotationId === undefined) {
      throw new Error("expected attached annotation id");
    }
    harness.manager.cancelAnnotation("window-1", BASE_KEY);
    await flush();
    await expect(
      harness.manager.startAnnotation("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });
    emitAnnotationBinding(
      view,
      { type: "stateChanged", mode: "select", markCount: 1 },
      77,
    );
    harness.manager.reportAnnotationAttachResult("window-1", {
      annotationId,
      status: "attached",
    });
    await flush();
    harness.manager.zoomIn("window-1", BASE_KEY);
    expect(view.webContents.zoomFactor).toBe(1);
  });
});

function reportAttachResult(
  harness: Harness,
  windowId: string,
  status: "attached" | "failed",
): void {
  const annotationId = harness.annotationAttached[0]?.payload.annotationId;
  if (annotationId === undefined) {
    throw new Error("expected attached annotation id");
  }
  harness.manager.reportAnnotationAttachResult(windowId, {
    annotationId,
    status,
  });
}
