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
import {
  resetRetainedWallpaperFramesForTests,
  restoreWallpaperFrame,
  retainWallpaperFrame,
} from "@/components/home/appearance-wallpaper-frame";

interface TestImage {
  onload: (() => void) | null;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  src: string;
}

describe("AppearanceWallpaper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    imageProcessingMocks.yieldImageWork.mockReset();
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
    resetRetainedWallpaperFramesForTests();
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
        surface="page"
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

  it("puts the last dither frame on a remounted canvas before the image reloads", async () => {
    resetRetainedWallpaperFramesForTests();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(
      100,
    );
    vi.spyOn(
      HTMLCanvasElement.prototype,
      "clientHeight",
      "get",
    ).mockReturnValue(100);
    const context: Partial<CanvasRenderingContext2D> = {
      drawImage: () => undefined,
      getImageData: (): ImageData => ({
        data: new Uint8ClampedArray(50 * 50 * 4),
        width: 50,
        height: 50,
        colorSpace: "srgb",
      }),
      putImageData: () => undefined,
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as CanvasRenderingContext2D,
    );

    const wallpaper = {
      style: "dither" as const,
      intensity: 0.6,
      tintWithAccent: false,
      name: "wallpaper.png",
      curatedId: null,
    };
    const first = render(
      <AppearanceWallpaper
        wallpaper={wallpaper}
        url="blob:wallpaper"
        tint={null}
        surface="page"
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(first.container.querySelector("canvas")?.width).toBe(50);
    first.unmount();

    // The reload never arrives. The frame on screen is the one restored in
    // the layout effect, not a second dither pass.
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        readonly naturalWidth = 2000;
        readonly naturalHeight = 2000;
        src = "";
      },
    );
    const second = render(
      <AppearanceWallpaper
        wallpaper={wallpaper}
        url="blob:wallpaper"
        tint={null}
        surface="page"
      />,
    );
    expect(second.container.querySelector("canvas")?.width).toBe(50);
  });

  it("keeps only the latest wallpaper raster", () => {
    resetRetainedWallpaperFramesForTests();
    const context: Partial<CanvasRenderingContext2D> = {
      drawImage: () => undefined,
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as CanvasRenderingContext2D,
    );
    const small = document.createElement("canvas");
    small.width = 10;
    small.height = 8;
    retainWallpaperFrame("page", "dither", small);
    const large = document.createElement("canvas");
    large.width = 40;
    large.height = 20;
    retainWallpaperFrame("page", "dither", large);
    const sidebar = document.createElement("canvas");
    sidebar.width = 12;
    sidebar.height = 6;
    retainWallpaperFrame("sidebar", "dither", sidebar);

    const restored = document.createElement("canvas");
    expect(
      restoreWallpaperFrame("page", "dither", restored, {
        width: 10,
        height: 8,
      }),
    ).toBe(false);
    expect(
      restoreWallpaperFrame("page", "dither", restored, {
        width: 40,
        height: 20,
      }),
    ).toBe(true);
    expect(
      restoreWallpaperFrame("sidebar", "dither", restored, {
        width: 12,
        height: 6,
      }),
    ).toBe(true);
  });

  it("keeps the landing frame when a settings preview finishes", async () => {
    resetRetainedWallpaperFramesForTests();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    const width = vi
      .spyOn(HTMLCanvasElement.prototype, "clientWidth", "get")
      .mockReturnValue(1000);
    const height = vi
      .spyOn(HTMLCanvasElement.prototype, "clientHeight", "get")
      .mockReturnValue(800);
    const context: Partial<CanvasRenderingContext2D> = {
      drawImage: () => undefined,
      getImageData: (): ImageData => ({
        data: new Uint8ClampedArray(500 * 400 * 4),
        width: 500,
        height: 400,
        colorSpace: "srgb",
      }),
      putImageData: () => undefined,
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as CanvasRenderingContext2D,
    );
    const wallpaper = {
      style: "dither" as const,
      intensity: 0.6,
      tintWithAccent: false,
      name: "wallpaper.png",
      curatedId: null,
    };
    const page = render(
      <AppearanceWallpaper
        wallpaper={wallpaper}
        url="blob:page-wallpaper"
        tint={null}
        surface="page"
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(page.container.querySelector("canvas")?.width).toBe(500);

    width.mockReturnValue(200);
    height.mockReturnValue(160);
    const preview = render(
      <AppearanceWallpaper
        wallpaper={wallpaper}
        url="https://assets.traycer.ai/another-thumb.webp"
        tint={null}
        surface="preview"
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(preview.container.querySelector("canvas")?.width).toBe(100);
    preview.unmount();
    page.unmount();

    width.mockReturnValue(1000);
    height.mockReturnValue(800);
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        readonly naturalWidth = 2000;
        readonly naturalHeight = 2000;
        src = "";
      },
    );
    const remount = render(
      <AppearanceWallpaper
        wallpaper={wallpaper}
        url="blob:page-wallpaper"
        tint={null}
        surface="page"
      />,
    );
    expect(remount.container.querySelector("canvas")?.width).toBe(500);
  });

  describe("live canvas stability while dithering", () => {
    const DITHER_WALLPAPER = {
      style: "dither",
      intensity: 0.6,
      tintWithAccent: false,
      name: "wallpaper.png",
      curatedId: null,
    } as const;

    function makeContext(): {
      readonly context: CanvasRenderingContext2D;
      readonly paints: () => number;
    } {
      let paints = 0;
      const partial: Partial<CanvasRenderingContext2D> = {
        drawImage: () => {
          paints += 1;
        },
        putImageData: () => {
          paints += 1;
        },
        getImageData: (): ImageData => ({
          data: new Uint8ClampedArray(64 * 1000 * 4),
          width: 1000,
          height: 64,
          colorSpace: "srgb",
        }),
      };
      return {
        context: partial as CanvasRenderingContext2D,
        paints: () => paints,
      };
    }

    // Big enough (1000x1000 cells) that the row loop yields between bands.
    function setup() {
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
      const size = { width: 2000, height: 2000 };
      vi.spyOn(
        HTMLCanvasElement.prototype,
        "clientWidth",
        "get",
      ).mockImplementation(() => size.width);
      vi.spyOn(
        HTMLCanvasElement.prototype,
        "clientHeight",
        "get",
      ).mockImplementation(() => size.height);
      const pendingYields: Array<() => void> = [];
      imageProcessingMocks.yieldImageWork.mockImplementation(
        async (signal: AbortSignal) => {
          await new Promise<void>((resolve) => pendingYields.push(resolve));
          signal.throwIfAborted();
        },
      );

      const live = makeContext();
      const detached = makeContext();
      const { container } = render(
        <AppearanceWallpaper
          wallpaper={DITHER_WALLPAPER}
          url="blob:wallpaper"
          tint={null}
          surface="page"
        />,
      );
      const liveCanvas = container.querySelector("canvas");
      if (liveCanvas === null) throw new Error("expected the live canvas");
      const dimensionWrites: string[] = [];
      for (const dimension of ["width", "height"] as const) {
        // Behave like a real canvas: the getter returns the last written
        // backing size, so an implementation can read it back to dedupe.
        let backingSize = liveCanvas[dimension];
        Object.defineProperty(liveCanvas, dimension, {
          configurable: true,
          get: () => backingSize,
          set: (value: number) => {
            backingSize = value;
            dimensionWrites.push(dimension);
          },
        });
      }
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
        function (this: HTMLCanvasElement) {
          return (this === liveCanvas ? live : detached).context;
        },
      );

      /** Anything that changes the pixels or the backing store the user sees. */
      const liveMutations = (): number =>
        dimensionWrites.length + live.paints();
      /** Runs every pending yield (and the pass behind it) to completion. */
      const drain = async (): Promise<void> => {
        for (let round = 0; round < 100; round += 1) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
          });
          const next = pendingYields.shift();
          if (next === undefined) return;
          next();
        }
        throw new Error("dither pass never finished");
      };
      /** Reports a new size to the observer without letting the debounce run. */
      const notifyResize = (width: number, height: number): void => {
        size.width = width;
        size.height = height;
        resizeCallbacks[0]?.();
      };
      const resize = async (width: number, height: number): Promise<void> => {
        notifyResize(width, height);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
      };
      return {
        liveMutations,
        livePaints: () => live.paints(),
        drain,
        notifyResize,
        resize,
        resumeOldestYield: async (): Promise<void> => {
          pendingYields.shift()?.();
          await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
          });
        },
      };
    }

    it("leaves the live canvas alone until a pass has fully finished", async () => {
      const { liveMutations, drain } = setup();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // The pass is parked on its first yield: nothing raw or partial may be
      // on screen yet.
      expect(imageProcessingMocks.yieldImageWork).toHaveBeenCalledTimes(1);
      expect(liveMutations()).toBe(0);

      await drain();
      expect(liveMutations()).toBeGreaterThan(0);
    });

    it("never commits a cancelled pass to the live canvas", async () => {
      const { liveMutations, livePaints, drain, resize, resumeOldestYield } =
        setup();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(imageProcessingMocks.yieldImageWork).toHaveBeenCalledTimes(1);

      // A real size change starts a second pass and aborts the first.
      await resize(1800, 1800);
      expect(imageProcessingMocks.yieldImageWork).toHaveBeenCalledTimes(2);
      expect(liveMutations()).toBe(0);

      // Resume the stale pass on its own: it is aborted, so it must not paint,
      // and nothing may reach the live canvas while the newest is still parked.
      await resumeOldestYield();
      expect(liveMutations()).toBe(0);

      // Only the newest pass finishes, and it paints exactly one frame.
      await drain();
      expect(livePaints()).toBe(1);
    });

    it("keeps the frame when a pass is superseded by a return to the painted size", async () => {
      const { livePaints, drain, notifyResize, resize } = setup();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await drain();
      expect(livePaints()).toBe(1);
      const passes = imageProcessingMocks.yieldImageWork.mock.calls.length;

      // B starts (parked on a yield) ...
      await resize(1800, 1800);
      expect(
        imageProcessingMocks.yieldImageWork.mock.calls.length,
      ).toBeGreaterThan(passes);
      // ... the size returns to A before the debounce fires, and B completes:
      // it must be discarded rather than committed at the wrong size.
      notifyResize(2000, 2000);
      await drain();
      expect(livePaints()).toBe(1);

      // A's debounce now fires. A rejected B must not have cleared "painted",
      // so the retained frame is at the right size and nothing repaints.
      const passesAfterB =
        imageProcessingMocks.yieldImageWork.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      await drain();
      expect(imageProcessingMocks.yieldImageWork).toHaveBeenCalledTimes(
        passesAfterB,
      );
      expect(livePaints()).toBe(1);
    });

    it("keeps the retained frame through a zero-size or same-size resize", async () => {
      const { liveMutations, drain, resize } = setup();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await drain();
      const framePainted = liveMutations();
      const passes = imageProcessingMocks.yieldImageWork.mock.calls.length;
      expect(framePainted).toBeGreaterThan(0);

      // A hidden/collapsed surface reports 0x0; that must not clear the frame.
      await resize(0, 0);
      await drain();
      expect(liveMutations()).toBe(framePainted);
      expect(imageProcessingMocks.yieldImageWork).toHaveBeenCalledTimes(passes);

      // Back to the size the frame was drawn at: nothing to repaint.
      await resize(2000, 2000);
      await drain();
      expect(liveMutations()).toBe(framePainted);
      expect(imageProcessingMocks.yieldImageWork).toHaveBeenCalledTimes(passes);
    });
  });
  it("paints the page veil and sub-1 opacity on the page surface only", () => {
    const wallpaper = {
      style: "photo",
      intensity: 0.6,
      tintWithAccent: false,
      name: "wallpaper.png",
      curatedId: null,
    } as const;
    const onPage = render(
      <AppearanceWallpaper
        wallpaper={wallpaper}
        url="blob:wallpaper"
        tint={null}
        surface="page"
      />,
    );
    expect(
      onPage.container.querySelector(".appearance-wallpaper-mask"),
    ).not.toBeNull();
    expect(onPage.container.querySelector("img")?.style.opacity).toBe("0.85");
    // The page's stacking context + containment class is the page's alone.
    expect(
      onPage.container.querySelector(".appearance-wallpaper"),
    ).not.toBeNull();
    onPage.unmount();

    const preview = render(
      <AppearanceWallpaper
        wallpaper={wallpaper}
        url="blob:wallpaper"
        tint={null}
        surface="preview"
      />,
    );
    expect(
      preview.container.querySelector(".appearance-wallpaper-mask"),
    ).toBeNull();
    expect(preview.container.querySelector("img")?.style.opacity).toBe("1");
    expect(preview.container.querySelector(".appearance-wallpaper")).toBeNull();
    expect(
      preview.container.querySelector('[data-wallpaper-surface="preview"]'),
    ).not.toBeNull();
  });
});
