import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWindow } from "electron";
import { isDevBuild } from "../../../config";
import { AppIconBadgeWindows } from "../../windows/app-icon-badge-windows";
import {
  installAppIconBadgeOutput,
  overlayBadgeFileName,
} from "../app-icon-badge";
import { log } from "../logger";

interface OverlayCall {
  readonly image: unknown;
  readonly description: unknown;
}

interface LoadedImage {
  isEmpty(): boolean;
  readonly path: string;
}

const electronState = vi.hoisted(() => ({
  appPath: "/traycer-desktop-app",
  resourcesPath: "/traycer-resources",
  setBadge: vi.fn(),
  setBadgeCount: vi.fn(() => true),
  overlayCalls: new WeakMap<object, OverlayCall[]>(),
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: (): string => electronState.appPath,
    getPath: (name: string): string => `/tmp/traycer-test-${name}`,
    dock: { setBadge: electronState.setBadge },
    setBadgeCount: electronState.setBadgeCount,
  },
  nativeTheme: { themeSource: "system" },
  nativeImage: {
    createFromDataURL: vi.fn(),
    createFromPath: (imagePath: string): LoadedImage => ({
      isEmpty: (): boolean => false,
      path: imagePath,
    }),
  },
  BrowserWindow: class {
    static fromWebContents(): null {
      return null;
    }

    isDestroyed(): boolean {
      return false;
    }

    setOverlayIcon(image: unknown, description: unknown): void {
      const calls = electronState.overlayCalls.get(this) ?? [];
      calls.push({ image, description });
      electronState.overlayCalls.set(this, calls);
    }
  },
}));

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalResourcesPath = Object.getOwnPropertyDescriptor(
  process,
  "resourcesPath",
);

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  if (originalResourcesPath !== undefined) {
    Object.defineProperty(process, "resourcesPath", originalResourcesPath);
  } else {
    Reflect.deleteProperty(process, "resourcesPath");
  }
  electronState.setBadge.mockClear();
  electronState.setBadgeCount.mockClear();
  vi.mocked(log.debug).mockClear();
});

function badgeFile(fileName: string): string {
  const dir = isDevBuild
    ? join(electronState.appPath, "resources", "badge")
    : join(electronState.resourcesPath, "badge");
  return join(dir, fileName);
}

function windowById(
  windowsById: ReadonlyMap<string, BrowserWindow>,
): (windowId: string) => BrowserWindow | null {
  return (windowId: string): BrowserWindow | null =>
    windowsById.get(windowId) ?? null;
}

function overlayCalls(window: BrowserWindow): readonly OverlayCall[] {
  return electronState.overlayCalls.get(window) ?? [];
}

function imagePath(image: unknown): string | null {
  if (
    image !== null &&
    typeof image === "object" &&
    "path" in image &&
    typeof image.path === "string"
  ) {
    return image.path;
  }
  return null;
}

function lastOverlay(window: BrowserWindow): OverlayCall {
  const calls = overlayCalls(window);
  const last = calls[calls.length - 1];
  if (last === undefined) throw new Error("window has no overlay");
  return last;
}

describe("installAppIconBadgeOutput", () => {
  it("sets the Dock text, caps it at 99+, and skips an unchanged text", () => {
    setPlatform("darwin");
    const windows = new AppIconBadgeWindows();
    const window = new BrowserWindow();
    installAppIconBadgeOutput(windows, windowById(new Map([["dock", window]])));
    windows.track("dock");
    windows.focused("dock");

    windows.setCount("dock", 99);
    windows.setCount("dock", 100);
    windows.setCount("dock", 250);
    windows.setCount("dock", 0);
    windows.focused("dock");

    expect(electronState.setBadge.mock.calls.map((call) => call[0])).toEqual([
      "99",
      "99+",
      "",
    ]);
  });

  it("sets the Linux launcher count and logs the result at debug, once per change", () => {
    setPlatform("linux");
    const windows = new AppIconBadgeWindows();
    const window = new BrowserWindow();
    installAppIconBadgeOutput(
      windows,
      windowById(new Map([["launcher", window]])),
    );
    windows.track("launcher");
    windows.focused("launcher");

    windows.setCount("launcher", 4);
    windows.focused("launcher");
    windows.setCount("launcher", 0);

    expect(electronState.setBadgeCount.mock.calls).toEqual([[4], [0]]);
    expect(vi.mocked(log.debug).mock.calls).toEqual([
      ["[app-icon-badge] launcher count set", { count: 4, applied: true }],
      ["[app-icon-badge] launcher count set", { count: 0, applied: true }],
    ]);
  });

  it("draws the Windows overlay on every visible window and again when a hidden one is shown", () => {
    setPlatform("win32");
    Object.defineProperty(process, "resourcesPath", {
      value: electronState.resourcesPath,
      configurable: true,
      writable: true,
    });
    const windows = new AppIconBadgeWindows();
    const staying = new BrowserWindow();
    const hiding = new BrowserWindow();
    const windowsById = new Map<string, BrowserWindow>([
      ["staying", staying],
      ["hiding", hiding],
    ]);
    installAppIconBadgeOutput(windows, windowById(windowsById));
    windows.track("staying");
    windows.track("hiding");
    windows.focused("staying");
    windows.focused("hiding");

    windows.setCount("hiding", 1);
    expect(imagePath(lastOverlay(staying).image)).toBe(
      badgeFile("badge-1.png"),
    );
    expect(lastOverlay(staying).description).toBe("1 notification");
    expect(imagePath(lastOverlay(hiding).image)).toBe(badgeFile("badge-1.png"));
    expect(lastOverlay(hiding).description).toBe("1 notification");

    windows.setCount("hiding", 3);
    expect(imagePath(lastOverlay(staying).image)).toBe(
      badgeFile("badge-3.png"),
    );
    expect(lastOverlay(staying).description).toBe("3 notifications");

    windows.setCount("hiding", 10);
    expect(imagePath(lastOverlay(hiding).image)).toBe(
      badgeFile("badge-9-plus.png"),
    );
    expect(lastOverlay(hiding).description).toBe("10 notifications");

    // The other window has its own count, but the overlay follows the focused
    // one until that window is hidden.
    windows.setCount("staying", 3);
    expect(imagePath(lastOverlay(staying).image)).toBe(
      badgeFile("badge-9-plus.png"),
    );
    const hidingCalls = overlayCalls(hiding).length;
    windows.hidden("hiding");
    expect(overlayCalls(hiding)).toHaveLength(hidingCalls);
    expect(imagePath(lastOverlay(staying).image)).toBe(
      badgeFile("badge-3.png"),
    );
    expect(lastOverlay(staying).description).toBe("3 notifications");

    windows.shown("hiding");
    expect(overlayCalls(hiding).length).toBeGreaterThan(hidingCalls);
    expect(imagePath(lastOverlay(hiding).image)).toBe(
      badgeFile("badge-9-plus.png"),
    );
    expect(lastOverlay(hiding).description).toBe("10 notifications");
    expect(imagePath(lastOverlay(staying).image)).toBe(
      badgeFile("badge-9-plus.png"),
    );

    windows.setCount("hiding", 0);
    expect(lastOverlay(staying).image).toBeNull();
    expect(lastOverlay(staying).description).toBe("");
    expect(lastOverlay(hiding).image).toBeNull();
    expect(lastOverlay(hiding).description).toBe("");

    // A visible id with no window is skipped; the others are still drawn.
    const stayingCalls = overlayCalls(staying).length;
    const hidingCallsAtZero = overlayCalls(hiding).length;
    windows.track("missing");
    windows.shown("missing");
    expect(windows.snapshot().visibleWindowIds).toContain("missing");
    expect(overlayCalls(staying)).toHaveLength(stayingCalls + 1);
    expect(overlayCalls(hiding)).toHaveLength(hidingCallsAtZero + 1);
    expect(lastOverlay(staying).image).toBeNull();
    expect(lastOverlay(hiding).image).toBeNull();
  });
});

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

function decodeBadge(fileName: string): DecodedPng {
  const codecPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../scripts/assets/png-codec.cjs",
  );
  const loaded: unknown = createRequire(import.meta.url)(codecPath);
  if (
    loaded === null ||
    typeof loaded !== "object" ||
    !("decodePng" in loaded) ||
    typeof loaded.decodePng !== "function"
  ) {
    throw new Error("png codec did not export decodePng");
  }
  const bytes = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../resources/badge",
      fileName,
    ),
  );
  const decoded: unknown = loaded.decodePng(bytes);
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    !("width" in decoded) ||
    !("height" in decoded) ||
    !("rgba" in decoded) ||
    typeof decoded.width !== "number" ||
    typeof decoded.height !== "number" ||
    !(decoded.rgba instanceof Uint8Array)
  ) {
    throw new Error("png codec returned an unexpected image");
  }
  return {
    width: decoded.width,
    height: decoded.height,
    rgba: decoded.rgba,
  };
}

describe("overlay badge files", () => {
  it("decodes every overlay file for counts 1 through 10 as 16x16", () => {
    for (let count = 1; count <= 10; count += 1) {
      const fileName = overlayBadgeFileName(count);
      const expected =
        count > 9 ? "badge-9-plus.png" : `badge-${String(count)}.png`;
      expect(fileName).toBe(expected);
      const decoded = decodeBadge(expected);
      expect(decoded.width).toBe(16);
      expect(decoded.height).toBe(16);
      expect(decoded.rgba).toHaveLength(16 * 16 * 4);
    }
  });
});
