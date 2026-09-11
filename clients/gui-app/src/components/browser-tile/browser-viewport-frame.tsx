import {
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import { BrowserViewportHandles } from "./browser-viewport-handles";
import type {
  BrowserViewportOrigin,
  BrowserViewportPresentation,
} from "./use-browser-viewport";

/** Shared geometry keeps native guests and streamed previews in the same frame. */
export function BrowserViewportFrame({
  viewport,
  surfaceRef,
  children,
}: {
  readonly viewport: BrowserViewportPresentation;
  readonly surfaceRef: RefObject<HTMLDivElement | null> | null;
  readonly children: ReactNode;
}) {
  const { areaRef, scrollRef, controller, paintedSize } = viewport;
  const expanded = controller?.expanded === true;
  const origin = controller?.previewOrigin ?? null;
  const previousOrigin = useRef<BrowserViewportOrigin | null>(null);
  const width = paintedSize?.width ?? 0;
  const height = paintedSize?.height ?? 0;
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null) return;
    const hadOrigin = previousOrigin.current !== null;
    previousOrigin.current = origin;
    if (origin === null) {
      if (hadOrigin) {
        scroll.scrollLeft = 0;
        scroll.scrollTop = 0;
      }
      return;
    }
    scroll.scrollLeft =
      origin.scrollLeft + Math.max(0, width * origin.anchor - origin.x);
    scroll.scrollTop = origin.scrollTop;
  }, [scrollRef, origin, width, height]);
  return (
    <div
      ref={areaRef}
      className={cn(
        "relative min-h-0 flex-1 overflow-hidden",
        expanded && "bg-foreground/8",
      )}
    >
      <div ref={scrollRef} className="relative h-full w-full overflow-auto">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ anchorName: "var(--browser-clip-size-anchor)" }}
        />
        <div
          className={cn(
            "flex",
            origin === null ? "justify-center" : "justify-start",
            expanded
              ? "min-h-full w-max min-w-full items-start p-6"
              : "h-full w-full",
          )}
        >
          <div
            ref={surfaceRef}
            className={cn(
              "relative min-h-0 shrink-0 bg-background",
              paintedSize === null && "h-full w-full",
              expanded && "ring-1 ring-border",
            )}
            style={frameStyle(paintedSize, origin)}
          >
            <BrowserViewportHandles
              controller={controller}
              scrollRef={scrollRef}
            />
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function frameStyle(
  size: BrowserViewportPresentation["paintedSize"],
  origin: BrowserViewportOrigin | null,
): CSSProperties | undefined {
  if (size === null) return undefined;
  if (origin === null) return size;
  const left = origin.x - size.width * origin.anchor;
  // These are visible margins on the real frame. They preserve the anchored
  // edge when shrinking would otherwise clamp the scroll offset and move it.
  return {
    ...size,
    marginLeft: Math.max(0, left),
    marginRight: Math.max(
      0,
      origin.scrollLeft + origin.availableWidth - left - size.width,
    ),
    marginBottom: Math.max(
      0,
      origin.scrollTop + origin.availableHeight - size.height,
    ),
  };
}
