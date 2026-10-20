import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const electronMock = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electronMock.fromWebContents },
}));

import { captureWindowRegion } from "../window-capture";

const PNG_BYTES = Uint8Array.from([137, 80, 78, 71]);

interface Harness {
  readonly capturePage: Mock;
  readonly invoke: (input: unknown) => Promise<ArrayBuffer | null>;
}

/** `ownerWebContents` is what the window reports as its own; it differs from the sender to model a foreign frame. */
function harness(options: {
  readonly zoom: number;
  readonly content: readonly [number, number];
  readonly imageEmpty: boolean;
  readonly windowOwnsSender: boolean;
  readonly windowFound: boolean;
}): Harness {
  const capturePage = vi.fn(async () => ({
    isEmpty: () => options.imageEmpty,
    toPNG: () => Buffer.from(PNG_BYTES),
  }));
  const sender = { getZoomFactor: () => options.zoom, capturePage };
  const window = {
    isDestroyed: () => false,
    webContents: options.windowOwnsSender ? sender : {},
    getContentSize: () => [...options.content],
  };
  electronMock.fromWebContents.mockReturnValue(
    options.windowFound ? window : null,
  );
  return {
    capturePage,
    invoke: (input) => {
      // Only `sender` is read; the rest of the Electron event is irrelevant here.
      const event: IpcMainInvokeEvent = Object.assign(Object.create(null), {
        sender,
      });
      return captureWindowRegion(event, input);
    },
  };
}

function ordinary(overrides: Partial<Parameters<typeof harness>[0]>): Harness {
  return harness({
    zoom: 1,
    content: [1000, 800],
    imageEmpty: false,
    windowOwnsSender: true,
    windowFound: true,
    ...overrides,
  });
}

beforeEach(() => {
  electronMock.fromWebContents.mockReset();
});

describe("captureWindowRegion", () => {
  it("captures the requested rect and returns the PNG bytes", async () => {
    const { invoke, capturePage } = ordinary({});

    const bytes = await invoke({ x: 10, y: 20, width: 100, height: 50 });

    expect(capturePage).toHaveBeenCalledWith({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
    expect(bytes === null ? [] : [...new Uint8Array(bytes)]).toEqual([
      ...PNG_BYTES,
    ]);
  });

  it("converts CSS pixels to device pixels with the page zoom, widening to whole pixels", async () => {
    const { invoke, capturePage } = ordinary({ zoom: 1.5 });

    await invoke({ x: 10, y: 10, width: 100.2, height: 50 });

    // floor(15), floor(15); right ceil(165.3) = 166, bottom ceil(90) = 90.
    expect(capturePage).toHaveBeenCalledWith({
      x: 15,
      y: 15,
      width: 151,
      height: 75,
    });
  });

  it("clamps a rect that spills past the content area to the window", async () => {
    const { invoke, capturePage } = ordinary({ content: [200, 100] });

    await invoke({ x: -30, y: 50, width: 500, height: 500 });

    expect(capturePage).toHaveBeenCalledWith({
      x: 0,
      y: 50,
      width: 200,
      height: 50,
    });
  });

  it("refuses a rect wholly outside the window without capturing", async () => {
    const { invoke, capturePage } = ordinary({ content: [200, 100] });

    expect(await invoke({ x: 300, y: 10, width: 50, height: 50 })).toBeNull();
    expect(await invoke({ x: -80, y: 10, width: 50, height: 50 })).toBeNull();
    expect(capturePage).not.toHaveBeenCalled();
  });

  it("refuses malformed or empty rects", async () => {
    const { invoke, capturePage } = ordinary({});

    for (const input of [
      null,
      "rect",
      { x: 0, y: 0, width: 10 },
      { x: 0, y: 0, width: Number.NaN, height: 10 },
      { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 },
      { x: "0", y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: -1 },
    ]) {
      expect(await invoke(input)).toBeNull();
    }
    expect(capturePage).not.toHaveBeenCalled();
  });

  it("captures only the window that owns the requesting web contents", async () => {
    const foreign = ordinary({ windowOwnsSender: false });
    expect(
      await foreign.invoke({ x: 0, y: 0, width: 10, height: 10 }),
    ).toBeNull();
    expect(foreign.capturePage).not.toHaveBeenCalled();

    const noWindow = ordinary({ windowFound: false });
    expect(
      await noWindow.invoke({ x: 0, y: 0, width: 10, height: 10 }),
    ).toBeNull();
    expect(noWindow.capturePage).not.toHaveBeenCalled();
  });

  it("returns null when the capture produced no image", async () => {
    const { invoke, capturePage } = ordinary({ imageEmpty: true });

    expect(await invoke({ x: 0, y: 0, width: 10, height: 10 })).toBeNull();
    expect(capturePage).toHaveBeenCalledTimes(1);
  });
});
