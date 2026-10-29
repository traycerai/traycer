import { useCallback } from "react";
import type { BotTurnRef } from "@traycer/protocol/host/bot/conversation-schemas";
import type { ChatBotFailedRecovery } from "@/components/chat/chat-bot-presentation-context";
import { fallbackReasonLabelFor } from "@/components/chat/fallback/fallback-copy";
import { ManualRungActions } from "@/components/chat/fallback/fallback-manual-rungs";
import { useChatLastFailedAttempt } from "@/components/chat/fallback/use-last-failed-attempt";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";

/**
 * The agent chat's reason and actions for a post the bot did not answer
 * (Tracy Bots T86, decision 117), read off the session that answers the
 * surface's posts - the trunk beside the channel, a thread's session in its
 * panel - which this holds open while the surface shows. Offered for a post
 * whose turn (`turnOfRequest`) is the one that session names as its last
 * failed attempt, under any of the ids the turn ran under, in the reason's label the agent chat's error row uses and
 * with its Retry, Switch to… and Wait until; `null` for any other post, and
 * for a reason this client has no label for, where the row keeps the bot's
 * own line. `sessionChatId` `null` offers none.
 */
export function useBotFailedRecovery(args: {
  readonly botId: string;
  readonly hostId: string;
  readonly sessionChatId: string | null;
  readonly turnOfRequest: (requestId: string) => BotTurnRef | null;
}): (requestId: string) => ChatBotFailedRecovery | null {
  const { botId, hostId, sessionChatId, turnOfRequest } = args;
  const chatId = sessionChatId ?? "";
  useChatSessionHandleForContainer(
    botId,
    chatId,
    hostId,
    sessionChatId !== null,
  );
  const attempt = useChatLastFailedAttempt({ epicId: botId, chatId, hostId });
  return useCallback(
    (requestId: string): ChatBotFailedRecovery | null => {
      if (sessionChatId === null || attempt === undefined) return null;
      const turn = turnOfRequest(requestId);
      if (
        turn === null ||
        turn.chatId !== sessionChatId ||
        !turn.turnIds.includes(attempt.turnId)
      ) {
        return null;
      }
      const label = fallbackReasonLabelFor(attempt.failure.reason);
      if (label === null) return null;
      return {
        label,
        actions: (
          <ManualRungActions
            turnId={attempt.turnId}
            epicId={botId}
            chatId={sessionChatId}
            hostId={hostId}
          />
        ),
      };
    },
    [attempt, botId, hostId, sessionChatId, turnOfRequest],
  );
}
