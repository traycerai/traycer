import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ChatBotPendingSend } from "@/components/chat/chat-bot-presentation-context";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import { botSendAttemptOutcome } from "@/lib/bots/bot-send-attempt-outcome";
import type { HostRpcRegistry } from "@/lib/host";
import { settleSentThread } from "@/stores/bots/bot-open-thread-store";
import {
  attemptPendingSend,
  settlePendingSend,
  type BotPendingSend,
} from "@/stores/bots/bot-pending-sends-store";

/**
 * What each of the member's own sends drawn in a chat before its stored
 * row says and offers (T249): an unconfirmed one sends again exactly as it
 * was, nonce included, through the tab's host, and its answer settles the
 * thread a post opened at Send as the first attempt's would have. Every
 * failure of it leaves it unconfirmed, since an earlier attempt may have
 * been written.
 */
export function usePendingSendRows(
  botId: string,
  held: ReadonlyArray<BotPendingSend>,
  client: HostClient<HostRpcRegistry> | null,
): ((messageId: string) => ChatBotPendingSend | null) | null {
  const { mutateAsync: sendAgain } = useBotConversationSendMutation(client);
  return useMemo(() => {
    if (held.length === 0) return null;
    const retry = (messageId: string): void => {
      const request = attemptPendingSend(messageId);
      if (request === null) return;
      sendAgain(request).then(
        (response) => {
          settlePendingSend(messageId, "accepted");
          settleSentThread(botId, response.requestId, {
            kind: "answered",
            threadId: response.threadId,
            delivery: response.delivery,
          });
        },
        (error: unknown) => {
          settlePendingSend(messageId, botSendAttemptOutcome(error));
        },
      );
    };
    const byId = new Map(
      held.map((send): [string, ChatBotPendingSend] => [
        send.row.messageId,
        {
          state: send.state === "uncertain" ? "unconfirmed" : "sending",
          retry:
            send.state !== "uncertain" || send.inFlight
              ? null
              : () => retry(send.row.messageId),
        },
      ]),
    );
    return (messageId) => byId.get(messageId) ?? null;
  }, [botId, held, sendAgain]);
}
