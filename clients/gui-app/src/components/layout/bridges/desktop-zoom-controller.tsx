import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useDesktopZoomBridge } from "@/hooks/runner/use-desktop-zoom-bridge";
import {
  useRunnerZoomResetMutation,
  useRunnerZoomStepInMutation,
  useRunnerZoomStepOutMutation,
} from "@/hooks/runner/use-runner-zoom";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { cn } from "@/lib/utils";
import { formatZoomPercent } from "@/lib/windows/format-zoom-percent";
import type { DesktopZoomBridge } from "@/lib/windows/types";

const INDICATOR_DISMISS_MS = 4_000;
const WHEEL_STEP_THRESHOLD_PX = 80;
const LINE_DELTA_PX = 16;
const PAGE_DELTA_PX = 800;
const PINCH_STEP_RATIO = 1.08;
const INDICATOR_TRANSITION = { duration: 0.16, ease: "easeOut" } as const;

export function DesktopZoomController() {
  const zoom = useDesktopZoomBridge();
  const { mutateAsync: stepIn } = useRunnerZoomStepInMutation(zoom);
  const { mutateAsync: stepOut } = useRunnerZoomStepOutMutation(zoom);
  const { isPending: resetPending, mutateAsync: reset } =
    useRunnerZoomResetMutation(zoom);
  const actions = useMemo<ZoomActions>(
    () => ({
      stepIn: () => stepIn(),
      stepOut: () => stepOut(),
      reset: () => reset(),
    }),
    [reset, stepIn, stepOut],
  );
  useZoomKeybindings(zoom, actions);
  useZoomGestures(zoom, actions);
  return (
    <DesktopZoomIndicator
      zoom={zoom}
      actions={actions}
      resetPending={resetPending}
    />
  );
}

interface ZoomActions {
  stepIn(): Promise<number>;
  stepOut(): Promise<number>;
  reset(): Promise<number>;
}

function useZoomKeybindings(
  zoom: DesktopZoomBridge | null,
  actions: ZoomActions,
): void {
  useEffect(() => {
    if (zoom === null) return;
    const unregisterIn = registerDynamicActionHandler("app.zoom.in", () => {
      void actions.stepIn().catch(() => undefined);
    });
    const unregisterOut = registerDynamicActionHandler("app.zoom.out", () => {
      void actions.stepOut().catch(() => undefined);
    });
    const unregisterReset = registerDynamicActionHandler(
      "app.zoom.reset",
      () => {
        void actions.reset().catch(() => undefined);
      },
    );
    return () => {
      unregisterIn();
      unregisterOut();
      unregisterReset();
    };
  }, [actions, zoom]);
}

function useZoomGestures(
  zoom: DesktopZoomBridge | null,
  actions: ZoomActions,
): void {
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
        .then(() => (direction > 0 ? actions.stepIn() : actions.stepOut()))
        .then(() => undefined)
        .catch(() => undefined);
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
  }, [actions, zoom]);
}

function DesktopZoomIndicator(props: {
  readonly zoom: DesktopZoomBridge | null;
  readonly actions: ZoomActions;
  readonly resetPending: boolean;
}) {
  const { actions, resetPending, zoom } = props;
  const [percent, setPercent] = useState<number | null>(null);
  const dismissTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    if (zoom === null) return;
    const subscription = zoom.onChange((nextPercent) => {
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

  return (
    <AnimatePresence initial={false}>
      {zoom !== null && percent !== null ? (
        <m.div
          key="desktop-zoom-indicator"
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={INDICATOR_TRANSITION}
          className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 text-popover-foreground"
          role="status"
          aria-live="polite"
          data-testid="desktop-zoom-indicator"
        >
          <div
            className="flex h-10 min-w-36 items-center rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
            data-testid="desktop-zoom-level-island"
          >
            <TooltipWrapper
              label="Zoom out"
              side="top"
              sideOffset={8}
              align="center"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Zoom out"
                className="size-8 rounded-sm text-muted-foreground hover:text-foreground"
                onClick={() => {
                  void actions.stepOut().catch(() => undefined);
                }}
              >
                <Minus aria-hidden="true" />
              </Button>
            </TooltipWrapper>
            <div
              className="flex min-w-16 flex-1 items-center justify-center px-2 text-ui-sm font-semibold tabular-nums"
              data-testid="desktop-zoom-percent"
            >
              {formatZoomPercent(percent)}
            </div>
            <TooltipWrapper
              label="Zoom in"
              side="top"
              sideOffset={8}
              align="center"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Zoom in"
                className="size-8 rounded-sm text-muted-foreground hover:text-foreground"
                onClick={() => {
                  void actions.stepIn().catch(() => undefined);
                }}
              >
                <Plus aria-hidden="true" />
              </Button>
            </TooltipWrapper>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "h-10 rounded-md border-border bg-popover px-4 text-popover-foreground shadow-lg hover:bg-accent hover:text-accent-foreground",
              "dark:border-border dark:bg-popover dark:hover:bg-accent",
            )}
            data-testid="desktop-zoom-reset-island"
            disabled={resetPending}
            onClick={() => {
              void actions.reset().catch(() => undefined);
            }}
          >
            <RotateCcw aria-hidden="true" />
            Reset to 100%
            {resetPending ? (
              <AgentSpinningDots
                className="ml-1 text-current"
                testId="desktop-zoom-reset-pending"
                variant="dots2"
              />
            ) : null}
          </Button>
        </m.div>
      ) : null}
    </AnimatePresence>
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
