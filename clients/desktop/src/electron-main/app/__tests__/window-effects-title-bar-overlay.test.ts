import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { handleSetTitleBarOverlay } from "../window-effects";

/**
 * On Windows and Linux the native min/max/close controls are drawn by Electron
 * from the `titleBarOverlay` colors. `handleSetTitleBarOverlay` lets the
 * renderer push theme-derived colors so the controls follow the active theme
 * instead of the static dark launch defaults. macOS uses OS-drawn traffic
 * lights.
 */

const setTitleBarOverlay = vi.fn();
const setBackgroundColor = vi.fn();
const fromWebContents = vi.fn();
const { nativeTheme } = vi.hoisted(() => ({
  nativeTheme: {
    themeSource: "system" as "system" | "light" | "dark",
  },
}));

vi.mock("electron", () => ({
  app: { dock: undefined },
  nativeTheme,
  nativeImage: {
    createFromDataURL: vi.fn(),
    createFromPath: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: (...args: unknown[]): unknown => fromWebContents(...args),
  },
}));

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

interface FakeWindow {
  isDestroyed(): boolean;
  setTitleBarOverlay(options: unknown): void;
  setBackgroundColor(color: string): void;
}

function fakeWindow(destroyed: boolean): FakeWindow {
  return {
    isDestroyed: () => destroyed,
    setTitleBarOverlay,
    setBackgroundColor,
  };
}

// The handler only reads `event.sender`, which the mocked `fromWebContents`
// ignores. Annotate as `unknown` first so the cast to the full Electron event
// type is a single, explicit assertion.
const rawEvent: unknown = { sender: {} };
const event = rawEvent as IpcMainInvokeEvent;

let originalPlatform: PropertyDescriptor | undefined;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    writable: true,
    configurable: true,
  });
}

beforeAll(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
});
afterAll(() => {
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});
beforeEach(() => {
  setTitleBarOverlay.mockClear();
  setBackgroundColor.mockClear();
  fromWebContents.mockReset();
  nativeTheme.themeSource = "system";
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("handleSetTitleBarOverlay", () => {
  it("applies the renderer-provided colors to the sender window on Windows", () => {
    setPlatform("win32");
    fromWebContents.mockReturnValue(fakeWindow(false));

    handleSetTitleBarOverlay(event, "#1e1e2e", "#cdd6f4", "dark");

    expect(setTitleBarOverlay).toHaveBeenCalledWith({
      color: "#1e1e2e",
      symbolColor: "#cdd6f4",
    });
    expect(setBackgroundColor).toHaveBeenCalledWith("#1e1e2e");
  });

  it("applies the renderer-provided colors to the sender window on Linux", () => {
    setPlatform("linux");
    fromWebContents.mockReturnValue(fakeWindow(false));

    handleSetTitleBarOverlay(event, "#1e1e2e", "#cdd6f4", "dark");

    expect(setTitleBarOverlay).toHaveBeenCalledWith({
      color: "#1e1e2e",
      symbolColor: "#cdd6f4",
    });
    expect(setBackgroundColor).toHaveBeenCalledWith("#1e1e2e");
    expect(nativeTheme.themeSource).toBe("dark");
  });

  for (const platform of ["win32", "linux"] as const) {
    it(`accepts normalized hex and rgb colors on ${platform}`, () => {
      setPlatform(platform);
      fromWebContents.mockReturnValue(fakeWindow(false));

      const validColors = [
        ["#abc", "#abcd"],
        ["#a1b2c3", "#a1b2c3d4"],
        ["rgb( 12, 34, 56 )", "rgba(12, 34, 56, 0.5)"],
      ] as const;

      for (const [color, symbolColor] of validColors) {
        handleSetTitleBarOverlay(event, color, symbolColor, "dark");

        expect(setTitleBarOverlay).toHaveBeenLastCalledWith({
          color,
          symbolColor,
        });
        expect(setBackgroundColor).toHaveBeenLastCalledWith(color);
      }
    });
  }

  for (const platform of ["win32", "linux"] as const) {
    it.each([
      ["#12", "#fff"],
      ["#ggg", "#fff"],
      ["", "#fff"],
      ["not-a-color", "#fff"],
      ["var(--title-bar-color)", "#fff"],
      ["oklch(0.5 0.2 120)", "#fff"],
      ["rgb(1, 2)", "#fff"],
      ["rgb(1.5, 2, 3)", "#fff"],
      ["rgb(1, 256, 3)", "#fff"],
      ["rgba(1, 2, 3, 1.1)", "#fff"],
      ["#fff", "rgba(1, 2, 3, -0.1)"],
    ] as const)(
      `rejects invalid color pair on ${platform}: %s / %s`,
      (color, symbolColor) => {
        setPlatform(platform);
        fromWebContents.mockReturnValue(fakeWindow(false));
        nativeTheme.themeSource = "light";

        handleSetTitleBarOverlay(event, color, symbolColor, "dark");

        expect(setTitleBarOverlay).not.toHaveBeenCalled();
        expect(setBackgroundColor).not.toHaveBeenCalled();
        expect(nativeTheme.themeSource).toBe("light");
      },
    );
  }

  it("keeps Linux system theme selection under OS control", () => {
    setPlatform("linux");
    fromWebContents.mockReturnValue(fakeWindow(false));

    handleSetTitleBarOverlay(event, "#1e1e2e", "#cdd6f4", "system");

    expect(nativeTheme.themeSource).toBe("system");
  });

  it("rejects an invalid Linux theme source without changing nativeTheme", () => {
    setPlatform("linux");
    fromWebContents.mockReturnValue(fakeWindow(false));

    handleSetTitleBarOverlay(event, "#1e1e2e", "#cdd6f4", "sepia");

    expect(nativeTheme.themeSource).toBe("system");
  });

  it("is a no-op on macOS", () => {
    setPlatform("darwin");
    fromWebContents.mockReturnValue(fakeWindow(false));

    handleSetTitleBarOverlay(event, "#1e1e2e", "#cdd6f4", "system");

    expect(setTitleBarOverlay).not.toHaveBeenCalled();
    expect(setBackgroundColor).not.toHaveBeenCalled();
  });

  it("ignores non-string colors", () => {
    setPlatform("win32");
    fromWebContents.mockReturnValue(fakeWindow(false));

    handleSetTitleBarOverlay(event, 123, null, "system");

    expect(setTitleBarOverlay).not.toHaveBeenCalled();
    expect(setBackgroundColor).not.toHaveBeenCalled();
  });

  it("ignores a destroyed sender window", () => {
    setPlatform("win32");
    fromWebContents.mockReturnValue(fakeWindow(true));

    handleSetTitleBarOverlay(event, "#1e1e2e", "#cdd6f4", "system");

    expect(setTitleBarOverlay).not.toHaveBeenCalled();
    expect(setBackgroundColor).not.toHaveBeenCalled();
  });
});
