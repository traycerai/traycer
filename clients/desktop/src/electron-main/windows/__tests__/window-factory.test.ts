import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  appPath: "/desktop-app",
  browserWindowOptions: [] as unknown[],
  webContentsOnChannels: [] as string[],
}));

// The renderer-load branch keys off the deploy slot (`config.isDevBuild`),
// not `app.isPackaged`: dev → Vite dev server, shipped → `app://`.
// DevTools have their own production-only policy so staging can keep the
// inspector while still using shipped renderer/runtime wiring.
const configState = vi.hoisted(() => ({
  isDevBuild: true,
  canOpenDevTools: true,
}));

vi.mock("@sentry/electron/main", () => ({
  init: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: (): string => electronState.appPath,
    getPath: (): string => "/tmp/traycer-user-data",
    on: vi.fn(),
  },
  BrowserWindow: class {
    readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      on: (channel: string) => {
        electronState.webContentsOnChannels.push(channel);
      },
    };

    constructor(options: unknown) {
      electronState.browserWindowOptions.push(options);
    }

    once(): void {}

    on(): void {}

    show(): void {}

    hide(): void {}

    minimize(): void {}

    setSkipTaskbar(): void {}
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info", resolvePathFn: null },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../../config", async (importActual) => {
  const actual = await importActual<typeof import("../../../config")>();
  return {
    ...actual,
    get isDevBuild(): boolean {
      return configState.isDevBuild;
    },
    get canOpenDevTools(): boolean {
      return configState.canOpenDevTools;
    },
  };
});

import {
  createMainWindow,
  loadMainWindow,
  type MainWindowLoadTarget,
} from "../window-factory";

const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "resourcesPath",
);
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);
describe("loadMainWindow", () => {
  beforeEach(() => {
    configState.isDevBuild = true;
    configState.canOpenDevTools = true;
    electronState.appPath = "/desktop-app";
    electronState.browserWindowOptions = [];
    electronState.webContentsOnChannels = [];
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: "/packaged/Resources",
    });
  });

  afterEach(() => {
    restoreProcessProperty("resourcesPath", originalResourcesPathDescriptor);
    restoreProcessProperty("platform", originalPlatformDescriptor);
  });

  it("loads the shipped renderer shell root", async () => {
    configState.isDevBuild = false;
    const target = createLoadTarget();

    await loadMainWindow(target);

    // Shipped (non-dev) builds load through the privileged `app://` scheme so
    // the renderer gets a real web origin (service workers, strict CSP). The
    // protocol handler serves files from disk, so app routes must travel via
    // preload bootstrap args rather than the app:// URL path.
    expect(target.loadedUrls).toEqual(["app://renderer/"]);
  });

  it("passes the initial route through the preload bootstrap arguments", () => {
    createMainWindow({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: "/epics/epic-a",
    });

    expect(electronState.browserWindowOptions).toEqual([
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          additionalArguments: ["--traycer-initial-route=%2Fepics%2Fepic-a"],
        }),
      }),
    ]);
  });

  it("omits preload bootstrap route arguments when no initial route is provided", () => {
    createMainWindow({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: null,
    });

    expect(electronState.browserWindowOptions).toEqual([
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          additionalArguments: [],
        }),
      }),
    ]);
  });

  it("keeps the original macOS hidden-inset overlay titlebar", () => {
    setProcessPlatform("darwin");

    createMainWindow({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: "/",
    });

    expect(electronState.browserWindowOptions).toEqual([
      expect.objectContaining({
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 12, y: 12 },
        titleBarOverlay: true,
      }),
    ]);
  });

  it("keeps the Window Controls Overlay configuration on Windows", () => {
    setProcessPlatform("win32");

    createMainWindow({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: "/",
    });

    expect(electronState.browserWindowOptions).toEqual([
      expect.objectContaining({
        titleBarStyle: "hidden",
        titleBarOverlay: {
          color: "#0b0b0d",
          symbolColor: "#e5e5e5",
          height: 36,
        },
      }),
    ]);
  });

  it("keeps DevTools enabled for the shipped staging policy", () => {
    configState.isDevBuild = false;
    configState.canOpenDevTools = true;

    createMainWindow({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: "/",
    });

    expect(electronState.browserWindowOptions).toEqual([
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          devTools: true,
        }),
      }),
    ]);
  });

  it("disables DevTools at the BrowserWindow level for production policy", () => {
    configState.isDevBuild = false;
    configState.canOpenDevTools = false;

    createMainWindow({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: "/",
    });

    expect(electronState.browserWindowOptions).toEqual([
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          devTools: false,
        }),
      }),
    ]);
  });

  it("does not subscribe to Chromium native find result events", () => {
    createMainWindow({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: "/",
    });

    expect(electronState.webContentsOnChannels).not.toContain("found-in-page");
  });

  it("loads the Vite dev renderer shell on the dev slot without auto-opening DevTools", async () => {
    configState.isDevBuild = true;
    const target = createLoadTarget();

    await loadMainWindow(target);

    // DevTools must NOT auto-open - they're opt-in via the View menu's
    // "Toggle Developer Tools". We assert the loaded URL only; the target has
    // no devtools hook to call.
    expect(target.loadedUrls).toEqual(["http://localhost:5173"]);
  });
});

function createLoadTarget(): MainWindowLoadTarget & {
  readonly loadedUrls: string[];
} {
  const loadedUrls: string[] = [];
  return {
    loadedUrls,
    loadURL: (url) => {
      loadedUrls.push(url);
      return Promise.resolve();
    },
  };
}

function restoreProcessProperty(
  key: "resourcesPath" | "platform",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(process, key);
    return;
  }
  Object.defineProperty(process, key, descriptor);
}

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    writable: true,
    configurable: true,
  });
}
