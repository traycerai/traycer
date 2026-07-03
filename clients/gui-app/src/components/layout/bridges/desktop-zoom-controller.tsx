import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDesktopZoomBridge } from "@/hooks/runner/use-desktop-zoom-bridge";
import { appLogger } from "@/lib/logger";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import type { DesktopZoomBridge } from "@/lib/windows/types";

const INDICATOR_DISMISS_MS = 2_000;
const WHEEL_STEP_THRESHOLD_PX = 80;
const LINE_DELTA_PX = 16;
const PAGE_DELTA_PX = 800;
const PINCH_STEP_RATIO = 1.08;

export function DesktopZoomController() {
  const zoom = useDesktopZoomBridge();
  useZoomKeybindings(zoom);
  useZoomGestures(zoom);
  return <DesktopZoomIndicator zoom={zoom} />;
}

function useZoomKeybindings(zoom: DesktopZoomBridge | null): void {
  useEffect(() => {
    if (zoom === null) return;
    const unregisterIn = registerDynamicActionHandler("app.zoom.in", () => {
      void zoom.stepIn().catch((err) => {
        appLogger.errorSummary("[zoom] keybinding zoom in failed", {}, err);
      });
    });
    const unregisterOut = registerDynamicActionHandler("app.zoom.out", () => {
      void zoom.stepOut().catch((err) => {
        appLogger.errorSummary("[zoom] keybinding zoom out failed", {}, err);
      });
    });
    const unregisterReset = registerDynamicActionHandler(
      "app.zoom.reset",
      () => {
        void zoom.reset().catch((err) => {
          appLogger.errorSummary("[zoom] keybinding reset failed", {}, err);
        });
      },
    );
    return () => {
      unregisterIn();
      unregisterOut();
      unregisterReset();
    };
  }, [zoom]);
}

function useZoomGestures(zoom: DesktopZoomBridge | null): void {
  const pendingWheelDeltaRef = useRef(0);
  const previousGestureScaleRef = useRef(1);
  const queueRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    pendingWheelDeltaRef.current = 0;
    previousGestureScaleRef.current = 1;
    queueRef.current = null;
    if (zoom === null) return;

    const enqueue = (direction: 1 | -1) => {
      const currentQueue = queueRef.current ?? Promise.resolve();
      queueRef.current = currentQueue
        .then(() => (direction > 0 ? zoom.stepIn() : zoom.stepOut()))
        .then(() => undefined)
        .catch((err) => {
          appLogger.errorSummary("[zoom] gesture step failed", {}, err);
        });
    };

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      pendingWheelDeltaRef.current += wheelDeltaToPixels(event);
      while (
        Math.abs(pendingWheelDeltaRef.current) >= WHEEL_STEP_THRESHOLD_PX
      ) {
        if (pendingWheelDeltaRef.current < 0) {
          enqueue(1);
          pendingWheelDeltaRef.current += WHEEL_STEP_THRESHOLD_PX;
        } else {
          enqueue(-1);
          pendingWheelDeltaRef.current -= WHEEL_STEP_THRESHOLD_PX;
        }
      }
    };

    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      previousGestureScaleRef.current = readGestureScale(event) ?? 1;
    };

    const handleGestureChange = (event: Event) => {
      const scale = readGestureScale(event);
      if (scale === null) return;
      event.preventDefault();
      event.stopPropagation();
      const previous = previousGestureScaleRef.current;
      if (scale >= previous * PINCH_STEP_RATIO) {
        enqueue(1);
        previousGestureScaleRef.current = scale;
      } else if (scale <= previous / PINCH_STEP_RATIO) {
        enqueue(-1);
        previousGestureScaleRef.current = scale;
      }
    };

    window.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: false,
    });
    window.addEventListener("gesturestart", handleGestureStart, {
      capture: true,
    });
    window.addEventListener("gesturechange", handleGestureChange, {
      capture: true,
    });
    return () => {
      window.removeEventListener("wheel", handleWheel, { capture: true });
      window.removeEventListener("gesturestart", handleGestureStart, {
        capture: true,
      });
      window.removeEventListener("gesturechange", handleGestureChange, {
        capture: true,
      });
    };
  }, [zoom]);
}

function DesktopZoomIndicator(props: {
  readonly zoom: DesktopZoomBridge | null;
}) {
  const { zoom } = props;
  const [percent, setPercent] = useState<number | null>(null);
  const dismissTimerRef = useRef<number | null>(null);
  const awaitingInitialSyncRef = useRef(true);

  useEffect(() => {
    awaitingInitialSyncRef.current = true;
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    if (zoom === null) return;
    const subscription = zoom.onChange((nextPercent) => {
      if (awaitingInitialSyncRef.current) {
        awaitingInitialSyncRef.current = false;
        return;
      }
      setPercent(nextPercent);
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
      }
      dismissTimerRef.current = window.setTimeout(() => {
        setPercent(null);
        dismissTimerRef.current = null;
      }, INDICATOR_DISMISS_MS);
    });
    return () => {
      subscription.dispose();
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, [zoom]);

  if (zoom === null || percent === null) {
    return null;
  }

  return (
    <div
      className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 text-popover-foreground"
      role="status"
      aria-live="polite"
      data-testid="desktop-zoom-indicator"
    >
      <div
        className="flex h-10 min-w-20 items-center justify-center rounded-md border border-border bg-popover px-4 text-ui-sm font-semibold tabular-nums shadow-lg"
        data-testid="desktop-zoom-percent"
      >
        {formatZoomPercent(percent)}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-10 rounded-md border-border bg-popover px-4 text-popover-foreground shadow-lg hover:bg-accent hover:text-accent-foreground"
        onClick={() => {
          void zoom.reset().catch((err) => {
            appLogger.errorSummary("[zoom] indicator reset failed", {}, err);
          });
        }}
      >
        <RotateCcw aria-hidden="true" />
        Reset to 100%
      </Button>
    </div>
  );
}

function wheelDeltaToPixels(event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * LINE_DELTA_PX;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * PAGE_DELTA_PX;
  }
  return event.deltaY;
}

function readGestureScale(event: Event): number | null {
  const scale: unknown = Reflect.get(event, "scale");
  return typeof scale === "number" && Number.isFinite(scale) ? scale : null;
}

function formatZoomPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}
