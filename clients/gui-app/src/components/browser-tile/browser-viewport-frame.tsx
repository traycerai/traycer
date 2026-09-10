import type { ReactNode, RefObject } from "react";
import { cn } from "@/lib/utils";
import { BrowserViewportHandles } from "./browser-viewport-handles";
import type { BrowserViewportPresentation } from "./use-browser-viewport";

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
            "flex justify-center",
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
            style={paintedSize ?? undefined}
          >
            <BrowserViewportHandles controller={controller} />
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
