import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";
import type { ImageAssetMeta } from "@/hooks/assets/use-image-asset";
import { ImagePreview } from "../image-preview";
import type { ImagePreviewTransformReport } from "../image-preview-transform";

interface ResizeObserverProbe {
  readonly trigger: (width: number, height: number) => void;
}

const observers: Array<ResizeObserverProbe> = [];

class ControllableResizeObserver implements ResizeObserverProbe {
  private readonly callback: ResizeObserverCallback;
  private target: Element | null = null;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }

  observe(target: Element): void {
    this.target = target;
  }

  unobserve(target: Element): void {
    if (this.target === target) this.target = null;
  }

  disconnect(): void {
    this.target = null;
  }

  trigger(width: number, height: number): void {
    const target = this.target;
    if (target === null) return;
    this.callback(
      [
        {
          target,
          contentRect: new DOMRect(0, 0, width, height),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    );
  }
}

const META: ImageAssetMeta = {
  mediaType: "image/png",
  sizeBytes: 2048,
  width: 640,
  height: 480,
};

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "Date", "performance"],
  });
});

afterEach(() => {
  cleanup();
  observers.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("react-zoom-pan-pinch 4.0.4 timing contract", () => {
  it("delivers zero-duration setTransform and centerView callbacks in the same tick", () => {
    const transformRef = createRef<ReactZoomPanPinchRef>();
    let callbackCount = 0;
    let callbackObservedBeforeReturn = false;

    render(
      <TransformWrapper
        ref={transformRef}
        initialScale={1}
        initialPositionX={0}
        initialPositionY={0}
        minScale={0.1}
        maxScale={8}
        centerOnInit={false}
        onTransform={() => {
          callbackCount += 1;
          callbackObservedBeforeReturn = true;
        }}
      >
        <TransformComponent>
          <div>image</div>
        </TransformComponent>
      </TransformWrapper>,
    );

    const ref = transformRef.current;
    if (ref === null) throw new Error("TransformWrapper ref was not mounted");

    callbackObservedBeforeReturn = false;
    ref.setTransform(0, 0, 1.25, 0);
    expect(callbackObservedBeforeReturn).toBe(true);
    expect(callbackCount).toBe(1);

    callbackObservedBeforeReturn = false;
    ref.centerView(1.5, 0);
    expect(callbackObservedBeforeReturn).toBe(true);
    expect(callbackCount).toBe(2);
  });

  it("keeps a manually zoomed ImagePreview out of the resize refit path", () => {
    vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains("image-preview-checkerboard")) {
          return new DOMRect(0, 0, 800, 600);
        }
        return new DOMRect();
      },
    );

    const reports: Array<ImagePreviewTransformReport> = [];
    render(
      <ImagePreview
        status="ready"
        url="blob:real-library"
        meta={META}
        servedFromCache={false}
        fileName="photo.png"
        compact={false}
        gesturesEnabled
        animationMs={0}
        transformRef={null}
        onTransformChange={(report) => reports.push(report)}
        doubleClickOverride={null}
        onDecodeError={null}
      />,
    );

    const image = screen.getByRole("img", { name: "photo.png" });
    Object.defineProperty(image, "naturalWidth", {
      configurable: true,
      value: 640,
    });
    Object.defineProperty(image, "naturalHeight", {
      configurable: true,
      value: 480,
    });

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const reportBeforeResize = reports.at(-1);
    if (reportBeforeResize === undefined) {
      throw new Error("manual zoom did not report a transform");
    }
    expect(reportBeforeResize.isFitted).toBe(false);

    const reportCountBeforeResize = reports.length;
    act(() => {
      for (const observer of [...observers]) {
        observer.trigger(600, 400);
      }
    });

    expect(reports).toHaveLength(reportCountBeforeResize);
    expect(reports.at(-1)?.state.scale).toBe(reportBeforeResize.state.scale);
  });

  it("standalone Zoom In settles at an increased scale and stays there", () => {
    vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains("image-preview-checkerboard")) {
          return new DOMRect(0, 0, 800, 600);
        }
        return new DOMRect();
      },
    );

    const reports: Array<ImagePreviewTransformReport> = [];
    render(
      <ImagePreview
        status="ready"
        url="blob:animated"
        meta={META}
        servedFromCache={false}
        fileName="photo.png"
        compact={false}
        gesturesEnabled
        animationMs={200}
        transformRef={null}
        onTransformChange={(report) => reports.push(report)}
        doubleClickOverride={null}
        onDecodeError={null}
      />,
    );

    const initialScale = reports.at(-1)?.state.scale;
    if (initialScale === undefined) {
      throw new Error("initial transform was not reported");
    }

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    act(() => {
      vi.advanceTimersByTime(300);
    });

    const finalScale = reports.at(-1)?.state.scale;
    expect(finalScale).toBeGreaterThan(initialScale);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(reports.at(-1)?.state.scale).toBe(finalScale);
  });
});
