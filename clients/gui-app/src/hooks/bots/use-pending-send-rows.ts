import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { BotConversationSendRequest } from "@traycer/protocol/host/bot/conversation-schemas";
import type { ChatBotPendingSend } from "@/components/chat/chat-bot-presentation-context";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import type { BotSendBinding } from "@/lib/bots/bot-pending-send";
import {
  botSendAttemptOutcome,
  botSendAuthorityMoved,
} from "@/lib/bots/bot-send-attempt-outcome";
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
 * was, nonce included, as the account and in the bot lifetime it was first
 * sent in, through the tab's host, and its answer settles the
 * thread a post opened at Send as the first attempt's would have. Every
 * failure of it leaves it unconfirmed, since an earlier attempt may have
 * been written. It is offered again only under the binding it was made for
 * (`binding`; `null` where none is offered again): under any other it stays
 * unconfirmed, its text kept, with nothing to press. A host that refuses it
 * because the binding moved has the bot read again.
 */
export function usePendingSendRows(
  botId: string,
  held: ReadonlyArray<BotPendingSend>,
  client: HostClient<HostRpcRegistry> | null,
  binding: BotSendBinding | null,
): ((messageId: string) => ChatBotPendingSend | null) | null {
  const { mutateAsync: sendAgain } = useBotConversationSendMutation(client);
  return useMemo(() => {
    if (held.length === 0) return null;
    const retry = (messageId: string): void => {
      const attempt = attemptPendingSend(messageId);
      if (attempt === null) return;
      sendAgain(attempt).then(
        (response) => {
          settlePendingSend(messageId, "accepted");
          settleSentThread(
            botId,
            response.requestId,
            {
              kind: "answered",
              threadId: response.threadId,
              delivery: response.delivery,
            },
            attempt.sentAs.lifetime,
          );
        },
        (error: unknown) => {
          settlePendingSend(messageId, botSendAttemptOutcome(error));
          if (botSendAuthorityMoved(error)) binding?.onMoved();
        },
      );
    };
    const byId = new Map(
      held.map((send): [string, ChatBotPendingSend] => [
        send.row.messageId,
        {
          state: send.state === "uncertain" ? "unconfirmed" : "sending",
          retry:
            send.state !== "uncertain" ||
            send.inFlight ||
            !retriesUnder(send.request, binding)
              ? null
              : () => retry(send.row.messageId),
        },
      ]),
    );
    return (messageId) => byId.get(messageId) ?? null;
  }, [binding, botId, held, sendAgain]);
}

/**
 * Whether `request` goes again through the tab's host as it was sent: only
 * while that host is the bot's bound host at the binding the request was
 * made for. The host refuses it under any other, and a send made for the
 * binding read now is another request.
 */
function retriesUnder(
  request: BotConversationSendRequest,
  binding: BotSendBinding | null,
): boolean {
  const { authority } = request;
  return (
    binding !== null &&
    authority !== undefined &&
    binding.boundHostId === binding.hostId &&
    authority.hostId === binding.hostId &&
    authority.hostEpoch === binding.boundHostEpoch
  );
}
