import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { animate, useMotionValue } from "motion/react";
import {
  installDesktopHistoryGesture,
  type DesktopHistoryGestureView,
} from "@/components/layout/shell/desktop-history-gesture";
import {
  goBack,
  goForward,
  resolveEligibleHistoryTarget,
} from "@/lib/commands/actions/history-navigation";
import { historyNavChromeAvailable } from "@/lib/history-navigation/use-history-nav-available";
import { getHistoryController } from "@/lib/persistent-history";
import { DesktopHistoryGestureIndicator } from "./desktop-history-gesture-indicator";

function cancellationMotionAllowed(): boolean {
  return (
    !document.documentElement.hasAttribute("data-reduce-panel-motion") &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Feedback only: no snapshots, content movement, focus changes or hit targets. */
export function DesktopHistorySwipes(): ReactNode {
  const router = useRouter();
  const progress = useMotionValue(0);
  const [view, setView] = useState<DesktopHistoryGestureAppearance | null>(
    null,
  );
  useEffect(() => {
    if (!historyNavChromeAvailable(router.history)) return;
    const controller = getHistoryController(router.history);
    if (controller === null) return;
    let appearance: DesktopHistoryGestureAppearance | null = null;
    let stopRetraction: (() => void) | null = null;
    const uninstall = installDesktopHistoryGesture({
      currentEntry: () =>
        JSON.stringify([
          router.history.location.state.__TSR_key,
          router.history.location.href,
        ]),
      destination: (direction) => {
        const target = resolveEligibleHistoryTarget(
          router,
          direction === "back" ? -1 : 1,
        );
        if (target === null) return null;
        return (
          target.key ??
          `${target.index}:${controller.getEntries()[target.index]}`
        );
      },
      navigate: (direction) => {
        if (direction === "back") goBack(router);
        else goForward(router);
      },
      render: (next) => {
        stopRetraction?.();
        stopRetraction = null;
        if (next?.phase === "canceling" && cancellationMotionAllowed()) {
          const retraction = animate(progress, 0, {
            duration: 0.18,
            ease: [0.2, 0.8, 0.25, 1],
          });
          stopRetraction = () => retraction.stop();
        } else {
          progress.set(next?.phase === "canceling" ? 0 : (next?.progress ?? 0));
        }
        if (
          appearance?.direction === next?.direction &&
          appearance?.phase === next?.phase
        )
          return;
        appearance =
          next === null
            ? null
            : { direction: next.direction, phase: next.phase };
        setView(appearance);
      },
    });
    return () => {
      uninstall();
      stopRetraction?.();
    };
  }, [router, progress]);
  if (view === null) return null;
  return <DesktopHistoryGestureIndicator view={view} progress={progress} />;
}

export type DesktopHistoryGestureAppearance = Pick<
  DesktopHistoryGestureView,
  "direction" | "phase"
>;
