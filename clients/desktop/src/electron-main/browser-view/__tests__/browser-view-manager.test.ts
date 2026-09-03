import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../../app/logger";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import { BrowserViewManager } from "../browser-view-manager";
import type {
  BrowserViewCapturedImage,
  BrowserViewFrameImage,
  BrowserViewDebugger,
  BrowserViewPopupWebContents,
  BrowserViewWebContents,
  BrowserViewWindow,
  ManagedBrowserView,
} from "../browser-view-port";
import type {
  BrowserViewCertificateErrorChange,
  BrowserViewDownloadChange,
  BrowserViewFindChange,
  BrowserViewNativeTabCapability,
  BrowserViewOpenTileRequest,
  BrowserViewNativeTabStatusChange,
  BrowserViewSnapshotInvalidatedChange,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import type { PipCaptureIpcPayload } from "../../../ipc-contracts/pip-capture-types";
import type {
  BrowserAnnotationAttachedIpcEvent,
  BrowserAnnotationSessionIpcEvent,
  BrowserAnnotationTheme,
} from "../../../ipc-contracts/browser-annotation-types";
import { ANNOTATION_BINDING_NAME } from "../annotation/browser-annotation-overlay-script";
import type {
  BrowserSessionCertificateErrorChange,
  BrowserSessionDownloadChange,
  BrowserSessionProfileRequest,
} from "../browser-session";

// The popup path hands non-http(s) targets to the OS through the app's
// scheme allowlist; mocking the seam keeps the assertion on "we delegated"
// rather than on Electron's `shell`.
const safelyOpenExternalMock = vi.hoisted(() =>
  vi.fn((_url: string) => Promise.resolve(true)),
);
vi.mock("../../app/security", () => ({
  safelyOpenExternal: safelyOpenExternalMock,
}));

type BrowserViewManagerOptions = ConstructorParameters<
  typeof BrowserViewManager
>[0];
type ManagedContentView = BrowserViewWindow["contentView"];

const TEST_ANNOTATION_THEME: BrowserAnnotationTheme = {
  appearance: "dark",
  background: "#111111",
  foreground: "#eeeeee",
  popover: "#222222",
  popoverForeground: "#eeeeee",
  mutedForeground: "#aaaaaa",
  border: "#444444",
  input: "#333333",
  ring: "#888888",
  primary: "#ffffff",
  primaryForeground: "#000000",
  accent: "#555555",
  accentForeground: "#ffffff",
  destructive: "#ff0000",
  warning: "#ffaa00",
  warningForeground: "#000000",
  fontFamily: "Inter",
};

const BASE_TILE_KEY: BrowserViewTileKey = {
  viewTabId: "view-tab-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-1",
};

const BASE_KEY = {
  ...BASE_TILE_KEY,
  theme: TEST_ANNOTATION_THEME,
};

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
  readonly session = {
    cookies: {
      get: () => Promise.resolve([]),
      set: () => Promise.resolve(),
      flushStore: () => Promise.resolve(),
    },
  };
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
  readonly frameSubscriptions: Array<(image: BrowserViewFrameImage) => void> =
    [];
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
    callback: (image: BrowserViewFrameImage) => void,
  ): void {
    this.frameSubscriptions.push(callback);
  }

  endFrameSubscription(): void {
    this.frameSubscriptionEnds += 1;
  }

  emitCompositorFrame(image: BrowserViewFrameImage | undefined): void {
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
      const empty: BrowserViewFrameImage = {
        getSize: () => ({ width: 0, height: 0 }),
        toJPEG: () => emptyBytes,
        toDataURL: () => "",
        isEmpty: () => true,
        crop: () => empty,
        resize: () => empty,
        toPNG: () => emptyBytes,
      };
      return Promise.resolve(empty);
    }
    return Promise.resolve(this.buildCaptureImage());
  }

  private buildCaptureImage(): BrowserViewFrameImage {
    // Real toJPEG results are Buffers; the frame-cache encoder relies on
    // Buffer#toString("base64"), so the fixture must be one too.
    const bytes: Buffer = Buffer.from([1, 2, 3]);
    const image: BrowserViewFrameImage = {
      getSize: () => ({ width: 320, height: 180 }),
      toJPEG: () => bytes,
      toDataURL: () => `data:image/png;base64,${this.id}`,
      isEmpty: () => false,
      crop: () => image,
      resize: () => image,
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

  focus(): void {}

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
  windowOpenHandler:
    | Parameters<BrowserViewPopupWebContents["setWindowOpenHandler"]>[0]
    | null = null;

  constructor(readonly id: number) {
    super();
  }

  once(event: "destroyed", listener: () => void): this {
    return super.once(event, listener);
  }

  setWindowOpenHandler(
    handler: Parameters<BrowserViewPopupWebContents["setWindowOpenHandler"]>[0],
  ): void {
    this.windowOpenHandler = handler;
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
  readonly nativeTabStatuses: BrowserViewNativeTabStatusChange[];
  readonly nativeTabStatusWindowIds: string[];
  readonly focusedTiles: BrowserViewTileKey[];
  readonly finds: BrowserViewFindChange[];
  readonly downloads: BrowserViewDownloadChange[];
  readonly certificateErrors: BrowserViewCertificateErrorChange[];
  readonly openTileRequests: BrowserViewOpenTileRequest[];
  readonly snapshotInvalidations: BrowserViewSnapshotInvalidatedChange[];
  readonly annotationEvents: BrowserAnnotationSessionIpcEvent[];
  readonly annotationAttached: BrowserAnnotationAttachedIpcEvent[];
  readonly rendererResetWindowIds: string[];
  readonly primaryProfileObservedUrls: string[];
  readonly releasedIsolatedSessions: BrowserSessionProfileRequest[];
  readonly viewProfileRequests: BrowserSessionProfileRequest[];
  readonly registeredPopupWebContents: BrowserViewPopupWebContents[];
  emitDownload(change: BrowserSessionDownloadChange): void;
  emitCertificateError(change: BrowserSessionCertificateErrorChange): void;
  emitWindowChange(): void;
  /** Re-zooms the app windows, as `WindowZoomController` does. */
  setZoomFactor(factor: number): void;
}

type HarnessOptions = {
  readonly boundsStreamLogIntervalMs?: number;
  readonly hostPlatform?: "darwin" | "other";
  readonly requireLoadedTargetForPageCommands?: boolean;
};

/**
 * `send` is channel-keyed and payload-agnostic by design, so the harness
 * re-narrows once per channel to keep assertions concretely typed.
 */
function asPayload<T>(payload: unknown): T {
  return payload as T;
}

function record<T>(sink: T[], payload: unknown): void {
  sink.push(asPayload<T>(payload));
}

function createHarness(): Harness {
  return createHarnessWithOptions(undefined);
}

/**
 * Every manager this file creates, so cleanup does not depend on any single
 * test reaching its own last line.
 *
 * A live PiP capture re-arms a real 200ms timer forever
 * (`BrowserPipCapture.captureFrame`); one left running outlives its test,
 * and once a LATER test installs fake timers the chain migrates into the
 * fake queue and spins `runAllTimersAsync` into vitest's 10000-timer abort.
 * An assertion failure between `startPipCapture` and an in-test stop would
 * resurrect exactly that leak - one failed test manufacturing a second,
 * flaky one - so the stop lives in an `afterEach` that covers every
 * PiP-starting path, current and future. `pip.stop()` is idempotent, so
 * stopping managers that never captured is a no-op.
 */
const createdManagers: BrowserViewManager[] = [];

afterEach(() => {
  for (const manager of createdManagers) manager.pip.stop();
  createdManagers.length = 0;
});

function createHarnessWithOptions(
  harnessOptions: HarnessOptions | undefined,
): Harness {
  const windows = new Map<string, FakeWindow>([
    ["window-1", new FakeWindow()],
    ["window-2", new FakeWindow()],
  ]);
  const views: FakeBrowserView[] = [];
  const nativeTabStatuses: BrowserViewNativeTabStatusChange[] = [];
  const nativeTabStatusWindowIds: string[] = [];
  const focusedTiles: BrowserViewTileKey[] = [];
  const finds: BrowserViewFindChange[] = [];
  const downloads: BrowserViewDownloadChange[] = [];
  const certificateErrors: BrowserViewCertificateErrorChange[] = [];
  const openTileRequests: BrowserViewOpenTileRequest[] = [];
  const snapshotInvalidations: BrowserViewSnapshotInvalidatedChange[] = [];
  const annotationEvents: BrowserAnnotationSessionIpcEvent[] = [];
  const annotationAttached: BrowserAnnotationAttachedIpcEvent[] = [];
  const rendererResetWindowIds: string[] = [];
  const primaryProfileObservedUrls: string[] = [];
  const releasedIsolatedSessions: BrowserSessionProfileRequest[] = [];
  const viewProfileRequests: BrowserSessionProfileRequest[] = [];
  const registeredPopupWebContents: BrowserViewPopupWebContents[] = [];
  const windowListeners = new Set<() => void>();
  const zoomListeners = new Set<() => void>();
  let zoomFactor = 1;
  const downloadListeners = new Set<
    (change: BrowserSessionDownloadChange) => void
  >();
  const certificateListeners = new Set<
    (change: BrowserSessionCertificateErrorChange) => void
  >();
  let nextWebContentsId = 1;
  const options: BrowserViewManagerOptions = {
    createView: (request) => {
      viewProfileRequests.push(request);
      const view = new FakeBrowserView(
        nextWebContentsId,
        harnessOptions?.requireLoadedTargetForPageCommands ?? false,
      );
      nextWebContentsId += 1;
      views.push(view);
      return view;
    },
    getWindow: (windowId) => windows.get(windowId) ?? null,
    getZoomFactor: () => zoomFactor,
    onZoomChange: (listener) => {
      zoomListeners.add(listener);
      return () => {
        zoomListeners.delete(listener);
      };
    },
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
    send: (windowId, channel, payload) => {
      switch (channel) {
        case RunnerHostEvent.browserViewNativeTabStatusChange:
          nativeTabStatusWindowIds.push(windowId);
          record(nativeTabStatuses, payload);
          return true;
        case RunnerHostEvent.browserViewFindChange:
          record(finds, payload);
          return true;
        case RunnerHostEvent.browserViewDownloadChange:
          record(downloads, payload);
          return true;
        case RunnerHostEvent.browserViewCertificateError:
          record(certificateErrors, payload);
          return true;
        case RunnerHostEvent.browserViewOpenTileRequest:
          record(openTileRequests, payload);
          return true;
        case RunnerHostEvent.browserViewTileFocused:
          record(focusedTiles, payload);
          return true;
        case RunnerHostEvent.browserViewSnapshotInvalidated:
          record(snapshotInvalidations, payload);
          return true;
        case RunnerHostEvent.browserViewAnnotationEvent:
          record(annotationEvents, payload);
          return true;
        case RunnerHostEvent.browserViewAnnotationAttached:
          record(annotationAttached, payload);
          return true;
        default:
          throw new Error(`unexpected browser-view channel: ${channel}`);
      }
    },
    // The real one validates and narrows; this harness is about the manager,
    // so it echoes what it was handed - the narrowing has its own suite.
    seedStorageState: (input) => Promise.resolve(input.seedStorageState),
    observePrimaryProfileOrigin: (url, _webContents, profile) => {
      if (profile !== "primary") return;
      primaryProfileObservedUrls.push(url);
    },
    releaseSessionStorage: (request) => {
      releasedIsolatedSessions.push(request);
    },
    boundsStreamLogIntervalMs:
      harnessOptions?.boundsStreamLogIntervalMs ?? 1000,
    hostPlatform: harnessOptions?.hostPlatform ?? "darwin",
  };
  const manager = new BrowserViewManager(options);
  createdManagers.push(manager);
  return {
    manager,
    windows,
    views,
    nativeTabStatuses,
    nativeTabStatusWindowIds,
    focusedTiles,
    finds,
    downloads,
    certificateErrors,
    openTileRequests,
    snapshotInvalidations,
    annotationEvents,
    annotationAttached,
    rendererResetWindowIds,
    primaryProfileObservedUrls,
    releasedIsolatedSessions,
    viewProfileRequests,
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
    setZoomFactor: (factor) => {
      zoomFactor = factor;
      for (const listener of zoomListeners) listener();
    },
  };
}

/** Flush the async closeEntry → native teardown chain. */
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

interface AttachedNativeTab {
  readonly bindingId: string;
  readonly capability: BrowserViewNativeTabCapability;
  readonly view: FakeBrowserView;
}

async function attachNativeTab(
  harness: Harness,
  windowId: string,
  key: BrowserViewTileKey,
  requestedUrl: string,
): Promise<AttachedNativeTab> {
  const capability = await harness.manager.ensureTab(windowId, {
    hostId: "host-1",
    sessionId: "session-1",
    tabId: key.pageSessionId,
    requestedUrl,
    profile: "primary",
    seedStorageState: null,
    connectionId: null,
  });
  await harness.manager.acceptTab(capability);
  const bindingId = `binding-${key.tileInstanceId}`;
  if (
    !harness.manager.attachSurface(windowId, {
      ...capability,
      bindingId,
      surface: key,
    })
  ) {
    throw new Error("expected native surface attachment");
  }
  harness.manager.updateBounds(windowId, {
    ...key,
    bounds: { x: 0, y: 0, width: 300, height: 200 },
  });
  const view = harness.views.at(-1);
  if (view === undefined) throw new Error("expected native guest");
  view.webContents.emit("did-navigate", {}, requestedUrl, 200, "OK");
  await Promise.resolve();
  return { bindingId, capability, view };
}

describe("BrowserViewManager primary profile observation", () => {
  it("observes each committed main-frame URL, and nothing a mere load emits", async () => {
    const harness = createHarness();
    const { view } = await attachNativeTab(
      harness,
      "window-1",
      BASE_KEY,
      "https://first.example/",
    );

    // `did-navigate` is the event the entry factory actually registers for a
    // committed main-frame navigation - the only path into the observation
    // plane.
    view.webContents.emit(
      "did-navigate",
      {},
      "https://second.example/",
      200,
      "OK",
    );
    await Promise.resolve();
    // A load finishing is not a commit and adds nothing.
    view.webContents.emit("did-finish-load");
    await Promise.resolve();

    expect(harness.primaryProfileObservedUrls).toEqual([
      "https://first.example/",
      "https://second.example/",
    ]);
  });
});

describe("BrowserViewManager isolated sessions", () => {
  const ISOLATED_SESSION = "session-private";

  function ensureIsolated(
    harness: Harness,
    tabId: string,
  ): Promise<BrowserViewNativeTabCapability> {
    return harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: ISOLATED_SESSION,
      tabId,
      requestedUrl: `https://example.com/${tabId}`,
      profile: "isolated",
      seedStorageState: null,
      connectionId: null,
    });
  }

  it("opens isolated guests on their own jar and releases it with the last tab", async () => {
    const harness = createHarness();
    const first = await ensureIsolated(harness, "tab-1");
    const second = await ensureIsolated(harness, "tab-2");
    await harness.manager.acceptTab(first);
    await harness.manager.acceptTab(second);

    // Both tabs of one isolated session share the one per-session partition.
    expect(harness.viewProfileRequests).toEqual([
      { profile: "isolated", sessionId: ISOLATED_SESSION },
      { profile: "isolated", sessionId: ISOLATED_SESSION },
    ]);

    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");
    // A real committed navigation, through the event the factory registers -
    // so what this pins is the profile filter, not a listener that was never
    // there.
    view.webContents.emit(
      "did-navigate",
      {},
      "https://private.example/",
      200,
      "OK",
    );
    await Promise.resolve();
    // The private jar is invisible to the primary-profile capture plane.
    expect(harness.primaryProfileObservedUrls).toEqual([]);

    await harness.manager.releaseTab(first);
    await flushCloseEntry();
    expect(harness.releasedIsolatedSessions).toEqual([]);

    await harness.manager.releaseTab(second);
    await flushCloseEntry();
    expect(harness.releasedIsolatedSessions).toEqual([
      { profile: "isolated", sessionId: ISOLATED_SESSION },
    ]);
  });

  it("keeps a primary session's shared jar when its last tab closes", async () => {
    const harness = createHarness();
    const capability = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-shared",
      tabId: "tab-1",
      requestedUrl: "https://example.com/shared",
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
    });
    await harness.manager.acceptTab(capability);

    await harness.manager.releaseTab(capability);
    await flushCloseEntry();

    expect(harness.releasedIsolatedSessions).toEqual([]);
  });
});

describe("BrowserViewManager native tab lifecycle", () => {
  it("notifies the owning renderer when an attached native guest receives focus", async () => {
    const harness = createHarness();
    const { view } = await attachNativeTab(
      harness,
      "window-1",
      BASE_KEY,
      "https://example.com/",
    );

    view.webContents.emit("focus");

    expect(harness.focusedTiles).toEqual([BASE_TILE_KEY]);
  });

  it("provisions CDP before acceptance and starts navigation only after acceptance", async () => {
    const harness = createHarnessWithOptions({
      requireLoadedTargetForPageCommands: true,
    });
    const provisioned = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/target",
      profile: "primary",
      seedStorageState: {
        cookies: [],
        origins: [
          {
            origin: "https://example.com",
            localStorage: [{ name: "token", value: "carried" }],
          },
        ],
      },
      connectionId: null,
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
    await Promise.resolve();

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
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
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
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
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
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
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

  // Root cause C: guests had no navigation policy at all - `installNavigationGuard`
  // covers the app shell only, so `file:`, `javascript:`, `data:` and the
  // `traycer:` app scheme were reachable from a tile. Both doors are pinned:
  // what this process is ASKED to navigate to, and what the page tries itself.
  it.each([
    ["file", "file:///etc/passwd"],
    ["javascript", "javascript:fetch('https://attacker.test')"],
    ["data", "data:text/html,<script>1</script>"],
    ["custom scheme", "traycer://internal/settings"],
  ])(
    "refuses a %s control-action navigation without touching the guest",
    async (_label, url) => {
      const harness = createHarness();
      const nativeKey = {
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
      } as const;
      const ready = await harness.manager.ensureTab("window-1", {
        ...nativeKey,
        requestedUrl: "https://example.com/",
        profile: "primary",
        seedStorageState: null,
        connectionId: null,
      });
      await harness.manager.acceptTab(ready);
      const view = harness.views[0];
      if (view === undefined) throw new Error("expected native guest");
      const loadedBefore = [...view.webContents.loadUrls];

      await expect(
        harness.manager.controlElectronTab("window-1", {
          ...nativeKey,
          registrationId: ready.registrationId,
          action: { kind: "navigate", url },
        }),
      ).rejects.toThrow("http, https or about:blank");

      expect(view.webContents.loadUrls).toEqual(loadedBefore);
    },
  );

  it.each([
    ["file", "file:///etc/passwd"],
    ["javascript", "javascript:fetch('https://attacker.test')"],
  ])("prevents a page-initiated %s navigation", async (_label, url) => {
    const harness = createHarness();
    const ready = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/",
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
    });
    await harness.manager.acceptTab(ready);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");
    let prevented = 0;
    const event = {
      preventDefault: (): void => {
        prevented += 1;
      },
    };

    view.webContents.emit("will-navigate", event, url);
    expect(prevented).toBe(1);

    view.webContents.emit("will-navigate", event, "https://example.com/next");
    expect(prevented).toBe(1);
  });

  it("refuses a cdpNavigate to a scheme a guest may not navigate to", async () => {
    const harness = createHarness();
    const nativeKey = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
    } as const;
    const ready = await harness.manager.ensureTab("window-1", {
      ...nativeKey,
      requestedUrl: "https://example.com/",
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
    });
    await harness.manager.acceptTab(ready);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");

    // The quietest door: `cdpNavigate` reaches `Page.navigate` directly, so it
    // sees neither `navigate()` nor `will-navigate`.
    await expect(
      harness.manager.dispatchElectronTabCdp({
        ...nativeKey,
        registrationId: ready.registrationId,
        target: { kind: "root" },
        command: { kind: "cdpNavigate", url: "file:///etc/passwd" },
      }),
    ).resolves.toMatchObject({
      kind: "cdpNavigate",
      ok: false,
      error: { kind: "cdp_error" },
    });
    expect(
      view.webContents.debugger.commands.filter(
        ({ method }) => method === "Page.navigate",
      ),
    ).toEqual([]);

    // And an allowed one still reaches CDP, so the gate is a scheme check and
    // not a disabled command.
    await harness.manager.dispatchElectronTabCdp({
      ...nativeKey,
      registrationId: ready.registrationId,
      target: { kind: "root" },
      command: { kind: "cdpNavigate", url: "https://example.com/next" },
    });
    expect(
      view.webContents.debugger.commands.filter(
        ({ method }) => method === "Page.navigate",
      ),
    ).toMatchObject([{ params: { url: "https://example.com/next" } }]);
  });

  it("denies a window.open to a scheme a guest may not navigate to", async () => {
    const harness = createHarness();
    const { view } = await attachNativeTab(
      harness,
      "window-1",
      BASE_TILE_KEY,
      "https://example.com/",
    );
    const open = view.webContents.windowOpenHandler;
    if (open === undefined || open === null) {
      throw new Error("expected a window-open handler");
    }

    expect(
      open({
        url: "file:///etc/passwd",
        frameName: "_blank",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toEqual({ action: "deny" });
    // Denied, and it did not become a tile either: both outcomes of this
    // handler carry the target onward, so the gate has to sit ahead of both.
    expect(harness.openTileRequests).toEqual([]);

    // A relative open still resolves against the opener and is allowed.
    open({
      url: "/next",
      frameName: "_blank",
      features: "",
      disposition: "foreground-tab",
    });
    expect(harness.openTileRequests).toEqual([
      {
        ...BASE_TILE_KEY,
        url: "https://example.com/next",
        disposition: "foreground",
      },
    ]);
  });
  it("guards a popup's own navigation and window.open", async () => {
    const harness = createHarness();
    const { view } = await attachNativeTab(
      harness,
      "window-1",
      BASE_TILE_KEY,
      "https://example.com/",
    );
    const popup = new FakePopupWindow(999);

    view.webContents.emit("did-create-window", popup);

    // A popup shares the opener's jar, so `window.open()` then
    // `location = "file:///..."` would otherwise walk around every gate.
    let prevented = 0;
    popup.webContents.emit(
      "will-navigate",
      {
        preventDefault: (): void => {
          prevented += 1;
        },
      },
      "file:///etc/passwd",
    );
    expect(prevented).toBe(1);
    expect(
      popup.webContents.windowOpenHandler?.({
        url: "file:///etc/passwd",
        frameName: "_blank",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toEqual({ action: "deny" });
    expect(harness.openTileRequests).toEqual([]);
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
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
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
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
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
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
    } as const;
    const ready = await harness.manager.ensureTab("window-1", ensureInput);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");
    await harness.manager.acceptTab(ready);

    await harness.manager.ensureTab("window-2", ensureInput);
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
      }),
    ).toBe(true);
    expect(harness.nativeTabStatusWindowIds.at(-1)).toBe("window-2");

    harness.manager.dispose();
    await flushCloseEntry();
    expect(view.webContents.closeCalls).toBe(1);
  });

  it("transfers a provisioning tab's lifecycle lease before awaiting readiness", async () => {
    const harness = createHarness();
    const ensureInput = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/",
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
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
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
    } as const;
    const provisioned = await harness.manager.ensureTab("window-1", input);
    const view = harness.views[0];
    if (view === undefined) throw new Error("expected native guest");
    await harness.manager.acceptTab(provisioned);
    view.webContents.emit(
      "did-navigate",
      {},
      "https://example.com/",
      200,
      "OK",
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

  it("transfers one native guest only after its exact surface binding detaches", async () => {
    const harness = createHarness();
    const nativeKey = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
    } as const;
    const ensureInput = {
      ...nativeKey,
      requestedUrl: "https://example.com/",
      profile: "primary" as const,
      seedStorageState: null,
      connectionId: null,
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
      }),
    ).toBe(false);
    expect(harness.views).toHaveLength(1);
    expect(harness.windows.get("window-1")?.contentView.children).toContain(
      view,
    );
    expect(harness.windows.get("window-2")?.contentView.children).not.toContain(
      view,
    );

    expect(
      harness.manager.detachSurface("window-2", {
        ...nativeKey,
        registrationId: firstReady.registrationId,
        bindingId: "binding-1",
      }),
    ).toBe(false);
    expect(
      harness.manager.detachSurface("window-1", {
        ...nativeKey,
        registrationId: firstReady.registrationId,
        bindingId: "binding-2",
      }),
    ).toBe(false);
    expect(
      harness.manager.detachSurface("window-1", {
        ...nativeKey,
        registrationId: firstReady.registrationId,
        bindingId: "binding-1",
      }),
    ).toBe(true);

    expect(
      harness.manager.attachSurface("window-2", {
        ...nativeKey,
        registrationId: firstReady.registrationId,
        bindingId: "binding-2",
        surface: movedSurface,
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

  it("gives a re-ensure of a released identity a fresh incarnation, never the destroyed guest", async () => {
    const harness = createHarness();
    const input = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/",
      profile: "primary" as const,
      seedStorageState: null,
      connectionId: null,
    };
    const ready = await harness.manager.ensureTab("window-1", input);
    await harness.manager.acceptTab(ready);
    const firstView = harness.views[0];
    if (firstView === undefined) throw new Error("expected native guest");

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

    // Destroying a guest is ATOMIC: the incarnation leaves the registry in the
    // same turn the first release claims it, so only the first release finds
    // one and the duplicate reports `false`.
    await expect(
      Promise.all([firstRelease, duplicateRelease]),
    ).resolves.toEqual([true, false]);
    const replaced = await replacement;
    expect(replaced).toMatchObject({
      hostId: input.hostId,
      sessionId: input.sessionId,
      tabId: input.tabId,
    });
    // The durable identity is reused; the native incarnation behind it is not.
    // A re-ensure that restored the destroyed guest is the failure this
    // guards - the entry must be gone from the registry, not merely marked.
    expect(replaced.registrationId).not.toBe(ready.registrationId);
    expect(firstView.webContents.closeCalls).toBe(1);
    expect(harness.views).toHaveLength(2);
  });

  it("closes only the native sessions owned by the closing window", async () => {
    const harness = createHarness();
    const closing = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-closing",
      tabId: "tab-closing",
      requestedUrl: "https://example.com/closing",
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
    });
    const remaining = await harness.manager.ensureTab("window-2", {
      hostId: "host-1",
      sessionId: "session-remaining",
      tabId: "tab-remaining",
      requestedUrl: "https://example.com/remaining",
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
    });
    // One SHARED session with a tab bound to each window - the regression
    // this method exists to fix. The old code widened from one matching guest
    // to that guest's whole session across every window, so closing window-1
    // would have destroyed window-2's live tab of the same session too.
    const sharedInWindow1 = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-shared",
      tabId: "tab-shared-window-1",
      requestedUrl: "https://example.com/shared-1",
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
    });
    const sharedInWindow2 = await harness.manager.ensureTab("window-2", {
      hostId: "host-1",
      sessionId: "session-shared",
      tabId: "tab-shared-window-2",
      requestedUrl: "https://example.com/shared-2",
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
    });
    await harness.manager.acceptTab(closing);
    await harness.manager.acceptTab(remaining);
    await harness.manager.acceptTab(sharedInWindow1);
    await harness.manager.acceptTab(sharedInWindow2);

    expect(harness.manager.hasNativeTabsForWindow("window-1")).toBe(true);
    expect(harness.manager.hasNativeTabsForWindow("window-2")).toBe(true);

    await harness.manager.closeNativeSessionsForWindow("window-1");
    expect(harness.views[0]?.webContents.closeCalls).toBe(1);
    expect(harness.views[1]?.webContents.closeCalls).toBe(0);
    // The shared session's window-1 guest closes with the rest of window-1's
    // guests; its window-2 sibling - same sessionId, different tabId and
    // window - must survive untouched.
    expect(harness.views[2]?.webContents.closeCalls).toBe(1);
    expect(harness.views[3]?.webContents.closeCalls).toBe(0);
    expect(harness.manager.hasNativeTabsForWindow("window-1")).toBe(false);
    expect(harness.manager.hasNativeTabsForWindow("window-2")).toBe(true);
    harness.manager.dispose();
    await flushCloseEntry();
  });

  it("recreates only accepted primary guests when the saved-logins jar changes", async () => {
    // The re-placement mechanism is the teardown itself: the host suspends the
    // session to dormant and re-materializes the same durable tab on whichever
    // jar the pref now names. An isolated guest's jar is throwaway and never
    // reaches the persistent partition, and an unaccepted guest has no durable
    // route to be revived through - tearing either down would only destroy a
    // session nothing brings back.
    const harness = createHarness();
    const accepted = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "primary-tab",
      requestedUrl: "https://example.com/",
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
    });
    await harness.manager.acceptTab(accepted);
    const isolated = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-2",
      tabId: "isolated-tab",
      requestedUrl: "https://example.com/private",
      profile: "isolated",
      seedStorageState: null,
      connectionId: null,
    });
    await harness.manager.acceptTab(isolated);
    await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "provisional-tab",
      requestedUrl: "https://example.com/provisional",
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
    });

    const migrated =
      await harness.manager.recreateNativeTabsOnCurrentPartition();
    await flushCloseEntry();

    expect(migrated).toHaveLength(1);
    expect(harness.views.map((view) => view.webContents.closeCalls)).toEqual([
      1, 0, 0,
    ]);
    harness.manager.dispose();
  });

  it("destroys every guest on dispose, accepted or still provisional", async () => {
    const harness = createHarness();
    const accepted = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "accepted-tab",
      requestedUrl: "https://example.com/accepted",
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
    });
    await harness.manager.acceptTab(accepted);
    await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "provisional-tab",
      requestedUrl: "https://example.com/provisional",
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
    });

    harness.manager.dispose();
    await flushCloseEntry();

    // Native teardown only: the host suspends the session to dormant when the
    // route goes away, so nothing here reports a durable tab as closed.
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
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
    });
    const accepted = await harness.manager.ensureTab("window-1", {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "accepted-tab",
      requestedUrl: "https://example.com/accepted",
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
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
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
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

  it("presents an overlay-parked tile offscreen for PiP capture", async () => {
    // Regression: PiP read `lastLoggedVisible`, a log-dedup latch that
    // `applyEntryVisibility` never updates on the overlay-parked path, so a
    // parked tile whose last LOG said "visible" skipped offscreen
    // presentation entirely and captured an empty NativeImage.
    const harness = createHarness();
    const { capability, view } = await attachNativeTab(
      harness,
      "window-1",
      BASE_KEY,
      "https://example.com/",
    );
    await harness.manager.overlay.occlude("window-1", {
      overlayId: "settings-dialog",
      tiles: [BASE_KEY],
    });
    harness.manager.overlay.paintAck("settings-dialog");
    const boundsBeforeCapture = view.bounds.length;

    await expect(
      harness.manager.startPipCapture(
        "window-1",
        {
          ...capability,
          maxWidth: 640,
          maxHeight: 360,
          quality: 75,
        },
        () => undefined,
      ),
    ).resolves.toBe(true);

    expect(view.bounds.slice(boundsBeforeCapture)).toEqual([
      { x: -300, y: -200, width: 300, height: 200 },
    ]);
    expect(view.visible).toBe(true);

    harness.manager.pip.stop();
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
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
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

    harness.manager.pip.stop();

    expect(harness.windows.get("window-1")?.contentView.children).not.toContain(
      view,
    );
    expect(view.visible).toBe(false);
  });
});

describe("BrowserViewManager host window renderer reset (fix round 2)", () => {
  function makeVisible(
    harness: Harness,
    key: BrowserViewTileKey,
  ): Promise<AttachedNativeTab> {
    return attachNativeTab(harness, "window-1", key, "https://example.com");
  }

  it("hides every entry on that window when the host renderer starts a fresh main-frame navigation", async () => {
    const harness = createHarness();
    const { view } = await makeVisible(harness, BASE_KEY);
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

  it("hides an entry when renderer reset races an overlay paint acknowledgement", async () => {
    const harness = createHarness();
    const { view } = await makeVisible(harness, BASE_KEY);
    await harness.manager.overlay.occlude("window-1", {
      overlayId: "settings-dialog",
      tiles: [BASE_KEY],
    });
    expect(view.visible).toBe(true);

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
    harness.manager.overlay.release({ overlayId: "settings-dialog" });
    expect(view.visible).toBe(false);
  });

  it("ignores same-document and non-main-frame navigations on the host window", async () => {
    const harness = createHarness();
    const { view } = await makeVisible(harness, BASE_KEY);

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

  it("hides every entry on that window when the host renderer crashes", async () => {
    const harness = createHarness();
    const { view } = await makeVisible(harness, BASE_KEY);

    const hostWebContents = harness.windows.get("window-1")?.webContents;
    if (hostWebContents === undefined) throw new Error("expected host window");
    hostWebContents.emit("render-process-gone", {}, { reason: "crashed" });

    expect(view.visible).toBe(false);
  });
  it("reattaching the tab clears the reset and makes it visible again", async () => {
    const harness = createHarness();
    const { capability, view } = await makeVisible(harness, BASE_KEY);

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

    expect(
      harness.manager.attachSurface("window-1", {
        ...capability,
        bindingId: "binding-after-reset",
        surface: BASE_KEY,
      }),
    ).toBe(true);
    expect(view.visible).toBe(true);
  });

  it("does not re-show a stale entry that was never reattached", async () => {
    const harness = createHarness();
    const { view } = await makeVisible(harness, BASE_KEY);

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
  it("does not log a no-match warning when this manager owns the requested tile", async () => {
    const harness = createHarness();
    await attachNativeTab(
      harness,
      "window-1",
      BASE_KEY,
      "http://localhost:3000",
    );
    const infoSpy = vi.spyOn(log, "info");

    await harness.manager.overlay.occlude("window-1", {
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
  function attachAnnotationTab(harness: Harness): Promise<AttachedNativeTab> {
    return attachNativeTab(
      harness,
      "window-1",
      BASE_KEY,
      "http://localhost:3000",
    );
  }

  async function controlAnnotationZoom(
    harness: Harness,
    capability: BrowserViewNativeTabCapability,
    kind: "resetZoom" | "zoomIn",
  ): Promise<void> {
    await expect(
      harness.manager.controlElectronTab("window-1", {
        ...capability,
        action: { kind },
      }),
    ).resolves.toBe(true);
  }

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
    const { view } = await attachAnnotationTab(harness);
    expect(view.webContents.debugger.attached).toBe(true);

    await expect(
      harness.manager.annotations.start("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });
    expect(
      harness.views[0]?.webContents.debugger.commands.some(
        (command) =>
          command.method === "Runtime.evaluate" &&
          String(command.params.expression).includes(
            TEST_ANNOTATION_THEME.background,
          ),
      ),
    ).toBe(true);
    expect(annotationBindingCommands(view)).toEqual(["Runtime.addBinding"]);
    expect(annotationEventTypes(harness)).toEqual([]);
  });

  it("replaces an active session on a second startAnnotation", async () => {
    const harness = createHarness();
    const { view } = await attachAnnotationTab(harness);

    await expect(
      harness.manager.annotations.start("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });
    await expect(
      harness.manager.annotations.start("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });

    expect(annotationBindingCommands(view)).toEqual([
      "Runtime.addBinding",
      "Runtime.removeBinding",
      "Runtime.addBinding",
    ]);
    expect(annotationEventTypes(harness)).toEqual([
      { type: "ended", reason: "replaced" },
    ]);
    expect(harness.annotationEvents[0]).toMatchObject(BASE_TILE_KEY);
  });

  it("tears down on reload, navigation, crash, debugger detach, release, and cancel", async () => {
    const reloadHarness = createHarness();
    const { capability: reloadCapability, view: reloadView } =
      await attachAnnotationTab(reloadHarness);
    await reloadHarness.manager.annotations.start("window-1", BASE_KEY);
    await reloadHarness.manager.controlElectronTab("window-1", {
      ...reloadCapability,
      action: { kind: "reload" },
    });
    expect(annotationBindingCommands(reloadView)).toEqual([
      "Runtime.addBinding",
      "Runtime.removeBinding",
    ]);
    expect(annotationEventTypes(reloadHarness)).toEqual([
      { type: "ended", reason: "reload" },
    ]);

    const navHarness = createHarness();
    const { view: navView } = await attachAnnotationTab(navHarness);
    await navHarness.manager.annotations.start("window-1", BASE_KEY);
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
    const { view: crashView } = await attachAnnotationTab(crashHarness);
    await crashHarness.manager.annotations.start("window-1", BASE_KEY);
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
    const { view: detachView } = await attachAnnotationTab(detachHarness);
    await detachHarness.manager.annotations.start("window-1", BASE_KEY);
    detachView.webContents.debugger.emitDetach("target closed");
    expect(annotationBindingCommands(detachView)).toEqual([
      "Runtime.addBinding",
    ]);
    expect(annotationEventTypes(detachHarness)).toEqual([
      { type: "ended", reason: "crash" },
    ]);

    const releaseHarness = createHarness();
    const {
      bindingId: releaseBindingId,
      capability: releaseCapability,
      view: releaseView,
    } = await attachAnnotationTab(releaseHarness);
    await releaseHarness.manager.annotations.start("window-1", BASE_KEY);
    expect(
      releaseHarness.manager.detachSurface("window-1", {
        ...releaseCapability,
        bindingId: releaseBindingId,
      }),
    ).toBe(true);
    expect(annotationBindingCommands(releaseView)).toEqual([
      "Runtime.addBinding",
      "Runtime.removeBinding",
    ]);
    expect(annotationEventTypes(releaseHarness)).toEqual([
      { type: "ended", reason: "tile-close" },
    ]);

    const cancelHarness = createHarness();
    const { view: cancelView } = await attachAnnotationTab(cancelHarness);
    await cancelHarness.manager.annotations.start("window-1", BASE_KEY);
    cancelHarness.manager.annotations.cancel("window-1", BASE_KEY);
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
    const { view } = await attachAnnotationTab(harness);
    await expect(
      harness.manager.annotations.start("window-1", BASE_KEY),
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
    expect(attached).toMatchObject(BASE_TILE_KEY);
  });

  it("emits no annotationAttached on empty capture and leaves the session cancellable", async () => {
    const harness = createHarness();
    const { view } = await attachAnnotationTab(harness);
    view.webContents.emptyCapture = true;
    await expect(
      harness.manager.annotations.start("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });

    emitAnnotationBinding(
      view,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();

    expect(harness.annotationAttached).toEqual([]);

    harness.manager.annotations.cancel("window-1", BASE_KEY);
    expect(annotationEventTypes(harness)).toEqual([{ type: "cancelled" }]);
  });

  it("ends the annotation session on page-initiated main-frame navigation", async () => {
    const harness = createHarness();
    const { view } = await attachAnnotationTab(harness);
    await expect(
      harness.manager.annotations.start("window-1", BASE_KEY),
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
      "did-navigate",
      {},
      "http://localhost:3000/next",
      200,
      "OK",
    );
    expect(annotationEventTypes(harness)).toEqual([
      { type: "ended", reason: "navigation" },
    ]);
  });

  it("does not emit annotationAttached when navigation starts during capturePage", async () => {
    const harness = createHarness();
    const { view } = await attachAnnotationTab(harness);
    view.webContents.deferCaptures = true;
    await expect(
      harness.manager.annotations.start("window-1", BASE_KEY),
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
    const { capability, view } = await attachAnnotationTab(harness);
    await expect(
      harness.manager.annotations.start("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });

    emitAnnotationBinding(
      view,
      { type: "stateChanged", mode: "select", markCount: 1 },
      77,
    );
    const preventDefault = vi.fn();
    await controlAnnotationZoom(harness, capability, "zoomIn");
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
    await controlAnnotationZoom(harness, capability, "zoomIn");
    expect(view.webContents.zoomFactor).toBe(1.1);

    emitAnnotationBinding(
      view,
      { type: "stateChanged", mode: "select", markCount: 2 },
      77,
    );
    await controlAnnotationZoom(harness, capability, "resetZoom");
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
    await controlAnnotationZoom(harness, capability, "resetZoom");
    expect(view.webContents.zoomFactor).toBe(1);
  });

  it("keeps the bundle when attachResult reports failed", async () => {
    const harness = createHarness();
    const { capability, view } = await attachAnnotationTab(harness);
    await expect(
      harness.manager.annotations.start("window-1", BASE_KEY),
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
    await controlAnnotationZoom(harness, capability, "zoomIn");
    expect(view.webContents.zoomFactor).toBe(1);
  });

  it("resets the overlay when attachResult reports attached", async () => {
    const harness = createHarness();
    const { capability, view } = await attachAnnotationTab(harness);
    await expect(
      harness.manager.annotations.start("window-1", BASE_KEY),
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
    await controlAnnotationZoom(harness, capability, "zoomIn");
    expect(view.webContents.zoomFactor).toBe(1.1);
  });

  it("keeps the bundle when the attach ack times out", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const { capability, view } = await attachAnnotationTab(harness);
      await expect(
        harness.manager.annotations.start("window-1", BASE_KEY),
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
      await controlAnnotationZoom(harness, capability, "zoomIn");
      expect(view.webContents.zoomFactor).toBe(1);
      await vi.runAllTimersAsync();
      await controlAnnotationZoom(harness, capability, "zoomIn");
      expect(view.webContents.zoomFactor).toBe(1);
      reportAttachResult(harness, "window-1", "attached");
      await vi.advanceTimersByTimeAsync(0);
      await controlAnnotationZoom(harness, capability, "zoomIn");
      expect(view.webContents.zoomFactor).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a late or unknown attachResult and a wrong-window ack", async () => {
    const harness = createHarness();
    const { capability, view } = await attachAnnotationTab(harness);
    await expect(
      harness.manager.annotations.start("window-1", BASE_KEY),
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
    harness.manager.annotations.reportAttachResult("window-1", {
      annotationId: "ann-unknown",
      status: "attached",
    });
    harness.manager.annotations.reportAttachResult("window-2", {
      annotationId,
      status: "attached",
    });
    await flush();
    await controlAnnotationZoom(harness, capability, "zoomIn");
    expect(view.webContents.zoomFactor).toBe(1);
    reportAttachResult(harness, "window-1", "failed");
    await flush();
    harness.manager.annotations.reportAttachResult("window-1", {
      annotationId,
      status: "attached",
    });
    await flush();
    await controlAnnotationZoom(harness, capability, "zoomIn");
    expect(view.webContents.zoomFactor).toBe(1);
  });

  it("fails a pending attach ack when the session ends", async () => {
    const harness = createHarness();
    const { capability, view } = await attachAnnotationTab(harness);
    await expect(
      harness.manager.annotations.start("window-1", BASE_KEY),
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
    harness.manager.annotations.cancel("window-1", BASE_KEY);
    await flush();
    await expect(
      harness.manager.annotations.start("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });
    emitAnnotationBinding(
      view,
      { type: "stateChanged", mode: "select", markCount: 1 },
      77,
    );
    harness.manager.annotations.reportAttachResult("window-1", {
      annotationId,
      status: "attached",
    });
    await flush();
    await controlAnnotationZoom(harness, capability, "zoomIn");
    expect(view.webContents.zoomFactor).toBe(1);
  });

  it("ends an annotation session when its native guest moves to another surface", async () => {
    const harness = createHarness();
    const { bindingId, capability, view } = await attachAnnotationTab(harness);
    await expect(
      harness.manager.annotations.start("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });
    emitAnnotationBinding(
      view,
      { type: "attachRequested", payload: VALID_ATTACH_PAYLOAD },
      77,
    );
    await flush();
    const movedKey = { ...BASE_KEY, paneId: "pane-2" };

    expect(
      harness.manager.attachSurface("window-1", {
        ...capability,
        bindingId,
        surface: movedKey,
      }),
    ).toBe(true);
    await flush();

    expect(annotationEventTypes(harness)).toContainEqual({
      type: "ended",
      reason: "tile-close",
    });
    await expect(
      harness.manager.annotations.start("window-1", movedKey),
    ).resolves.toEqual({ ok: true });
  });

  it("ends an annotation session when the host renderer reloads", async () => {
    const harness = createHarness();
    await attachAnnotationTab(harness);
    await expect(
      harness.manager.annotations.start("window-1", BASE_KEY),
    ).resolves.toEqual({ ok: true });
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

    expect(annotationEventTypes(harness)).toContainEqual({
      type: "ended",
      reason: "reload",
    });
  });
});

describe("BrowserViewManager visibility reconcile on window loss", () => {
  it("reports viewed:false the moment a visible tab's window disappears, and stays silent on the next reconcile", async () => {
    const harness = createHarness();
    await attachNativeTab(
      harness,
      "window-1",
      BASE_KEY,
      "https://example.com/",
    );
    const statusesBeforeLoss = harness.nativeTabStatuses.length;
    expect(harness.nativeTabStatuses.at(-1)?.viewed).toBe(true);

    // The window this tile was parented to is gone (closed/destroyed) -
    // reconcileVisibility must notice on the very next window-change pass.
    harness.windows.delete("window-1");
    harness.emitWindowChange();

    const statusesAfterFirstReconcile = harness.nativeTabStatuses.length;
    expect(statusesAfterFirstReconcile).toBe(statusesBeforeLoss + 1);
    expect(harness.nativeTabStatuses.at(-1)?.viewed).toBe(false);

    // A reconcile over an entry that is ALREADY hidden must not re-emit -
    // this runs on every window-change, and a status per pass would flood
    // the renderer with no new information.
    harness.emitWindowChange();
    expect(harness.nativeTabStatuses.length).toBe(statusesAfterFirstReconcile);
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
  harness.manager.annotations.reportAttachResult(windowId, {
    annotationId,
    status,
  });
}

describe("BrowserViewManager tile geometry under page zoom", () => {
  it("scales renderer CSS rects into window DIPs before applying them", async () => {
    const harness = createHarness();
    harness.setZoomFactor(1.5);
    const { view } = await attachNativeTab(
      harness,
      "window-1",
      BASE_KEY,
      "https://example.com/",
    );

    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 100, y: 40, width: 300, height: 200 },
    });

    expect(view.bounds.at(-1)).toEqual({
      x: 150,
      y: 60,
      width: 450,
      height: 300,
    });
  });

  it("re-derives every tile from its stored CSS rect when zoom changes", async () => {
    const harness = createHarness();
    const { view } = await attachNativeTab(
      harness,
      "window-1",
      BASE_KEY,
      "https://example.com/",
    );
    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 100, y: 40, width: 300, height: 200 },
    });
    expect(view.bounds.at(-1)).toEqual({
      x: 100,
      y: 40,
      width: 300,
      height: 200,
    });

    // No new renderer measurement: the zoom change alone must move the view.
    harness.setZoomFactor(2);

    expect(view.bounds.at(-1)).toEqual({
      x: 200,
      y: 80,
      width: 600,
      height: 400,
    });
  });

  it("hides a tile whose CSS sliver rounds away to a zero-width native rect", async () => {
    // A positive CSS width is not a usable rect: it rounds to 0 DIP, so
    // `applyBounds` rejects it and the guest would keep painting full-size.
    const harness = createHarness();
    const { view } = await attachNativeTab(
      harness,
      "window-1",
      BASE_KEY,
      "https://example.com/",
    );
    const boundsBefore = view.bounds.length;

    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 120, y: 40, width: 0.4, height: 200 },
    });

    expect(view.bounds).toHaveLength(boundsBefore);
    expect(view.visible).toBe(false);
  });

  it("sizes an unbound PiP capture surface in DIPs, not zoomed CSS pixels", async () => {
    const harness = createHarness();
    harness.setZoomFactor(1.5);
    const nativeKey = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
    } as const;
    const ready = await harness.manager.ensureTab("window-1", {
      ...nativeKey,
      requestedUrl: "https://example.com/",
      profile: "primary",
      seedStorageState: null,
      connectionId: null,
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

    expect(view.bounds.at(-1)).toEqual({
      x: -640,
      y: -360,
      width: 640,
      height: 360,
    });

    harness.manager.pip.stop();
  });

  it("hides a tile the renderer reports as fully clipped away", async () => {
    const harness = createHarness();
    const { view } = await attachNativeTab(
      harness,
      "window-1",
      BASE_KEY,
      "https://example.com/",
    );
    const boundsBefore = view.bounds.length;

    harness.manager.updateBounds("window-1", {
      ...BASE_KEY,
      bounds: { x: 120, y: 900, width: 0, height: 0 },
    });

    expect(view.bounds).toHaveLength(boundsBefore);
    expect(view.visible).toBe(false);
  });
});

describe("BrowserViewManager in-page window.open (Decision #22)", () => {
  interface OpenedWindow {
    readonly result: { readonly action: string };
    readonly openTileRequests: readonly BrowserViewOpenTileRequest[];
  }

  async function openWindow(
    disposition: string,
    url: string,
    features: string,
  ): Promise<OpenedWindow> {
    const harness = createHarness();
    const { view } = await attachNativeTab(
      harness,
      "window-1",
      BASE_KEY,
      "https://opener.example/",
    );
    const handler = view.webContents.windowOpenHandler;
    if (handler === null) throw new Error("expected a window-open handler");
    const result = handler({
      url,
      frameName: features.length > 0 ? "popup" : "_blank",
      features,
      disposition,
    });
    return { result, openTileRequests: harness.openTileRequests };
  }

  beforeEach(() => {
    safelyOpenExternalMock.mockClear();
  });

  it("maps Chromium's background-tab disposition onto the tile request", async () => {
    const opened = await openWindow(
      "background-tab",
      "https://target.example/a",
      "",
    );
    expect(opened.result.action).toBe("deny");
    expect(opened.openTileRequests).toEqual([
      {
        ...BASE_TILE_KEY,
        url: "https://target.example/a",
        disposition: "background",
      },
    ]);
  });

  it("treats every other disposition as foreground", async () => {
    const opened = await openWindow(
      "foreground-tab",
      "https://target.example/b",
      "",
    );
    expect(opened.openTileRequests[0]?.disposition).toBe("foreground");
  });

  it("rejects a non-http(s) target and sends no tile request", async () => {
    const opened = await openWindow("foreground-tab", "mailto:a@b.example", "");
    expect(opened.result.action).toBe("deny");
    expect(opened.openTileRequests).toEqual([]);
    expect(safelyOpenExternalMock).not.toHaveBeenCalled();
  });

  it("keeps an about:blank open in the session as a tile", async () => {
    // A page can mint a blank tab and navigate it itself.
    const opened = await openWindow("foreground-tab", "", "");
    expect(opened.result.action).toBe("deny");
    expect(opened.openTileRequests).toEqual([
      {
        ...BASE_TILE_KEY,
        url: "about:blank",
        disposition: "foreground",
      },
    ]);
    expect(safelyOpenExternalMock).not.toHaveBeenCalled();
  });

  it("leaves a real popup (non-empty features) as a native window", async () => {
    const opened = await openWindow(
      "new-window",
      "https://target.example/popup",
      "width=400,height=300",
    );
    expect(opened.result).toMatchObject({
      action: "allow",
      outlivesOpener: false,
    });
    expect(opened.openTileRequests).toEqual([]);
    expect(safelyOpenExternalMock).not.toHaveBeenCalled();
  });

  it("reapplies the popup policy recursively without duplicate listeners", async () => {
    const harness = createHarness();
    const { view } = await attachNativeTab(
      harness,
      "window-1",
      BASE_KEY,
      "https://opener.example/",
    );
    const popup = new FakePopupWindow(101);
    view.webContents.emit("did-create-window", popup);

    const popupHandler = popup.webContents.windowOpenHandler;
    expect(popupHandler).toEqual(expect.any(Function));
    const popupOpenTileListeners =
      popup.webContents.listenerCount("did-create-window");
    expect(popupOpenTileListeners).toBe(1);

    const nestedPopup = new FakePopupWindow(102);
    popup.webContents.emit("did-create-window", nestedPopup);
    expect(nestedPopup.webContents.windowOpenHandler).toEqual(
      expect.any(Function),
    );
    expect(nestedPopup.webContents.listenerCount("did-create-window")).toBe(1);

    const nestedPopupHandler = nestedPopup.webContents.windowOpenHandler;
    if (nestedPopupHandler === null) {
      throw new Error("expected recursive popup window-open handler");
    }
    expect(
      nestedPopupHandler({
        url: "https://target.example/tile",
        frameName: "_blank",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toEqual({ action: "deny" });
    expect(harness.openTileRequests).toContainEqual({
      ...BASE_TILE_KEY,
      url: "https://target.example/tile",
      disposition: "foreground",
    });

    // A repeated did-create-window delivery for the same native child must
    // not register another handler or closed listener.
    view.webContents.emit("did-create-window", popup);
    expect(popup.webContents.listenerCount("did-create-window")).toBe(
      popupOpenTileListeners,
    );
    expect(popup.webContents.windowOpenHandler).toBe(popupHandler);
  });
});
