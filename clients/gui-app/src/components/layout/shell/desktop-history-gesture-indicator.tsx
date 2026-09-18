import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { motion, useTransform, type MotionValue } from "motion/react";
import type { DesktopHistoryGestureAppearance } from "./desktop-history-swipes";
import { cn } from "@/lib/utils";
import "./desktop-history-swipes.css";

interface DesktopHistoryGestureIndicatorProps {
  readonly view: DesktopHistoryGestureAppearance;
  readonly progress: MotionValue<number>;
}

export function DesktopHistoryGestureIndicator({
  view,
  progress,
}: DesktopHistoryGestureIndicatorProps): ReactNode {
  const back = view.direction === "back";
  const ready = view.phase === "ready" || view.phase === "committed";
  const transform = useTransform(progress, (value) => {
    const reveal = 44 * Math.pow(Math.max(0, Math.min(1, value)), 0.45);
    return `translateX(${(72 - reveal) * (back ? -1 : 1)}px) translateY(-50%)`;
  });
  const opacity = useTransform(progress, (value) => 0.65 + value * 0.35);
  const Arrow = back ? ArrowLeft : ArrowRight;
  return createPortal(
    <div
      aria-hidden="true"
      className="desktop-history-overlay pointer-events-none fixed inset-0 z-[80] overflow-clip"
      data-testid="desktop-history-gesture"
      data-direction={view.direction}
      data-phase={view.phase}
    >
      <motion.div
        className={cn(
          "desktop-history-cap absolute top-safe-center-y rounded-full border shadow-lg",
          back ? "left-0" : "right-0",
          ready
            ? "border-primary text-primary-foreground"
            : "border-foreground/20 text-popover-foreground",
        )}
        style={{ transform }}
      >
        <motion.div
          className="absolute inset-0 rounded-full bg-popover"
          style={{ opacity }}
        />
        <div
          className="desktop-history-tint absolute inset-0 rounded-full bg-primary"
          style={{ opacity: ready ? 1 : 0 }}
        />
        <Arrow
          className={cn(
            "desktop-history-arrow absolute top-1/2 size-5 -translate-y-1/2",
            back ? "right-3" : "left-3",
          )}
          strokeWidth={2.25}
          style={{ scale: ready ? 1.12 : 1 }}
        />
      </motion.div>
    </div>,
    document.body,
  );
}
