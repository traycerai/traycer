import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ChatBotTurnReceipt } from "@/components/chat/chat-bot-presentation-context";
import type { BotSessionActivity } from "@/hooks/bots/use-bot-activity";
import { useBotTurnLocateQuery } from "@/hooks/bots/use-bot-turn-locate-query";
import type { HostRpcRegistry } from "@/lib/host";
import { botTurnIndexOf } from "@/lib/bots/bot-turn-receipt";
import type { BotTurnOpen } from "@/stores/bots/bot-open-thread-store";

/**
 * The turn a replying session is running for the post it answers, as that
 * post's receipt opens it: the turn the host recorded taking the activity's
 * `requestId` (`bot.turn.locate`), opened on the message that started it.
 * `null` while the session is not replying or answers no post, and while the
 * host names no turn for it (a host without the method names none).
 */
export function useBotReplyingTurn(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly botId: string;
  readonly activity: BotSessionActivity | null;
  readonly onOpenTurn: BotTurnOpen;
}): ChatBotTurnReceipt | null {
  const { client, hostId, botId, activity, onOpenTurn } = args;
  const requestId = activity?.state === "replying" ? activity.requestId : null;
  const requestIds = useMemo(
    () => (requestId === null ? NO_IDS : [requestId]),
    [requestId],
  );
  const located = useBotTurnLocateQuery({
    client,
    hostId,
    botId,
    messageIds: NO_IDS,
    requestIds,
    turns: NO_TURN_KEYS,
  });
  // The previous request's answer stands in while the next one is read, and
  // names no turn for this one.
  const ref = useMemo(
    () =>
      requestId === null
        ? null
        : (botTurnIndexOf(located.data?.turns).byRequestId.get(requestId) ??
          null),
    [located.data, requestId],
  );
  return useMemo(
    () =>
      ref === null
        ? null
        : {
            summary: ref.summary,
            startedAt: ref.startedAt,
            endedAt: ref.endedAt,
            open: () => onOpenTurn(ref, null),
          },
    [onOpenTurn, ref],
  );
}

const NO_IDS: ReadonlyArray<string> = [];
const NO_TURN_KEYS: ReadonlyArray<{
  readonly chatId: string;
  readonly turnId: string;
}> = [];
