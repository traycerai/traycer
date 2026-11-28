import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ChatBotPendingSend } from "@/components/chat/chat-bot-presentation-context";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import {
  BOT_CONVERSATION_NONCE_VERSION,
  botSendTakes,
} from "@/hooks/bots/use-bot-send-version";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import type { BotSendBinding } from "@/lib/bots/bot-pending-send";
import {
  botSendAttemptOutcome,
  botSendAuthorityMoved,
} from "@/lib/bots/bot-send-attempt-outcome";
import type { HostRpcRegistry } from "@/lib/host";
import { settleSentThread } from "@/stores/bots/bot-open-thread-store";
import {
  attemptPendingSend,
  settleMovedRetry,
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
 * been written. It is offered again only where `retryEpoch` says
 * (`binding`; `null` where none is offered again): elsewhere it stays
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
  const takesNonce = botSendTakes(
    useHostMethodSchemaVersion(
      binding?.hostId ?? null,
      "bot.conversation.send",
    ),
    BOT_CONVERSATION_NONCE_VERSION,
  );
  return useMemo(() => {
    if (held.length === 0) return null;
    const retry = (messageId: string, observedEpoch: number): void => {
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
          const outcome = botSendAttemptOutcome(error);
          if (!botSendAuthorityMoved(error)) {
            settlePendingSend(messageId, outcome);
            return;
          }
          settleMovedRetry(messageId, outcome, observedEpoch);
          binding?.onMoved();
        },
      );
    };
    const byId = new Map(
      held.map((send): [string, ChatBotPendingSend] => {
        const observedEpoch = retryEpoch(send, binding, takesNonce);
        return [
          send.row.messageId,
          {
            state: send.state === "uncertain" ? "unconfirmed" : "sending",
            retry:
              send.state !== "uncertain" ||
              send.inFlight ||
              observedEpoch === null
                ? null
                : () => retry(send.row.messageId, observedEpoch),
          },
        ];
      }),
    );
    return (messageId) => byId.get(messageId) ?? null;
  }, [binding, botId, held, sendAgain, takesNonce]);
}

/**
 * The bound epoch, read now, that `send` is offered again under; `null` when
 * it is not offered. It goes again unchanged through the tab's host, only
 * while that host is the bot's bound host and the one its authority names,
 * at the epoch it was made for or a newer one: after a re-claim the same
 * host answers it from its row when it holds one, and refuses it, writing
 * nothing, when not. A send made for the binding read now would be another
 * request. Once a Retry made under an epoch was refused because the binding
 * moved, that epoch and every older one offer it no more, and a newer one
 * does. None is offered while that host does not take a send's nonce
 * (`takesNonce`, false while its line is unknown): it would be refused
 * before it left.
 */
function retryEpoch(
  send: BotPendingSend,
  binding: BotSendBinding | null,
  takesNonce: boolean,
): number | null {
  const { authority } = send.request;
  if (!takesNonce || binding === null || authority === undefined) return null;
  const observed = binding.boundHostEpoch;
  const throughItsHost =
    binding.boundHostId === binding.hostId &&
    authority.hostId === binding.hostId;
  const notRefusedHere =
    send.movedAtEpoch === null || observed > send.movedAtEpoch;
  return throughItsHost && observed >= authority.hostEpoch && notRefusedHere
    ? observed
    : null;
}
