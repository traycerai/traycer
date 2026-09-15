import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const imageProcessingMocks = vi.hoisted(() => ({
  yieldImageWork: vi.fn<(signal: AbortSignal) => Promise<void>>(),
  ditherRows: vi.fn(),
  ditherRowsPerChannel: vi.fn(),
}));

vi.mock("@/lib/appearance/appearance-image-processing", () => ({
  ...imageProcessingMocks,
}));

import { AppearanceWallpaper } from "@/components/home/appearance-wallpaper";

interface TestImage {
  onload: (() => void) | null;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  src: string;
}

describe("AppearanceWallpaper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    imageProcessingMocks.yieldImageWork.mockImplementation(
      (_signal: AbortSignal) => new Promise<void>(() => undefined),
    );
    class MockImage implements TestImage {
      onload: (() => void) | null = null;
      readonly naturalWidth = 2000;
      readonly naturalHeight = 2000;
      private imageSrc = "";

      get src(): string {
        return this.imageSrc;
      }

      set src(value: string) {
        this.imageSrc = value;
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", MockImage);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("aborts a dither pass when a resize starts a newer pass", async () => {
    const resizeCallbacks: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
        constructor(callback: () => void) {
          resizeCallbacks.push(callback);
        }
      },
    );
    const context: Partial<CanvasRenderingContext2D> = {
      canvas: document.createElement("canvas"),
      drawImage: vi.fn(),
      getImageData: vi.fn((): ImageData => ({
        data: new Uint8ClampedArray(64 * 2000 * 4),
        width: 2000,
        height: 64,
        colorSpace: "srgb",
      })),
      putImageData: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(
      2000,
    );
    vi.spyOn(
      HTMLCanvasElement.prototype,
      "clientHeight",
      "get",
    ).mockReturnValue(2000);

    render(
      <AppearanceWallpaper
        wallpaper={{
          style: "dither",
          intensity: 0.6,
          tintWithAccent: false,
          name: "wallpaper.png",
          curatedId: null,
        }}
        url="blob:wallpaper"
        tint={null}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(imageProcessingMocks.yieldImageWork).toHaveBeenCalledTimes(1);
    const firstSignal = imageProcessingMocks.yieldImageWork.mock.calls[0]?.[0];
    if (!(firstSignal instanceof AbortSignal))
      throw new Error("expected first render abort signal");

    resizeCallbacks[0]?.();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(imageProcessingMocks.yieldImageWork).toHaveBeenCalledTimes(2);
    const secondSignal = imageProcessingMocks.yieldImageWork.mock.calls[1]?.[0];
    if (!(secondSignal instanceof AbortSignal))
      throw new Error("expected second render abort signal");
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal).not.toBe(firstSignal);
    expect(secondSignal.aborted).toBe(false);
  });
});
