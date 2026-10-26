import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { animate, motionValue, type MotionValue } from "motion/react";
import { useDesktopTrackpadScrollPhaseBridge } from "@/hooks/runner/use-desktop-trackpad-scroll-phase-bridge";
import {
  DESKTOP_HISTORY_GESTURE,
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

export type DesktopHistoryGestureAppearance = Pick<
  DesktopHistoryGestureView,
  "direction" | "phase"
>;

/** One gesture's indicator, alive from its first pull until its exit has played. */
interface GestureIndicator extends DesktopHistoryGestureAppearance {
  readonly id: number;
  readonly progress: MotionValue<number>;
}

function cancellationMotionAllowed(): boolean {
  return (
    !document.documentElement.hasAttribute("data-reduce-panel-motion") &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Feedback only: no snapshots, content movement, focus changes or hit targets.
 * Installed only where the shell reports the trackpad stream (macOS desktop);
 * elsewhere there is no lift to confirm on, so there is no gesture.
 */
export function DesktopHistorySwipes(): ReactNode {
  const router = useRouter();
  const trackpad = useDesktopTrackpadScrollPhaseBridge();
  const [indicators, setIndicators] = useState<readonly GestureIndicator[]>(
    [],
  );
  useEffect(() => {
    if (trackpad === null) return;
    if (!historyNavChromeAvailable(router.history)) return;
    const controller = getHistoryController(router.history);
    if (controller === null) return;
    let nextId = 0;
    let live: GestureIndicator | null = null;
    let stopRetraction: (() => void) | null = null;
    const remove = (id: number): void =>
      setIndicators((current) => current.filter((item) => item.id !== id));
    const replace = (item: GestureIndicator): void =>
      setIndicators((current) =>
        current.some((existing) => existing.id === item.id)
          ? current.map((existing) =>
              existing.id === item.id ? item : existing,
            )
          : [...current, item],
      );
    const uninstall = installDesktopHistoryGesture({
      trackpad,
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
        if (live === null) {
          live = {
            id: nextId++,
            direction: next.direction,
            phase: next.phase,
            progress: motionValue(0),
          };
        } else if (
          live.direction !== next.direction ||
          live.phase !== next.phase
        ) {
          live = { ...live, direction: next.direction, phase: next.phase };
        }
        stopRetraction?.();
        stopRetraction = null;
        if (next.phase === "canceling" && cancellationMotionAllowed()) {
          const retraction = animate(live.progress, 0, {
            duration: 0.18,
            ease: [0.2, 0.8, 0.25, 1],
          });
          stopRetraction = () => retraction.stop();
        } else {
          live.progress.set(next.phase === "canceling" ? 0 : next.progress);
        }
        replace(live);
        // A commit or cancel is final for this gesture. Its exit runs on its
        // own clock so that fingers landing again before it has finished
        // start a fresh indicator instead of cutting this one short.
        if (next.phase === "committed" || next.phase === "canceling") {
          const { id } = live;
          live = null;
          window.setTimeout(() => remove(id), DESKTOP_HISTORY_GESTURE.settleMs);
        }
      },
    });
    return () => {
      uninstall();
      stopRetraction?.();
      setIndicators([]);
    };
  }, [router, trackpad]);
  return indicators.map((indicator) => (
    <DesktopHistoryGestureIndicator
      key={indicator.id}
      view={indicator}
      progress={indicator.progress}
    />
  ));
}
