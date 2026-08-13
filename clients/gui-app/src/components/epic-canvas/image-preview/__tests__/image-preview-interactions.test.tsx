import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type {
  ImageAssetMeta,
  UseImageAssetResult,
} from "@/hooks/assets/use-image-asset";
import type { ImagePreviewTransformState } from "../image-preview-transform";

interface MockTransformRef {
  /** Mirrors the real library's `ref.state` - production's `handleInit` seeds from it directly. */
  readonly state: ImagePreviewTransformState;
  readonly centerView: (scale: number, animationMs: number) => void;
  readonly zoomIn: (step: number, animationMs: number) => void;
  readonly zoomOut: (step: number, animationMs: number) => void;
  readonly setTransform: (
    positionX: number,
    positionY: number,
    scale: number,
    animationMs: number,
  ) => void;
  readonly instance: {
    readonly wrapperComponent: {
      readonly getBoundingClientRect: () => {
        readonly width: number;
        readonly height: number;
      };
    };
    readonly contentComponent: {
      readonly offsetWidth: number;
      readonly offsetHeight: number;
    };
    readonly setup: {
      readonly minScale: number;
      readonly maxScale: number;
    };
  };
}

interface MockTransformInstance {
  readonly id: number;
  disabled: boolean;
  currentTransform: ImagePreviewTransformState;
  readonly centerViewCalls: Array<readonly [number, number]>;
  readonly zoomInCalls: Array<readonly [number, number]>;
  readonly zoomOutCalls: Array<readonly [number, number]>;
  readonly setTransformCalls: Array<readonly [number, number, number, number]>;
  readonly ref: MockTransformRef;
}

interface MockTransformWrapperProps {
  readonly initialScale: number;
  readonly initialPositionX: number;
  readonly initialPositionY: number;
  readonly minScale: number;
  readonly maxScale: number;
  readonly disabled?: boolean;
  readonly onTransform?: (
    ref: MockTransformRef,
    state: ImagePreviewTransformState,
  ) => void;
  readonly onInit?: (ref: MockTransformRef) => void;
  readonly onPanningStart?: () => void;
  readonly onPanning?: () => void;
  readonly onPanningStop?: () => void;
  readonly children?: ReactNode;
}

const state = vi.hoisted(() => ({
  instances: [] as Array<MockTransformInstance>,
  nextId: 0,
  oldAsset: null as UseImageAssetResult | null,
  newAsset: null as UseImageAssetResult | null,
  stageRect: { width: 800, height: 600 },
}));

vi.mock("react-zoom-pan-pinch", () => {
  const TransformWrapper = forwardRef<
    MockTransformRef,
    MockTransformWrapperProps
  >((props, forwardedRef) => {
    const propsRef = useRef(props);
    propsRef.current = props;
    const transformRef = useRef<{
      readonly positionX: number;
      readonly positionY: number;
      readonly scale: number;
    } | null>(null);
    const instanceRef = useRef<MockTransformInstance | null>(null);

    if (transformRef.current === null) {
      transformRef.current = {
        positionX: props.initialPositionX,
        positionY: props.initialPositionY,
        scale: props.initialScale,
      };
    }

    function emitTransform(
      transform: {
        readonly positionX: number;
        readonly positionY: number;
        readonly scale: number;
      } | null,
    ): void {
      const instance = instanceRef.current;
      if (transform === null || instance === null) return;
      instance.currentTransform = { ...transform };
      propsRef.current.onTransform?.(instance.ref, { ...transform });
    }

    if (instanceRef.current === null) {
      const centerViewCalls: Array<readonly [number, number]> = [];
      const zoomInCalls: Array<readonly [number, number]> = [];
      const zoomOutCalls: Array<readonly [number, number]> = [];
      const setTransformCalls: Array<
        readonly [number, number, number, number]
      > = [];

      function setScale(nextScale: number): void {
        const transform = transformRef.current;
        if (transform === null) return;
        const minScale = propsRef.current.minScale;
        const maxScale = propsRef.current.maxScale;
        transformRef.current = {
          ...transform,
          scale: Math.min(Math.max(nextScale, minScale), maxScale),
        };
        emitTransform(transformRef.current);
      }

      const ref: MockTransformRef = {
        // Live (not a snapshot), matching the real library: `onInit` fires
        // once transformRef.current is already seeded from the initial
        // props, so a live getter (not a value captured at `ref` creation
        // time) is what makes that ordering matter for the test too.
        get state() {
          return (
            transformRef.current ?? {
              positionX: props.initialPositionX,
              positionY: props.initialPositionY,
              scale: props.initialScale,
            }
          );
        },
        centerView: (scale, animationMs) => {
          centerViewCalls.push([scale, animationMs]);
          const transform = transformRef.current;
          if (transform === null) return;
          transformRef.current = {
            positionX: 0,
            positionY: 0,
            scale,
          };
          emitTransform(transformRef.current);
        },
        zoomIn: (step, animationMs) => {
          zoomInCalls.push([step, animationMs]);
          const transform = transformRef.current;
          if (transform !== null) setScale(transform.scale + step);
        },
        zoomOut: (step, animationMs) => {
          zoomOutCalls.push([step, animationMs]);
          const transform = transformRef.current;
          if (transform !== null) setScale(transform.scale - step);
        },
        setTransform: (positionX, positionY, scale, animationMs) => {
          setTransformCalls.push([positionX, positionY, scale, animationMs]);
          transformRef.current = { positionX, positionY, scale };
          emitTransform(transformRef.current);
        },
        instance: {
          wrapperComponent: {
            getBoundingClientRect: () => ({ width: 800, height: 600 }),
          },
          contentComponent: {
            offsetWidth: 640,
            offsetHeight: 480,
          },
          // Live (not a snapshot) - matches the real library keeping
          // `instance.setup` in sync with the current props on every
          // update, since production reads `minScale`/`maxScale` off this
          // at both `onInit` and every `onTransform` firing.
          get setup() {
            return {
              minScale: propsRef.current.minScale,
              maxScale: propsRef.current.maxScale,
            };
          },
        },
      };

      const instance: MockTransformInstance = {
        id: state.nextId,
        disabled: props.disabled === true,
        currentTransform: {
          positionX: props.initialPositionX,
          positionY: props.initialPositionY,
          scale: props.initialScale,
        },
        centerViewCalls,
        zoomInCalls,
        zoomOutCalls,
        setTransformCalls,
        ref,
      };
      state.nextId += 1;
      instanceRef.current = instance;
      state.instances.push(instance);
    }

    const instance = instanceRef.current;
    instance.disabled = props.disabled === true;
    useImperativeHandle(forwardedRef, () => instance.ref, [instance.ref]);

    // Fires exactly once at mount, matching the real library's `onInit`
    // (production relies on this - RZPP applies its initial transform
    // without ever calling `onTransform`).
    const initializedRef = useRef(false);
    useLayoutEffect(() => {
      if (initializedRef.current) return;
      initializedRef.current = true;
      propsRef.current.onInit?.(instance.ref);
    }, [instance.ref]);

    return (
      <div
        data-testid={`rzpp-wrapper-${instance.id}`}
        data-disabled={String(props.disabled === true)}
      >
        <button
          type="button"
          data-testid={`rzpp-gesture-${instance.id}`}
          onClick={() => {
            const transform = transformRef.current;
            if (transform === null) return;
            propsRef.current.onPanningStart?.();
            transformRef.current = {
              positionX: 12,
              positionY: -7,
              scale: 1.75,
            };
            propsRef.current.onPanning?.();
            emitTransform(transformRef.current);
            propsRef.current.onPanningStop?.();
          }}
        >
          Gesture
        </button>
        <button
          type="button"
          data-testid={`rzpp-wheel-gesture-${instance.id}`}
          onClick={() => {
            const transform = transformRef.current;
            if (transform === null) return;
            transformRef.current = {
              ...transform,
              scale: 0.19,
            };
            // Ctrl-wheel/trackpad zoom reports a transform without a
            // panning-start callback; this is the path that used to leave a
            // manually tracked `isFitted` flag stale.
            emitTransform(transformRef.current);
          }}
        >
          Wheel zoom out
        </button>
        <button
          type="button"
          data-testid={`rzpp-mismatched-gesture-${instance.id}`}
          onClick={() => {
            const transform = transformRef.current;
            if (transform === null) return;
            // Synthetic wheel gesture for the mismatched-dimensions test:
            // deliberately put the source position outside the peer's
            // visible bounds so the peer must clamp at its own scale.
            transformRef.current = {
              ...transform,
              positionX: 1_000,
              positionY: -1_000,
              scale: 0.19,
            };
            emitTransform(transformRef.current);
          }}
        >
          Mismatched gesture
        </button>
        {props.children}
      </div>
    );
  });

  const TransformComponent = (props: {
    readonly children?: ReactNode;
  }): ReactNode => (
    <div data-testid="rzpp-transform-component">{props.children}</div>
  );

  return { TransformWrapper, TransformComponent };
});

vi.mock("@/hooks/assets/use-image-asset", () => ({
  useImageAsset: (request: { readonly side?: "old" | "new" } | null) => {
    const asset = request?.side === "old" ? state.oldAsset : state.newAsset;
    if (asset === null) throw new Error("missing image asset state");
    return asset;
  },
}));

const resizeObservers: Array<ControllableResizeObserver> = [];

class ControllableResizeObserver implements ResizeObserver {
  private readonly callback: ResizeObserverCallback;
  private target: Element | null = null;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    this.target = target;
    resizeObservers.push(this);
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

import { ImageDiffView, type ImageDiffViewProps } from "../image-diff-view";
import { ImagePreview } from "../image-preview";

const META: ImageAssetMeta = {
  mediaType: "image/png",
  sizeBytes: 2048,
  width: 640,
  height: 480,
};

const DIFF_PROPS: ImageDiffViewProps = {
  runningDir: "/repo",
  filePath: "images/current.png",
  previousPath: null,
  oldStage: "staged",
  newStage: "unstaged",
  fileName: "current.png",
  conflicted: false,
  compact: false,
  onOpenExternally: null,
  openExternallyOpening: false,
  revisionKey: "revision-1",
};

function readyAsset(url: string): UseImageAssetResult {
  return {
    status: "ready",
    url,
    meta: META,
    reason: null,
    totalBytes: 2048,
    servedFromCache: false,
    reportDecodeFailure: vi.fn(),
  };
}

function renderPreview(compact: boolean): void {
  render(
    <ImagePreview
      status="ready"
      url="blob:image"
      meta={META}
      servedFromCache={false}
      fileName="photo.png"
      compact={compact}
      gesturesEnabled={!compact}
      animationMs={200}
      transformRef={null}
      onTransformChange={null}
      doubleClickOverride={null}
      onDecodeError={null}
    />,
  );
}

function renderDiff(overrides: Partial<ImageDiffViewProps>): void {
  render(<ImageDiffView {...DIFF_PROPS} {...overrides} />);
}

beforeEach(() => {
  state.instances.length = 0;
  state.nextId = 0;
  state.oldAsset = readyAsset("blob:old");
  state.newAsset = readyAsset("blob:new");
  state.stageRect = { width: 800, height: 600 };
  vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains("image-preview-checkerboard")) {
        return new DOMRect(0, 0, state.stageRect.width, state.stageRect.height);
      }
      return new DOMRect();
    },
  );
});

afterEach(() => {
  cleanup();
  resizeObservers.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function triggerStageResize(width: number, height: number): void {
  act(() => {
    state.stageRect = { width, height };
    for (const observer of [...resizeObservers]) {
      observer.trigger(width, height);
    }
  });
}

describe("image preview interactions", () => {
  it("distinguishes fit, intermediate zoom, and actual-size states", () => {
    renderPreview(false);

    const fitButton = screen.getByRole("button", { name: "Fit to screen" });
    const actualButton = screen.getByRole("button", { name: "Actual size" });
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });

    expect(fitButton.getAttribute("aria-pressed")).toBe("true");
    expect(actualButton.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(zoomIn);
    fireEvent.click(zoomIn);

    expect(fitButton.getAttribute("aria-pressed")).toBe("false");
    expect(actualButton.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(actualButton);

    expect(fitButton.getAttribute("aria-pressed")).toBe("false");
    expect(actualButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("disables zoom controls at the minimum and maximum boundaries", () => {
    state.stageRect = { width: 320, height: 240 };
    renderPreview(false);

    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });

    fireEvent.click(zoomOut);
    expect(zoomOut.hasAttribute("disabled")).toBe(true);

    for (let index = 0; index < 50; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    }
    expect(zoomIn.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));
    for (let index = 0; index < 50; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    }
    expect(zoomOut.hasAttribute("disabled")).toBe(true);
  });

  it("keeps the toolbar above an isolated, clipped stage", () => {
    renderPreview(false);

    const toolbar = screen.getByRole("toolbar", {
      name: "Image preview controls",
    });
    const stage = document.querySelector(".image-preview-checkerboard");

    expect(toolbar.className).toContain("relative");
    expect(toolbar.className).toContain("z-10");
    expect(stage).not.toBeNull();
    expect(stage?.className).toContain("overflow-hidden");
    expect(stage?.className).toContain("isolate");
  });

  it("does not snap a huge image above its true fit after a wheel zoom-out and resize", () => {
    const largeMeta: ImageAssetMeta = {
      ...META,
      width: 4_000,
      height: 3_000,
    };

    render(
      <ImagePreview
        status="ready"
        url="blob:large-image"
        meta={largeMeta}
        servedFromCache={false}
        fileName="large.png"
        compact={false}
        gesturesEnabled
        animationMs={200}
        transformRef={null}
        onTransformChange={null}
        doubleClickOverride={null}
        onDecodeError={null}
      />,
    );

    const image = screen.getByRole("img", { name: "large.png" });
    Object.defineProperty(image, "naturalWidth", {
      configurable: true,
      value: 4_000,
    });
    Object.defineProperty(image, "naturalHeight", {
      configurable: true,
      value: 3_000,
    });

    const instance = state.instances[0];
    expect(instance.currentTransform.scale).toBeLessThan(0.25);

    fireEvent.click(screen.getByTestId("rzpp-wheel-gesture-0"));

    expect(instance.currentTransform.scale).toBeCloseTo(0.19);
    triggerStageResize(800, 600);

    expect(instance.currentTransform.scale).toBeCloseTo(0.19);
    expect(instance.currentTransform.scale).not.toBeCloseTo(0.25);
    expect(instance.centerViewCalls).toHaveLength(0);
  });

  it("refits a fitted preview when its stage resizes", () => {
    renderPreview(false);

    expect(
      screen
        .getByRole("button", { name: "Fit to screen" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    const image = screen.getByRole("img", { name: "photo.png" });
    Object.defineProperty(image, "naturalWidth", {
      configurable: true,
      value: 640,
    });
    Object.defineProperty(image, "naturalHeight", {
      configurable: true,
      value: 480,
    });

    triggerStageResize(600, 400);

    expect(state.instances[0].centerViewCalls).toEqual([[0.7, 0]]);
  });

  it("does not crash when a manual zoom is followed by a stage resize", () => {
    renderPreview(false);

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
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    triggerStageResize(600, 400);

    expect(state.instances[0].currentTransform.scale).toBeGreaterThan(1);
    expect(state.instances[0].centerViewCalls).toHaveLength(0);
  });

  it("refreshes fit state and bounds after a ready-header-ready asset change", () => {
    const firstMeta = META;
    const secondMeta: ImageAssetMeta = {
      ...META,
      width: 4_000,
      height: 2_000,
    };
    const reports: Array<{
      readonly state: ImagePreviewTransformState;
      readonly isFitted: boolean;
      readonly minScale: number;
    }> = [];

    const { rerender } = render(
      <ImagePreview
        status="ready"
        url="blob:first-image"
        meta={firstMeta}
        servedFromCache={false}
        fileName="photo.png"
        compact={false}
        gesturesEnabled
        animationMs={0}
        transformRef={null}
        onTransformChange={(report) => {
          reports.push({
            state: report.state,
            isFitted: report.isFitted,
            minScale: report.minScale,
          });
        }}
        doubleClickOverride={null}
        onDecodeError={null}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Fit to screen" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    rerender(
      <ImagePreview
        status="header"
        url={null}
        meta={secondMeta}
        servedFromCache={false}
        fileName="photo.png"
        compact={false}
        gesturesEnabled
        animationMs={0}
        transformRef={null}
        onTransformChange={(report) => {
          reports.push({
            state: report.state,
            isFitted: report.isFitted,
            minScale: report.minScale,
          });
        }}
        doubleClickOverride={null}
        onDecodeError={null}
      />,
    );
    rerender(
      <ImagePreview
        status="ready"
        url="blob:second-image"
        meta={secondMeta}
        servedFromCache={false}
        fileName="photo.png"
        compact={false}
        gesturesEnabled
        animationMs={0}
        transformRef={null}
        onTransformChange={(report) => {
          reports.push({
            state: report.state,
            isFitted: report.isFitted,
            minScale: report.minScale,
          });
        }}
        doubleClickOverride={null}
        onDecodeError={null}
      />,
    );

    const refreshedReport = reports.at(-1);
    if (refreshedReport === undefined) {
      throw new Error("refreshed transform was not reported");
    }
    expect(
      screen
        .getByRole("button", { name: "Fit to screen" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(refreshedReport.isFitted).toBe(true);
    expect(refreshedReport.state.scale).toBeCloseTo(0.184, 3);
    expect(refreshedReport.state.positionX).toBeCloseTo(32);
    expect(refreshedReport.state.positionY).toBeCloseTo(116);
    expect(refreshedReport.minScale).toBeCloseTo(0.184, 3);
  });

  it("resets transform sync when a ready preview remounts at the same URL", () => {
    const { rerender } = render(
      <ImagePreview
        status="ready"
        url="blob:same-image"
        meta={META}
        servedFromCache={false}
        fileName="photo.png"
        compact={false}
        gesturesEnabled
        animationMs={0}
        transformRef={null}
        onTransformChange={null}
        doubleClickOverride={null}
        onDecodeError={null}
      />,
    );

    const fitButton = screen.getByRole("button", { name: "Fit to screen" });
    expect(fitButton.getAttribute("aria-pressed")).toBe("true");
    const initialFitScale = state.instances[0]?.currentTransform.scale;

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(fitButton.getAttribute("aria-pressed")).toBe("false");

    rerender(
      <ImagePreview
        status="header"
        url="blob:same-image"
        meta={META}
        servedFromCache={false}
        fileName="photo.png"
        compact={false}
        gesturesEnabled
        animationMs={0}
        transformRef={null}
        onTransformChange={null}
        doubleClickOverride={null}
        onDecodeError={null}
      />,
    );
    rerender(
      <ImagePreview
        status="ready"
        url="blob:same-image"
        meta={META}
        servedFromCache={false}
        fileName="photo.png"
        compact={false}
        gesturesEnabled
        animationMs={0}
        transformRef={null}
        onTransformChange={null}
        doubleClickOverride={null}
        onDecodeError={null}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Fit to screen" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Actual size" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(state.instances).toHaveLength(2);
    expect(state.instances[1]?.currentTransform.scale).toBeCloseTo(
      initialFitScale,
    );
  });
});

describe("linked image diff transforms", () => {
  it("mirrors a gesture once and guards toolbar dual-dispatch from echoing", () => {
    renderDiff({});

    expect(state.instances).toHaveLength(2);
    const oldInstance = state.instances[0];
    const newInstance = state.instances[1];

    fireEvent.click(screen.getByTestId("rzpp-gesture-0"));

    expect(newInstance.setTransformCalls).toEqual([[12, -7, 1.75, 0]]);
    expect(oldInstance.setTransformCalls).toHaveLength(0);

    newInstance.setTransformCalls.length = 0;
    oldInstance.setTransformCalls.length = 0;

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(oldInstance.zoomInCalls).toContainEqual([0.2, 0]);
    expect(newInstance.zoomInCalls).toContainEqual([0.2, 0]);
    expect(oldInstance.setTransformCalls).toHaveLength(0);
    expect(newInstance.setTransformCalls).toHaveLength(0);
  });

  it("disables both transform wrappers and all toolbars in compact mode", () => {
    renderDiff({ compact: true });

    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.queryAllByRole("toolbar")).toHaveLength(0);

    const wrappers = screen.getAllByTestId(/rzpp-wrapper-/);
    expect(wrappers).toHaveLength(2);
    expect(
      wrappers.every(
        (wrapper) => wrapper.getAttribute("data-disabled") === "true",
      ),
    ).toBe(true);
  });

  it("disables shared Zoom out immediately for an uncached huge diff image", () => {
    const largeMeta: ImageAssetMeta = {
      ...META,
      width: 4_000,
      height: 3_000,
    };
    state.oldAsset = { ...readyAsset("blob:old"), meta: largeMeta };
    state.newAsset = { ...readyAsset("blob:new"), meta: largeMeta };

    renderDiff({});

    expect(
      screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("clamps a mirrored mismatched gesture to the peer scale before its position bounds", () => {
    const largeMeta: ImageAssetMeta = {
      ...META,
      width: 4_000,
      height: 3_000,
    };
    state.oldAsset = { ...readyAsset("blob:old"), meta: META };
    state.newAsset = { ...readyAsset("blob:new"), meta: largeMeta };

    renderDiff({});

    const oldInstance = state.instances[0];

    fireEvent.click(screen.getByTestId("rzpp-mismatched-gesture-1"));

    expect(oldInstance.setTransformCalls).toEqual([[799, -119, 0.25, 0]]);
  });
});
