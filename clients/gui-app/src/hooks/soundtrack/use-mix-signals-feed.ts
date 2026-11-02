import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useBotActivity } from "@/hooks/bots/use-bot-activity";
import { MIX_TUNING } from "@/lib/soundtrack/mix-tuning";
import {
  agentTurnsInFlight,
  botTurnsInFlight,
  feedSignalsOfRows,
  nextDoneExpiry,
  soundtrackViewOfLocation,
  type MixSignals,
} from "@/lib/soundtrack/signals";
import { parseSystemTabOverlayView } from "@/lib/system-tab-overlay-search";
import { useAgentActivityStore } from "@/stores/agent-activity-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useMergedNotificationRows } from "@/stores/notifications/merged-notifications";

/**
 * Publishes what the app is doing as `MixSignals`, whenever any of it changes:
 * the route's kind, the feed, and the agents with a turn in flight. A `done`
 * row ageing out is a change too, with nothing having been written anywhere, so
 * the next one to go schedules a read of its own. Identifiers are read here to
 * find the activity, and none of them reaches a signal.
 *
 * The bot's turns are read for the Tracy surface's channel alone, the one bot
 * this window already holds a subscription for.
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
  const agentTurns = useAgentActivityStore((state) =>
    agentTurnsInFlight(state.byHost),
  );
  const botId = useTracySurfaceStore((state) =>
    state.open ? state.botId : null,
  );
  const botTurns = botTurnsInFlight(useBotActivity(botId));
  const working = Math.min(
    agentTurns + botTurns,
    MIX_TUNING.intensity.working.cap,
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
