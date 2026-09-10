import { useRef, type PointerEvent } from "react";
import {
  BROWSER_VIEWPORT_MIN_EDGE,
  BROWSER_VIEWPORT_MAX_EDGE,
} from "@traycer/protocol/host/browser/viewport";
import type { BrowserViewportController } from "./use-browser-viewport";
import { cn } from "@/lib/utils";
import { useAnimationFrameThrottle } from "@/hooks/use-animation-frame-throttle";

interface ResizeDrag {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  pending: { readonly width: number; readonly height: number } | null;
}

export function BrowserViewportHandles({
  controller,
}: {
  readonly controller: BrowserViewportController | null;
}) {
  const drag = useRef<ResizeDrag | null>(null);
  const applyPending = (current: ResizeDrag): void => {
    const size = current.pending;
    current.pending = null;
    if (
      size === null ||
      controller === null ||
      controller.disabled ||
      !controller.expanded
    )
      return;
    void controller.resize(size.width, size.height).catch(() => undefined);
  };
  const resize = useAnimationFrameThrottle((current: ResizeDrag) => {
    if (drag.current === current) applyPending(current);
  });
  if (
    controller === null ||
    !controller.expanded ||
    controller.disabled ||
    controller.size === null
  )
    return null;
  const start = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || controller.size === null) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    controller.claim();
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      ...controller.size,
      scale: controller.resizeScale,
      pending: null,
    };
  };
  const move = (
    event: PointerEvent<HTMLDivElement>,
    axis: "width" | "height",
  ): void => {
    const initial = drag.current;
    if (initial === null) return;
    const delta =
      axis === "width" ? event.clientX - initial.x : event.clientY - initial.y;
    const value = Math.round(initial[axis] + (2 * delta) / initial.scale);
    let width = axis === "width" ? value : initial.width;
    let height = axis === "height" ? value : initial.height;
    if (controller.ratio !== null) {
      if (axis === "width") height = Math.round(width / controller.ratio);
      else width = Math.round(height * controller.ratio);
    }
    initial.pending = { width, height };
    resize(initial);
  };
  return (
    <>
      {(["width", "height"] as const).map((axis) => (
        <div
          key={axis}
          role="separator"
          data-viewport-action
          aria-label={`Resize viewport ${axis}`}
          aria-orientation={axis === "width" ? "vertical" : "horizontal"}
          aria-valuenow={controller.size?.[axis]}
          aria-valuemin={BROWSER_VIEWPORT_MIN_EDGE}
          aria-valuemax={BROWSER_VIEWPORT_MAX_EDGE}
          tabIndex={0}
          className={cn(
            "group absolute z-30 touch-none rounded outline-none focus-visible:ring-2 focus-visible:ring-ring",
            axis === "width"
              ? "inset-y-1/4 -right-6 w-6 cursor-ew-resize"
              : "inset-x-1/4 -bottom-6 h-6 cursor-ns-resize",
          )}
          onPointerDown={start}
          onPointerMove={(event) => move(event, axis)}
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
          onKeyDown={(event) => {
            if (controller.size === null) return;
            const increase =
              axis === "width"
                ? event.key === "ArrowRight"
                : event.key === "ArrowDown";
            const decrease =
              axis === "width"
                ? event.key === "ArrowLeft"
                : event.key === "ArrowUp";
            if (!increase && !decrease) return;
            drag.current = null;
            event.preventDefault();
            const amount = (increase ? 1 : -1) * (event.shiftKey ? 10 : 1);
            const next = {
              ...controller.size,
              [axis]: controller.size[axis] + amount,
            };
            if (controller.ratio !== null) {
              if (axis === "width")
                next.height = Math.round(next.width / controller.ratio);
              else next.width = Math.round(next.height * controller.ratio);
            }
            void controller
              .resize(next.width, next.height)
              .catch(() => undefined);
          }}
        >
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute rounded bg-foreground/20 group-hover:bg-primary",
              axis === "width"
                ? "inset-y-0 left-1/2 w-1 -translate-x-1/2"
                : "inset-x-0 top-1/2 h-1 -translate-y-1/2",
            )}
          />
        </div>
      ))}
    </>
  );
}
