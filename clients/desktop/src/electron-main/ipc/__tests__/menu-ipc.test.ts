import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
  getApplicationMenu: vi.fn(),
  getMenuItemById: vi.fn(),
  popup: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: (...args: unknown[]) =>
      electronState.fromWebContents(...args),
  },
  Menu: {
    getApplicationMenu: (...args: unknown[]) =>
      electronState.getApplicationMenu(...args),
  },
}));

import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import { registerMenuIpc, scaleMenuAnchor } from "../menu-ipc";

interface FakeBridge {
  channel: string | null;
  handler: ((event: unknown, ...args: unknown[]) => unknown) | null;
  handleInvoke(
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown,
  ): void;
}

function makeBridge(): FakeBridge {
  return {
    channel: null,
    handler: null,
    handleInvoke(channel, handler) {
      this.channel = channel;
      this.handler = handler;
    },
  };
}

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function registerForTest(): {
  readonly bridge: FakeBridge;
  readonly window: {
    readonly isDestroyed: () => boolean;
    readonly webContents: { readonly getZoomFactor: () => number };
  };
} {
  const window = {
    isDestroyed: () => false,
    webContents: { getZoomFactor: () => 1.5 },
  };
  electronState.fromWebContents.mockReturnValue(window);
  electronState.getApplicationMenu.mockReturnValue({
    getMenuItemById: electronState.getMenuItemById,
  });
  electronState.getMenuItemById.mockReturnValue({
    submenu: { popup: electronState.popup },
  });
  const bridge = makeBridge();
  registerMenuIpc(bridge as never);
  return { bridge, window };
}

beforeEach(() => {
  setPlatform("linux");
  electronState.fromWebContents.mockReset();
  electronState.getApplicationMenu.mockReset();
  electronState.getMenuItemById.mockReset();
  electronState.popup.mockReset();
});

afterAll(() => {
  if (originalPlatformDescriptor !== undefined) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
});

describe("scaleMenuAnchor", () => {
  it("converts renderer CSS coordinates to zoomed popup coordinates", () => {
    expect(scaleMenuAnchor(40, 1.5)).toBe(60);
    expect(scaleMenuAnchor(40, 0.67)).toBe(27);
  });

  it("clamps negative coordinates and rejects invalid zoom factors", () => {
    expect(scaleMenuAnchor(-12, 2)).toBe(0);
    expect(scaleMenuAnchor(40, Number.NaN)).toBe(40);
  });
});

describe("registerMenuIpc", () => {
  it("opens the requested native submenu on Linux with zoomed coordinates", () => {
    const { bridge } = registerForTest();

    expect(bridge.channel).toBe(RunnerHostInvoke.menuOpenTopLevel);
    bridge.handler?.({ sender: {} }, "file", 40, 20);

    expect(electronState.getMenuItemById).toHaveBeenCalledWith(
      "traycer.top-level-menu.file",
    );
    expect(electronState.popup).toHaveBeenCalledWith({
      window: expect.any(Object),
      x: 60,
      y: 30,
    });
  });

  it("keeps menu id and coordinate validation on Linux", () => {
    const { bridge } = registerForTest();
    const handler = bridge.handler;
    if (handler === null) throw new Error("menu handler missing");

    expect(() => handler({ sender: {} }, "unknown", 0, 0)).toThrow(
      "menu.openTopLevel requires a known menu id",
    );
    expect(() => handler({ sender: {} }, "file", Number.NaN, 0)).toThrow(
      "menu.openTopLevel requires a finite x coordinate",
    );
    expect(() =>
      handler({ sender: {} }, "file", 0, Number.POSITIVE_INFINITY),
    ).toThrow("menu.openTopLevel requires a finite y coordinate");
  });

  it("continues to ignore the request on macOS", () => {
    setPlatform("darwin");
    const { bridge } = registerForTest();

    bridge.handler?.({ sender: {} }, "file", 40, 20);

    expect(electronState.getApplicationMenu).not.toHaveBeenCalled();
    expect(electronState.popup).not.toHaveBeenCalled();
  });
});
