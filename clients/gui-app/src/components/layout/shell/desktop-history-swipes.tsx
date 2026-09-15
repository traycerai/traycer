import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { useMotionValue } from "motion/react";
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
    return installDesktopHistoryGesture({
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
        progress.set(next?.progress ?? 0);
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
  }, [router, progress]);
  if (view === null) return null;
  return <DesktopHistoryGestureIndicator view={view} progress={progress} />;
}

export type DesktopHistoryGestureAppearance = Pick<
  DesktopHistoryGestureView,
  "direction" | "phase"
>;
