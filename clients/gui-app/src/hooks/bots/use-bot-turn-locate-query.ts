import { useEffect, useMemo, useRef } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  BotTurnKey,
  BotTurnLocateResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { keepPreviousDataForSameHost } from "@/hooks/host/keep-previous-data-same-host";
import {
  useBotActivity,
  type BotActivity,
} from "@/hooks/bots/use-bot-activity";

/**
 * The turns behind what a bot's view shows (`bot.turn.locate`, Tracy Bots
 * T86): the replies it draws (`messageIds`), the posts it draws as not
 * answered (`requestIds`) and the turns it already names (`turns`, a
 * check-in's). Read again when those change, and when the bot's activity
 * says one of its sessions started or settled a turn, since a running
 * turn's end and summary are known only once it settles. Disabled on a host
 * without the method, which shows no receipt, and while there is nothing to
 * ask.
 */
export function useBotTurnLocateQuery(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly botId: string;
  readonly messageIds: ReadonlyArray<string>;
  readonly requestIds: ReadonlyArray<string>;
  readonly turns: ReadonlyArray<BotTurnKey>;
}): UseQueryResult<BotTurnLocateResponse, HostRpcError> {
  const { client, hostId, botId } = args;
  const supported = useHostMethodSupport(hostId, "bot.turn.locate") === true;
  // Keyed by what is asked, in a stable order, so a re-render with the same
  // rows asks nothing new.
  const messageKey = sortedJoin(args.messageIds);
  const requestKey = sortedJoin(args.requestIds);
  const turnKey = sortedJoin(
    args.turns.map((turn) => `${turn.chatId}\n${turn.turnId}`),
  );
  const params = useMemo(
    () => ({
      botId,
      messageIds: splitKey(messageKey),
      requestIds: splitKey(requestKey),
      turns: splitKey(turnKey).map((entry) => {
        const [chatId, turnId] = entry.split("\n");
        return { chatId, turnId };
      }),
    }),
    [botId, messageKey, requestKey, turnKey],
  );
  const asking =
    params.messageIds.length > 0 ||
    params.requestIds.length > 0 ||
    params.turns.length > 0;
  const query = useHostQuery<HostRpcRegistry, "bot.turn.locate">({
    cacheKeyIdentity: undefined,
    client,
    method: "bot.turn.locate",
    params,
    options: {
      enabled: supported && asking,
      refetchOnWindowFocus: false,
      retry: false,
      placeholderData: keepPreviousDataForSameHost(hostId),
    },
  });
  const turnsMoved = turnBoundariesOf(useBotActivity(botId));
  const { refetch } = query;
  const seenRef = useRef(turnsMoved);
  useEffect(() => {
    if (seenRef.current === turnsMoved) return;
    seenRef.current = turnsMoved;
    if (supported && asking) void refetch();
  }, [asking, refetch, supported, turnsMoved]);
  return query;
}

function sortedJoin(values: ReadonlyArray<string>): string {
  return [...new Set(values)].sort().join("\u0000");
}

function splitKey(key: string): string[] {
  return key.length === 0 ? [] : key.split("\u0000");
}

/**
 * Where each of the bot's sessions stands between turns: its state, when its
 * turn started and the post it answers. It moves when a turn starts, settles
 * or fails, and not on each step a running turn takes.
 */
function turnBoundariesOf(activity: BotActivity | null): string {
  if (activity === null) return "";
  const sessions = [
    ["trunk", activity.trunk] as const,
    ...Object.entries(activity.threads),
  ];
  return sessions
    .map(([key, session]) =>
      session === null
        ? `${key}:-`
        : `${key}:${session.state}:${session.startedAt ?? "-"}:${session.requestId ?? "-"}`,
    )
    .sort()
    .join("|");
}
