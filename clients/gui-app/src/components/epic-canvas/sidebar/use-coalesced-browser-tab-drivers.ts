import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { BrowserTabDriver } from "@traycer/protocol/host/browser/contracts";
import {
  browserTabDriverChatSignature,
  cancelCoalesceTimer,
  restartCoalesceTimer,
  type CoalesceTimer,
} from "@/components/epic-canvas/sidebar/browser-driver-coalescing";
import { BROWSER_TAB_AGENT_ACTIVITY_MS } from "@/lib/browser-view/browser-tab-display";

const NO_VISIBLE_DRIVERS: readonly BrowserTabDriver[] = [];

/**
 * Delays the driven-by glyph in both directions (see
 * `browser-driver-coalescing.ts`), except when the drivers change WITHIN the
 * chat set already on screen - that is the same agent still working, so it
 * shows through immediately.
 *
 * The immediate half runs during render (React's documented "storing
 * information from previous renders" pattern, so no cascading setState in an
 * effect); the effect owns only the pending timer. `useEffectEvent` is what
 * keeps `drivenBy`/`visible` out of the dependency array without mirroring
 * either into a ref: the effect re-runs on the driver signatures alone and
 * still reads the committed values.
 */
export function useCoalescedBrowserTabDrivers(
  drivenBy: readonly BrowserTabDriver[],
): readonly BrowserTabDriver[] {
  const [visible, setVisible] =
    useState<readonly BrowserTabDriver[]>(NO_VISIBLE_DRIVERS);
  const timerRef = useRef<CoalesceTimer | null>(null);
  const chatSignature = browserTabDriverChatSignature(drivenBy);
  const driverSignature = drivenBy
    .map((driver) => `${driver.chatId}\0${driver.requestId}`)
    .join("\x01");
  const [settledSignature, setSettledSignature] = useState(driverSignature);

  if (settledSignature !== driverSignature) {
    setSettledSignature(driverSignature);
    if (visible.length > 0 && drivenBy.length > 0) {
      const visibleChats = new Set(visible.map((driver) => driver.chatId));
      setVisible(
        drivenBy.every((driver) => visibleChats.has(driver.chatId))
          ? drivenBy
          : NO_VISIBLE_DRIVERS,
      );
    }
  }

  const scheduleVisibleDrivers = useEffectEvent(() => {
    if (drivenBy.length === 0) {
      timerRef.current =
        visible.length === 0
          ? cancelCoalesceTimer(timerRef.current)
          : restartCoalesceTimer(
              timerRef.current,
              chatSignature,
              BROWSER_TAB_AGENT_ACTIVITY_MS,
              () => {
                timerRef.current = null;
                setVisible(NO_VISIBLE_DRIVERS);
              },
            );
      return;
    }
    if (visible.length > 0) {
      timerRef.current = cancelCoalesceTimer(timerRef.current);
      return;
    }
    timerRef.current = restartCoalesceTimer(
      timerRef.current,
      chatSignature,
      BROWSER_TAB_AGENT_ACTIVITY_MS,
      () => {
        timerRef.current = null;
        setVisible(drivenBy);
      },
    );
  });

  useEffect(() => {
    scheduleVisibleDrivers();
  }, [chatSignature, driverSignature]);

  useEffect(
    () => () => {
      timerRef.current = cancelCoalesceTimer(timerRef.current);
    },
    [],
  );

  return visible;
}
