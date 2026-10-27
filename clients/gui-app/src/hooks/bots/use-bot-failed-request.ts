import { useCallback } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { BotComposerEdit } from "@/components/bots/bot-message-composer";
import type { ChatBotFailedRequest } from "@/components/chat/chat-bot-presentation-context";
import {
  BOT_CONVERSATION_RETRY_VERSION,
  useBotConversationSendMutation,
} from "@/hooks/bots/use-bot-mutations";
import type { BotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Retry and Edit for the messages of one channel or thread the bot failed to
 * answer (`failedOn`). Retry sends the message to the bot again as it is: the
 * same request, re-delivered to the session it went to, with no new row.
 * Edit, on the viewer's own message, hands its text to the box (`onEdit`),
 * whose send replaces it. A retry the host refuses says so where a failed
 * send does (`failure`). Neither is offered by a host that cannot do them
 * (`bot.conversation.send` below 1.1).
 */
export function useBotFailedRequest(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly botId: string;
  /** The channel; `null` before it is known, when nothing is offered. */
  readonly conversationId: string | null;
  /** The thread the messages were sent in; `null` for the channel's posts. */
  readonly threadId: string | null;
  /** Whether a session failed or parked answering the request and still holds it. */
  readonly failedOn: (requestId: string) => boolean;
  readonly onEdit: (edit: BotComposerEdit) => void;
  readonly failure: BotSendFailure;
}): (
  requestId: string,
  senderUserId: string | null,
) => ChatBotFailedRequest | null {
  const { client, hostId, botId, conversationId, threadId, failedOn, onEdit } =
    args;
  const { fail, clear } = args.failure;
  const sendVersion = useHostMethodSchemaVersion(
    hostId,
    "bot.conversation.send",
  );
  const supported =
    sendVersion !== null &&
    sendVersion.major === BOT_CONVERSATION_RETRY_VERSION.major &&
    sendVersion.minor >= BOT_CONVERSATION_RETRY_VERSION.minor;
  const viewerUserId = useAuthStore((s) => s.profile?.userId ?? null);
  const { mutate, isPending, variables } =
    useBotConversationSendMutation(client);
  const retryingId = isPending
    ? (variables.redeliver?.requestId ?? null)
    : null;
  return useCallback(
    (
      requestId: string,
      senderUserId: string | null,
    ): ChatBotFailedRequest | null => {
      if (!supported || conversationId === null || !failedOn(requestId)) {
        return null;
      }
      return {
        retry: (text) => {
          clear();
          mutate(
            {
              botId,
              conversationId,
              text,
              threadId,
              announcementId: null,
              redeliver: { requestId },
              supersedes: null,
            },
            { onError: fail },
          );
        },
        retrying: retryingId === requestId,
        edit:
          senderUserId !== null && senderUserId === viewerUserId
            ? (text) => onEdit({ requestId, text })
            : null,
      };
    },
    [
      botId,
      clear,
      conversationId,
      fail,
      failedOn,
      mutate,
      onEdit,
      retryingId,
      supported,
      threadId,
      viewerUserId,
    ],
  );
}
