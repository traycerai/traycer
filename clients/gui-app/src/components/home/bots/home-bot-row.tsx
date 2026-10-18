import { useMemo, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Bot } from "lucide-react";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { Badge } from "@/components/ui/badge";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useBotSubscription } from "@/hooks/bots/use-bot-subscription";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useEpicAgentActivity } from "@/stores/agent-activity-store";
import { buildHomeBotRow } from "@/lib/home-bots/bots-model";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { formatWaitTime, useSampledNow } from "@/lib/relative-time";

/**
 * One bot on Home. The row subscribes to its own `bot.subscribe` through the
 * app-wide host and renders whatever the snapshot says as it arrives: the
 * title, the tracked tasks, the next check-in, and the open-request HINT. The
 * hint is shown only when it is above zero, because the conversation's rows,
 * not this number, decide what is open.
 *
 * Opening binds the tab to the host the bot RUNS on: that host alone serves
 * the bot's chats. The row says which host that is, and whether it can be
 * dialed right now, before the click.
 */
export function HomeBotRow(props: {
  readonly bot: BotRecord;
  readonly hostLabels: ReadonlyMap<string, string>;
  readonly connectableHostIds: ReadonlySet<string>;
}): ReactNode {
  const { bot, hostLabels, connectableHostIds } = props;
  const hostId = useEffectiveHostId();
  const subscription = useBotSubscription({
    hostId,
    botId: bot.botId,
    enabled: hostId !== null,
  });
  const row = useMemo(
    () => buildHomeBotRow(bot, subscription.snapshot),
    [bot, subscription.snapshot],
  );
  const now = useSampledNow();
  const working = useEpicAgentActivity(bot.botId).working.size > 0;
  const navigate = useNavigate();
  const openBotTab = useBotTabsStore((s) => s.openBotTab);

  const hostLabel =
    row.boundHostId === null
      ? "No host"
      : (hostLabels.get(row.boundHostId) ?? row.boundHostId);
  // A bot no host runs reads as an offline one: the same state, the same way
  // out (move it here).
  const hostOffline =
    row.boundHostId === null || !connectableHostIds.has(row.boundHostId);
  // The tab binds to the host the bot RUNS on when that host can be dialled.
  // When it cannot, the tab opens through the host this window reads
  // (offline state): the conversation list and a queued send go through it,
  // and the person may move the bot here. Never a clone.
  const openHostId = hostOffline && hostId !== null ? hostId : row.boundHostId;
  const openRequests = row.openRequestCount ?? 0;

  return (
    <button
      type="button"
      data-testid="home-bot-row"
      data-bot-id={row.botId}
      className="group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-foreground/6 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
      onClick={() => {
        if (openHostId === null) return;
        openBotTab({ botId: row.botId, hostId: openHostId, title: row.title });
        navigateToTabIntent(navigate, botTabIntent(row.botId), undefined);
      }}
    >
      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground/6 text-muted-foreground">
        <Bot className="size-4" aria-hidden="true" />
        {working ? (
          <span
            className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-success ring-2 ring-card"
            aria-label="Working"
            data-testid="home-bot-working"
          />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-ui-sm text-foreground">{row.title}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-xs text-muted-foreground">
          <span className="truncate" data-testid="home-bot-host">
            {hostLabel}
            {hostOffline ? " · offline" : null}
          </span>
          {row.tasksTracking === null ? null : (
            <span data-testid="home-bot-tasks">
              {row.tasksTracking === 1
                ? "1 task"
                : `${row.tasksTracking} tasks`}
            </span>
          )}
          {row.nextCheckinAt === null ? null : (
            <span data-testid="home-bot-next-checkin">
              next check-in {formatWaitTime(row.nextCheckinAt, now)}
            </span>
          )}
        </span>
      </span>
      {openRequests > 0 ? (
        <Badge variant="warning" size="xs" data-testid="home-bot-open-requests">
          {openRequests === 1 ? "1 open" : `${openRequests} open`}
        </Badge>
      ) : null}
    </button>
  );
}
