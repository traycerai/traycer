import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  appPath: "/desktop-app",
  browserWindowOptions: [] as unknown[],
  browserWindows: [] as Array<{
    readonly readyToShow: () => void;
    readonly maximizeCalls: number;
  }>,
  webContentsOnChannels: [] as string[],
  // Captures the LATEST listener registered per channel, so a test can drive
  // it directly (e.g. `console-message`) without wiring a real BrowserWindow.
  webContentsListeners: new Map<string, (...args: unknown[]) => void>(),
}));

const perfTelemetryState = vi.hoisted(() => ({
  events: [] as unknown[],
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

vi.mock("../../perf/perf-telemetry-writer", async () => {
  const actual = await vi.importActual<
    typeof import("../../perf/perf-telemetry-writer")
  >("../../perf/perf-telemetry-writer");
  return {
    ...actual,
    appendPerfEvent: (event: unknown) => {
      perfTelemetryState.events.push(event);
    },
  };
});

vi.mock("electron", () => ({
  app: {
    getAppPath: (): string => electronState.appPath,
    getPath: (): string => "/tmp/traycer-user-data",
    on: vi.fn(),
  },
  BrowserWindow: class {
    maximizeCalls = 0;
    private readyToShow: (() => void) | null = null;
    readonly webContents = {
      setVisualZoomLevelLimits: vi.fn(() => Promise.resolve()),
      setWindowOpenHandler: vi.fn(),
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        electronState.webContentsOnChannels.push(channel);
        electronState.webContentsListeners.set(channel, listener);
      },
    };

    constructor(options: unknown) {
      const self = this;
      electronState.browserWindowOptions.push(options);
      electronState.browserWindows.push({
        readyToShow: () => {
          this.readyToShow?.();
        },
        get maximizeCalls() {
          return self.maximizeCalls;
        },
      });
    }

    once(event: string, listener: () => void): void {
      if (event === "ready-to-show") {
        this.readyToShow = listener;
      }
    }

    on(): void {}

    maximize(): void {
      this.maximizeCalls += 1;
    }

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
  type MainWindowOptions,
  type MainWindowLoadTarget,
} from "../window-factory";
import { createFirstLaunchWindowPlacement } from "../window-geometry";

const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "resourcesPath",
);
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);
const originalEnv = process.env;

function createMainWindowForTest(options: MainWindowOptions): void {
  createMainWindow(options);
}

describe("loadMainWindow", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    configState.isDevBuild = true;
    configState.canOpenDevTools = true;
    electronState.appPath = "/desktop-app";
    electronState.browserWindowOptions = [];
    electronState.browserWindows = [];
    electronState.webContentsOnChannels = [];
    electronState.webContentsListeners.clear();
    perfTelemetryState.events = [];
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: "/packaged/Resources",
    });
  });

  afterEach(() => {
    process.env = originalEnv;
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
    createMainWindowForTest({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: "/epics/epic-a",
      zoomFactor: 1,
      placement: createFirstLaunchWindowPlacement(),
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
    createMainWindowForTest({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: null,
      zoomFactor: 1,
      placement: createFirstLaunchWindowPlacement(),
    });

    expect(electronState.browserWindowOptions).toEqual([
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          additionalArguments: [],
        }),
      }),
    ]);
  });

  it("applies the zoom factor without scaling native window bounds", () => {
    createMainWindowForTest({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: null,
      zoomFactor: 1.5,
      placement: createFirstLaunchWindowPlacement(),
    });

    expect(electronState.browserWindowOptions).toEqual([
      expect.objectContaining({
        width: 1280,
        height: 800,
        minWidth: 960,
        minHeight: 600,
        webPreferences: expect.objectContaining({
          zoomFactor: 1.5,
        }),
      }),
    ]);
  });

  it("keeps the original macOS hidden-inset overlay titlebar", () => {
    setProcessPlatform("darwin");

    createMainWindowForTest({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: "/",
      zoomFactor: 1,
      placement: createFirstLaunchWindowPlacement(),
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

    createMainWindowForTest({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: "/",
      zoomFactor: 1,
      placement: createFirstLaunchWindowPlacement(),
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

    createMainWindowForTest({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: "/",
      zoomFactor: 1,
      placement: createFirstLaunchWindowPlacement(),
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

    createMainWindowForTest({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: "/",
      zoomFactor: 1,
      placement: createFirstLaunchWindowPlacement(),
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
    createMainWindowForTest({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: "/",
      zoomFactor: 1,
      placement: createFirstLaunchWindowPlacement(),
    });

    expect(electronState.webContentsOnChannels).not.toContain("found-in-page");
  });

  it("redacts a secret-bearing string field on a perf-telemetry console line before persisting it", () => {
    createMainWindowForTest({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: "/",
      zoomFactor: 1,
      placement: createFirstLaunchWindowPlacement(),
    });

    const consoleMessageListener =
      electronState.webContentsListeners.get("console-message");
    expect(consoleMessageListener).toBeDefined();

    const perfLine = `[traycer-perf] ${JSON.stringify({
      name: "test-event",
      tsMs: 1_700_000_000_000,
      fields: {
        // A future call site could pass a user-derived string as a field -
        // this must scrub the same way every other renderer log path does.
        detail: "Bearer abc123secrettoken",
        count: 3,
      },
    })}`;
    consoleMessageListener?.({
      level: "info",
      message: perfLine,
      lineNumber: 0,
      sourceId: "app://renderer/",
    });

    expect(perfTelemetryState.events).toEqual([
      {
        name: "test-event",
        tsMs: 1_700_000_000_000,
        fields: { detail: "Bearer <redacted>", count: 3 },
      },
    ]);
  });

  it("honors resolution harness window bounds without changing zoom minimums", () => {
    process.env.TRAYCER_RESOLUTION_TEST_WINDOW_BOUNDS = "3840x2160";
    process.env.TRAYCER_RESOLUTION_TEST_DISABLE_MAXIMIZE = "1";

    createMainWindowForTest({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: "/",
      zoomFactor: 1,
      placement: createFirstLaunchWindowPlacement(),
    });

    expect(electronState.browserWindowOptions).toEqual([
      expect.objectContaining({
        width: 3840,
        height: 2160,
        minWidth: 960,
        minHeight: 600,
      }),
    ]);

    electronState.browserWindows[0].readyToShow();

    expect(electronState.browserWindows[0].maximizeCalls).toBe(0);
  });

  it("creates maximized restored windows at their remembered normal bounds", () => {
    createMainWindowForTest({
      preloadPath: "/preload.js",
      windowId: "window-a",
      initialRoute: "/",
      zoomFactor: 1,
      placement: {
        x: 120,
        y: 140,
        width: 1800,
        height: 1200,
        maximized: true,
      },
    });

    expect(electronState.browserWindowOptions).toEqual([
      expect.objectContaining({
        x: 120,
        y: 140,
        width: 1800,
        height: 1200,
      }),
    ]);

    electronState.browserWindows[0].readyToShow();

    expect(electronState.browserWindows[0].maximizeCalls).toBe(1);
  });

  it("can load the built renderer in a dev build for resolution screenshots", async () => {
    configState.isDevBuild = true;
    process.env.TRAYCER_RESOLUTION_TEST_USE_BUILT_RENDERER = "1";
    const target = createLoadTarget();

    await loadMainWindow(target);

    expect(target.loadedUrls).toEqual(["app://renderer/"]);
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
