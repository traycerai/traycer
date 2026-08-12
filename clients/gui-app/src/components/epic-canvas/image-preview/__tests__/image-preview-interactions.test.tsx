import { forwardRef, useImperativeHandle, useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  ImageAssetMeta,
  UseImageAssetResult,
} from "@/hooks/assets/use-image-asset";
import type { ImagePreviewTransformState } from "../image-preview-transform";

interface MockTransformRef {
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
  };
}

interface MockTransformInstance {
  readonly id: number;
  disabled: boolean;
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
  readonly children?: ReactNode;
}

const state = vi.hoisted(() => ({
  instances: [] as Array<MockTransformInstance>,
  nextId: 0,
  oldAsset: null as UseImageAssetResult | null,
  newAsset: null as UseImageAssetResult | null,
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

    function emitTransform(): void {
      const transform = transformRef.current;
      const instance = instanceRef.current;
      if (transform === null || instance === null) return;
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
        emitTransform();
      }

      const ref: MockTransformRef = {
        centerView: (scale, animationMs) => {
          centerViewCalls.push([scale, animationMs]);
          const transform = transformRef.current;
          if (transform === null) return;
          transformRef.current = {
            positionX: 0,
            positionY: 0,
            scale,
          };
          emitTransform();
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
        },
        instance: {
          wrapperComponent: {
            getBoundingClientRect: () => ({ width: 800, height: 600 }),
          },
          contentComponent: {
            offsetWidth: 640,
            offsetHeight: 480,
          },
        },
      };

      const instance: MockTransformInstance = {
        id: state.nextId,
        disabled: props.disabled === true,
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
            transformRef.current = {
              positionX: 12,
              positionY: -7,
              scale: 1.75,
            };
            emitTransform();
          }}
        >
          Gesture
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
};

function readyAsset(url: string): UseImageAssetResult {
  return {
    status: "ready",
    url,
    meta: META,
    reason: null,
    receivedBytes: 2048,
    totalBytes: 2048,
    reportDecodeFailure: vi.fn(),
  };
}

function renderPreview(compact: boolean): void {
  render(
    <ImagePreview
      status="ready"
      url="blob:image"
      meta={META}
      fileName="photo.png"
      compact={compact}
      gesturesEnabled={!compact}
      animationMs={200}
      transformRef={null}
      onTransformChange={null}
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
});

afterEach(() => {
  cleanup();
});

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
    renderPreview(false);

    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });

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
});
