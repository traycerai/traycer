import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MousePointer2 } from "lucide-react";
import {
  containFit,
  type ScreencastFrameSize,
} from "@/lib/browser-view/sessions/screencast-input-encoding";
import type { AgentCursorPosition } from "@/lib/browser-view/sessions/use-screencast-session";
import { cn } from "@/lib/utils";

/** How long the cursor lingers after the agent's last pointer event. */
export const AGENT_CURSOR_LINGER_MS = 2_000;

type TrackedCursor = {
  readonly id: number;
  /** The press whose ripple is still on screen, if any. */
  readonly rippleId: number | null;
};

/**
 * The agent's pointer, drawn over the screencast surface.
 *
 * Plane-agnostic on purpose: the host sends coordinates normalized to the
 * geometry the viewer is looking at, and both surfaces (`<img>` and `<video>`)
 * are `object-contain` inside this same box, so one `frameSize` and one
 * contain-fit mapping serve JPEG and video alike. That mapping is the inverse
 * of the pointer input path's (`screencast-input-encoding.ts`), measured off
 * this overlay's own box rather than the surface element so a plane swap needs
 * nothing here.
 *
 * Purely decorative - `pointer-events: none`, no arm/epoch involvement, and it
 * dies with the tile because the frames that feed it ride the tile's own
 * screencast subscription.
 */
export function AgentCursorOverlay(props: {
  readonly cursor: AgentCursorPosition | null;
  readonly frameSize: ScreencastFrameSize | null;
}) {
  const { cursor, frameSize } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const markerRef = useRef<HTMLDivElement | null>(null);
  const [expiredId, setExpiredId] = useState<number | null>(null);
  const [tracked, setTracked] = useState<TrackedCursor | null>(null);

  // Adjusted during render (React's documented way to derive state from a
  // changing prop) rather than in an Effect: a press must not flash one frame
  // without its ripple.
  if (cursor !== null && tracked?.id !== cursor.id) {
    setTracked({
      id: cursor.id,
      rippleId:
        cursor.type === "down" ? cursor.id : (tracked?.rippleId ?? null),
    });
  }

  const cursorId = cursor?.id ?? null;
  useEffect(() => {
    if (cursorId === null) return;
    const timer = window.setTimeout(() => {
      setExpiredId(cursorId);
    }, AGENT_CURSOR_LINGER_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [cursorId]);

  // Measured at the event rather than through a ResizeObserver: the position
  // is only ever read the moment a cursor frame lands, and a tile resize
  // between two frames is corrected by the next one.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const marker = markerRef.current;
    if (container === null || marker === null) return;
    if (cursor === null || frameSize === null) return;
    const point = containedPoint(
      { width: container.clientWidth, height: container.clientHeight },
      frameSize,
      cursor,
    );
    if (point === null) return;
    marker.style.transform = `translate(${point.x}px, ${point.y}px)`;
  }, [cursor, frameSize]);

  const rippleId = tracked?.id === cursorId ? tracked.rippleId : null;
  const visible = cursor !== null && expiredId !== cursor.id;
  return (
    <div
      ref={containerRef}
      data-testid="browser-agent-cursor-overlay"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {cursor === null || frameSize === null ? null : (
        <div
          ref={markerRef}
          data-testid="browser-agent-cursor"
          data-visible={visible}
          className={cn(
            "absolute left-0 top-0 flex items-center gap-1 transition-opacity duration-300 motion-reduce:transition-none",
            visible ? "opacity-100" : "opacity-0",
          )}
        >
          {rippleId === null ? null : (
            <span
              key={rippleId}
              data-testid="browser-agent-cursor-ripple"
              className="agent-cursor-ripple absolute left-0 top-0 size-8 rounded-full border-2 border-primary"
            />
          )}
          <MousePointer2
            aria-hidden
            className="size-4 shrink-0 fill-primary text-primary drop-shadow-sm"
          />
          <span className="max-w-[24ch] truncate rounded-sm bg-primary px-1.5 py-0.5 text-ui-xs text-primary-foreground shadow-sm">
            {cursor.label}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Normalized surface coordinates to unscaled layout px inside this box - the
 * exact inverse of the pointer input path, off the box both read.
 */
function containedPoint(
  box: { readonly width: number; readonly height: number },
  frameSize: ScreencastFrameSize,
  cursor: AgentCursorPosition,
): { readonly x: number; readonly y: number } | null {
  const painted = containFit(box, frameSize);
  if (painted === null) return null;
  return {
    x: (box.width - painted.width) / 2 + cursor.normalizedX * painted.width,
    y: (box.height - painted.height) / 2 + cursor.normalizedY * painted.height,
  };
}
