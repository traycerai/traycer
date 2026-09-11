import {
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  BROWSER_VIEWPORT_MIN_EDGE,
  BROWSER_VIEWPORT_MAX_EDGE,
} from "@traycer/protocol/host/browser/viewport";
import type {
  BrowserViewportController,
  BrowserViewportOrigin,
} from "./use-browser-viewport";
import { cn } from "@/lib/utils";
import { useAnimationFrameThrottle } from "@/hooks/use-animation-frame-throttle";

const HANDLES = [
  {
    name: "left",
    axis: "width",
    label: "Resize viewport width from left",
    x: -1,
    y: 0,
    className: "top-1/2 -left-6 -translate-y-1/2 cursor-ew-resize",
    gripClassName: "",
  },
  {
    name: "right",
    axis: "width",
    label: "Resize viewport width",
    x: 1,
    y: 0,
    className: "top-1/2 -right-6 -translate-y-1/2 cursor-ew-resize",
    gripClassName: "",
  },
  {
    name: "bottom",
    axis: "height",
    label: "Resize viewport height",
    x: 0,
    y: 1,
    className: "-bottom-6 left-1/2 -translate-x-1/2 cursor-ns-resize",
    gripClassName: "rotate-90",
  },
  {
    name: "bottom-left",
    axis: "both",
    label: "Resize viewport from bottom left",
    x: -1,
    y: 1,
    className: "-bottom-6 -left-6 cursor-nesw-resize",
    gripClassName: "-rotate-45",
  },
  {
    name: "bottom-right",
    axis: "both",
    label: "Resize viewport from bottom right",
    x: 1,
    y: 1,
    className: "-right-6 -bottom-6 cursor-nwse-resize",
    gripClassName: "rotate-45",
  },
] as const;

type ResizeHandle = (typeof HANDLES)[number];
type ResizeSize = { readonly width: number; readonly height: number };

interface ResizeDrag {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly handle: ResizeHandle;
  readonly origin: BrowserViewportOrigin;
  pending: ResizeSize | null;
}

export function BrowserViewportHandles({
  controller,
  scrollRef,
}: {
  readonly controller: BrowserViewportController | null;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
}) {
  if (controller === null || !controller.expanded || controller.disabled)
    return null;
  return <ViewportHandles controller={controller} scrollRef={scrollRef} />;
}

function ViewportHandles({
  controller,
  scrollRef,
}: {
  readonly controller: BrowserViewportController;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const drag = useRef<ResizeDrag | null>(null);
  const keyboardSize = useRef<ResizeSize | null>(null);
  const keyboardGeneration = useRef(0);
  const endKeyboardResize = (): void => {
    keyboardSize.current = null;
    keyboardGeneration.current += 1;
  };
  const applyPending = (current: ResizeDrag): void => {
    const size = current.pending;
    current.pending = null;
    if (size === null || controller.disabled || !controller.expanded) return;
    void controller
      .resize(size.width, size.height, current.origin)
      .catch(() => undefined);
  };
  const resize = useAnimationFrameThrottle((current: ResizeDrag) => {
    if (drag.current === current) applyPending(current);
  });
  const dimensions = controller.size;
  if (dimensions === null) return null;
  const start = (
    event: PointerEvent<HTMLElement>,
    handle: ResizeHandle,
  ): void => {
    const scroll = scrollRef.current;
    const frame = event.currentTarget.parentElement;
    if (event.button !== 0 || scroll === null || frame === null) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    endKeyboardResize();
    // Keep the grip's pixel-to-CSS conversion stable as dimensions change.
    // Dragging chooses this visible percentage; Auto fit and Reset opt back in.
    if (controller.previewScaleSetting === null)
      controller.setPreviewScale(controller.previewScale);
    const frameRect = frame.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    let anchor: 0 | 0.5 | 1 = 0;
    if (handle.x < 0) anchor = 1;
    else if (handle.x === 0) anchor = 0.5;
    const origin: BrowserViewportOrigin = {
      x:
        frameRect.left -
        scrollRect.left -
        scroll.clientLeft +
        scroll.scrollLeft -
        24 +
        frameRect.width * anchor,
      anchor,
      scrollLeft: scroll.scrollLeft,
      scrollTop: scroll.scrollTop,
      availableWidth: scroll.clientWidth - 48,
      availableHeight: scroll.clientHeight - 48,
    };
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      ...dimensions,
      scale: controller.resizeScale,
      handle,
      origin,
      pending: null,
    };
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    const initial = drag.current;
    if (initial === null) return;
    // The frame preserves the opposite edge and its scroll position. Each
    // painted pixel therefore maps to the same CSS distance across overflow.
    const widthDelta =
      ((event.clientX - initial.x) * initial.handle.x) / initial.scale;
    const heightDelta =
      ((event.clientY - initial.y) * initial.handle.y) / initial.scale;
    let axis = initial.handle.axis;
    if (axis === "both") {
      axis =
        Math.abs(widthDelta / initial.width) >=
        Math.abs(heightDelta / initial.height)
          ? "width"
          : "height";
    }
    initial.pending = withRatio(
      {
        width: Math.round(initial.width + widthDelta),
        height: Math.round(initial.height + heightDelta),
      },
      controller.ratio,
      axis,
    );
    resize(initial);
  };
  const keyDown = (
    event: KeyboardEvent<HTMLElement>,
    handle: ResizeHandle,
  ): void => {
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    if (!horizontal && !vertical) return;
    if (handle.axis === "width" && !horizontal) return;
    if (handle.axis === "height" && !vertical) return;
    drag.current = null;
    event.preventDefault();
    const axis = horizontal ? "width" : "height";
    const increase = event.key === "ArrowRight" || event.key === "ArrowDown";
    let amount = (increase ? 1 : -1) * (event.shiftKey ? 10 : 1);
    if (horizontal && handle.x < 0) amount *= -1;
    const size = keyboardSize.current ?? dimensions;
    const next = withRatio(
      { ...size, [axis]: size[axis] + amount },
      controller.ratio,
      axis,
    );
    keyboardSize.current = next;
    const generation = ++keyboardGeneration.current;
    const settled = (): void => {
      if (keyboardGeneration.current === generation)
        keyboardSize.current = null;
    };
    void controller
      .resize(next.width, next.height, null)
      .then(settled, settled);
  };
  return (
    <>
      {HANDLES.map((handle) => {
        const corner = handle.axis === "both";
        const Tag = corner ? "button" : "div";
        const orientation = handle.axis === "width" ? "vertical" : "horizontal";
        return (
          <Tag
            key={handle.name}
            type={corner ? "button" : undefined}
            role={corner ? undefined : "separator"}
            data-viewport-action
            aria-label={handle.label}
            aria-orientation={corner ? undefined : orientation}
            aria-valuenow={corner ? undefined : dimensions[handle.axis]}
            aria-valuemin={corner ? undefined : BROWSER_VIEWPORT_MIN_EDGE}
            aria-valuemax={corner ? undefined : BROWSER_VIEWPORT_MAX_EDGE}
            tabIndex={0}
            className={cn(
              "absolute z-30 flex size-6 touch-none items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              handle.className,
            )}
            onPointerDown={(event) => start(event, handle)}
            onPointerMove={move}
            onPointerUp={() => {
              const current = drag.current;
              drag.current = null;
              if (current !== null) applyPending(current);
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onLostPointerCapture={() => {
              drag.current = null;
            }}
            onKeyDown={(event) => keyDown(event, handle)}
            onBlur={endKeyboardResize}
          >
            <span
              aria-hidden
              className={cn(
                "pointer-events-none flex gap-0.5",
                handle.gripClassName,
              )}
            >
              <span className="h-3.5 w-0.5 rounded-full bg-current" />
              <span className="h-3.5 w-0.5 rounded-full bg-current" />
            </span>
          </Tag>
        );
      })}
    </>
  );
}

function withRatio(
  size: ResizeSize,
  ratio: number | null,
  axis: "width" | "height",
): ResizeSize {
  if (ratio === null) return size;
  return axis === "width"
    ? { width: size.width, height: Math.round(size.width / ratio) }
    : { width: Math.round(size.height * ratio), height: size.height };
}
