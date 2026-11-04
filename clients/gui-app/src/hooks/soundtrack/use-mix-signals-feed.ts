import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { MIX_TUNING } from "@/lib/soundtrack/mix-tuning";
import {
  agentTurnsInFlight,
  feedSignalsOfRows,
  nextDoneExpiry,
  soundtrackViewOfLocation,
  type MixSignals,
} from "@/lib/soundtrack/signals";
import { parseSystemTabOverlayView } from "@/lib/system-tab-overlay-search";
import { useAgentActivityStore } from "@/stores/agent-activity-store";
import { useMergedNotificationRows } from "@/stores/notifications/merged-notifications";

/**
 * Publishes what the app is doing as `MixSignals`, whenever any of it changes:
 * the route's kind, the feed, and the agents with a turn in flight. A `done`
 * row ageing out is a change too, with nothing having been written anywhere, so
 * the next one to go schedules a read of its own.
 *
 * The activity plane is the one authority on turns. A bot's trunk and thread
 * chats are in it under the bot's epic, so adding what the bot's own stream
 * says would count them twice, and would move the mix when the person opens a
 * channel with no new work started.
 */
export function useMixSignalsFeed(
  publish: (signals: MixSignals) => void,
): void {
  const view = useRouterState({
    select: (state) =>
      soundtrackViewOfLocation(
        state.location.pathname,
        parseSystemTabOverlayView(state.location.search).settingsOverlay,
      ),
  });
  const rows = useMergedNotificationRows();
  const working = useAgentActivityStore((state) =>
    Math.min(
      agentTurnsInFlight(state.byHost),
      MIX_TUNING.intensity.working.cap,
    ),
  );

  useEffect(() => {
    let timer: number | null = null;
    const read = (): void => {
      const now = Date.now();
      publish({ view, working, ...feedSignalsOfRows(rows, now) });
      const expiry = nextDoneExpiry(rows, now);
      timer = expiry === null ? null : window.setTimeout(read, expiry - now);
    };
    read();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [publish, rows, view, working]);
}
